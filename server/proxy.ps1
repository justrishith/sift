# Sift - local scoring proxy
# Holds the Gemini key so it never ships inside the extension.
# Windows PowerShell 5.1, no dependencies.
#
#   powershell -ExecutionPolicy Bypass -File server\proxy.ps1
#
# Endpoints:
#   GET  /health       -> {ok:true}
#   POST /score-page   -> {slop, category, confidence, reasons, blur}

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------- env ----------
$envPath = Join-Path $PSScriptRoot "..\.env"
if (Test-Path $envPath) {
  Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $k, $v = $line.Split("=", 2)
      if ($k.Trim() -and $v.Trim()) {
        [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), "Process")
      }
    }
  }
}

$ApiKey = $env:GEMINI_API_KEY
$Model = if ($env:GEMINI_MODEL) { $env:GEMINI_MODEL } else { "gemini-2.5-flash" }
$Port = if ($env:PROXY_PORT) { [int]$env:PROXY_PORT } else { 8787 }

if (-not $ApiKey) {
  Write-Host "GEMINI_API_KEY missing. Add it to .env" -ForegroundColor Red
  exit 1
}

$Schema = @{
  type = "object"
  properties = @{
    slop       = @{ type = "number"; description = "0 to 1, likelihood this is AI-generated slop or fabricated content" }
    category   = @{ type = "string"; enum = @("synthetic", "content_farm", "editorial") }
    confidence = @{ type = "string"; enum = @("low", "medium", "high") }
    reasons    = @{ type = "array"; items = @{ type = "string" } }
  }
  required = @("slop", "category", "confidence", "reasons")
}

$Prompt = @'
You classify news article text for a tool that protects older readers from AI-generated slop.

Decide whether this reads like:
- "synthetic": fabricated article or AI-generated content posing as reporting
- "content_farm": mass-produced, low-quality, machine-written content
- "editorial": genuine journalism, even if opinionated or low quality

Be conservative. Only use "synthetic" or "content_farm" with strong evidence.
Never label a real news article as synthetic without clear signs.
Give short, concrete reasons a non-technical person could understand.

Return JSON only.
'@

$cache = @{}

# ---------- gemini ----------
function Invoke-Gemini([string]$title, [string]$text) {
  $key = [Convert]::ToBase64String(
    [Security.Cryptography.SHA256]::Create().ComputeHash(
      [Text.Encoding]::UTF8.GetBytes($text)
    )
  )
  if ($cache.ContainsKey($key)) { return $cache[$key] }

  $body = @{
    contents = @(
      @{
        role  = "user"
        parts = @(@{ text = "$Prompt`n`nTITLE: $title`n`nARTICLE:`n$text" })
      }
    )
    generationConfig = @{
      temperature      = 0.1
      responseMimeType = "application/json"
      responseSchema   = $Schema
    }
  } | ConvertTo-Json -Depth 12 -Compress

  $models = @($Model, "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest") | Select-Object -Unique
  $lastError = $null

  foreach ($m in $models) {
    $uri = "https://generativelanguage.googleapis.com/v1beta/models/$m`:generateContent?key=$ApiKey"
    try {
      $res = Invoke-RestMethod -Method Post -Uri $uri -ContentType "application/json" -Body $body -TimeoutSec 25
      $raw = $res.candidates[0].content.parts[0].text
      $parsed = $raw | ConvertFrom-Json
      $out = @{
        slop       = [double]$parsed.slop
        category   = [string]$parsed.category
        confidence = [string]$parsed.confidence
        reasons    = @($parsed.reasons)
        model      = $m
      }
      $cache[$key] = $out
      return $out
    } catch {
      $lastError = $_.Exception.Message
    }
  }
  throw "gemini failed: $lastError"
}

# ---------- http ----------
function Read-Request($stream) {
  $ms = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 8192
  $headerEnd = -1

  while ($headerEnd -lt 0) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $ms.Write($buf, 0, $n)
    $s = [Text.Encoding]::ASCII.GetString($ms.ToArray())
    $i = $s.IndexOf("`r`n`r`n")
    if ($i -ge 0) { $headerEnd = $i + 4 }
  }
  if ($headerEnd -lt 0) { return $null }

  $all = $ms.ToArray()
  $headerText = [Text.Encoding]::ASCII.GetString($all, 0, $headerEnd)
  $lines = $headerText -split "`r`n"
  $requestLine = $lines[0]
  $parts = $requestLine -split " "
  $method = $parts[0]; $path = $parts[1]

  $contentLength = 0
  foreach ($l in $lines) {
    if ($l -match "^(?i)content-length:\s*(\d+)") { $contentLength = [int]$Matches[1] }
  }

  $body = ""
  if ($contentLength -gt 0) {
    $have = $all.Length - $headerEnd
    $bytes = New-Object System.Collections.Generic.List[byte]
    if ($have -gt 0) { $bytes.AddRange($all[$headerEnd..($all.Length - 1)]) }
    while ($bytes.Count -lt $contentLength) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      for ($j = 0; $j -lt $n; $j++) { $bytes.Add($buf[$j]) }
    }
    $body = [Text.Encoding]::UTF8.GetString($bytes.ToArray(), 0, [Math]::Min($contentLength, $bytes.Count))
  }

  return @{ method = $method; path = $path; body = $body }
}

function Send-Response($stream, [int]$status, [string]$json) {
  $statusText = if ($status -eq 200) { "OK" } elseif ($status -eq 204) { "No Content" } else { "Error" }
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $head = "HTTP/1.1 $status $statusText`r`n" +
          "Content-Type: application/json; charset=utf-8`r`n" +
          "Content-Length: $($bytes.Length)`r`n" +
          "Access-Control-Allow-Origin: *`r`n" +
          "Access-Control-Allow-Headers: content-type`r`n" +
          "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n" +
          "Connection: close`r`n`r`n"
  $hb = [Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($bytes.Length -gt 0) { $stream.Write($bytes, 0, $bytes.Length) }
  $stream.Flush()
}

# ---------- server ----------
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Sift proxy on http://127.0.0.1:$Port  (model: $Model)" -ForegroundColor Green

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 15000
    $req = Read-Request $stream
    if (-not $req) { continue }

    if ($req.method -eq "OPTIONS") {
      Send-Response $stream 204 ""
    }
    elseif ($req.path -like "/health*") {
      Send-Response $stream 200 '{"ok":true}'
    }
    elseif ($req.path -like "/score-page*" -and $req.method -eq "POST") {
      try {
        $payload = $req.body | ConvertFrom-Json
        $title = [string]$payload.title
        $text = [string]$payload.text
        if ($text.Length -gt 6000) { $text = $text.Substring(0, 6000) }

        $r = Invoke-Gemini $title $text
        $blur = ($r.category -ne "editorial") -and ($r.slop -ge 0.75)
        $r["blur"] = $blur
        $r["ok"] = $true
        Send-Response $stream 200 ($r | ConvertTo-Json -Depth 6 -Compress)
      } catch {
        $msg = $_.Exception.Message -replace '"', "'"
        Send-Response $stream 502 "{`"ok`":false,`"error`":`"$msg`"}"
      }
    }
    else {
      Send-Response $stream 404 '{"ok":false,"error":"not found"}'
    }
  } catch {
    # keep serving; a bad request must never kill the demo
  } finally {
    $client.Close()
  }
}
