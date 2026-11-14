---
name: Obsidian Sentinel
colors:
  surface: '#16111f'
  surface-dim: '#16111f'
  surface-bright: '#3d3646'
  surface-container-lowest: '#110c19'
  surface-container-low: '#1f1927'
  surface-container: '#231d2b'
  surface-container-high: '#2e2736'
  surface-container-highest: '#393241'
  on-surface: '#eadef3'
  on-surface-variant: '#cbc3d7'
  inverse-surface: '#eadef3'
  inverse-on-surface: '#342e3d'
  outline: '#958ea0'
  outline-variant: '#494454'
  surface-tint: '#d0bcff'
  primary: '#d0bcff'
  on-primary: '#3c0091'
  primary-container: '#a078ff'
  on-primary-container: '#340080'
  inverse-primary: '#6d3bd7'
  secondary: '#ccbeff'
  on-secondary: '#332664'
  secondary-container: '#4a3d7c'
  on-secondary-container: '#baabf3'
  tertiary: '#cebdff'
  on-tertiary: '#381385'
  tertiary-container: '#9b7fed'
  on-tertiary-container: '#31057e'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#e9ddff'
  primary-fixed-dim: '#d0bcff'
  on-primary-fixed: '#23005c'
  on-primary-fixed-variant: '#5516be'
  secondary-fixed: '#e7deff'
  secondary-fixed-dim: '#ccbeff'
  on-secondary-fixed: '#1e0e4e'
  on-secondary-fixed-variant: '#4a3d7c'
  tertiary-fixed: '#e8ddff'
  tertiary-fixed-dim: '#cebdff'
  on-tertiary-fixed: '#21005e'
  on-tertiary-fixed-variant: '#4f319c'
  background: '#16111f'
  on-background: '#eadef3'
  surface-variant: '#393241'
typography:
  display-lg:
    fontFamily: Space Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.03em
  display-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
    letterSpacing: -0.02em
  display-sm:
    fontFamily: Space Grotesk
    fontSize: 36px
    fontWeight: '600'
    lineHeight: 44px
    letterSpacing: -0.025em
  display-sm-mobile:
    fontFamily: Space Grotesk
    fontSize: 26px
    fontWeight: '600'
    lineHeight: 34px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 30px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Space Grotesk
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 26px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Space Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Space Grotesk
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 22px
    letterSpacing: 0em
  body-sm:
    fontFamily: Space Grotesk
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0.01em
  label-lg:
    fontFamily: Space Grotesk
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.02em
  label-md:
    fontFamily: Space Grotesk
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.03em
  label-sm:
    fontFamily: Space Grotesk
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.08em
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1.5rem
  gutter-mobile: 1rem
  margin: 2rem
  margin-mobile: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style
The design system establishes an ultra-sleek, technical, and vigilant posture tailored for real-time deepfake mitigation and synthetic media defense. Designed for security analysts, high-profile communications teams, and discerning digital custodians, it balances raw defensive cybersecurity with computational elegance.

The visual direction combines **Technical Minimalism** with a **Tactile Cyber/High-Contrast Neon** edge:
- Deep, light-absorbing obsidian and midnight violet canvases frame synthetic verification workflows.
- Neon violet, iris, and electric lilac light vectors guide attention toward forensic anomalies, confidence metrics, and threat vectors.
- Sharp, precise technical framing paired with low-intensity phosphorescent luminescence conveys a constant state of diagnostic vigilance without consumer gimmickry.

## Colors
The palette leverages a deep spectral hierarchy rooted in violet-infused obsidian, preventing flat black fatigue while maintaining maximum dynamic contrast for forensic data displays:

- **Surface Foundations:**
  - `bg-base`: `#0c0714` (Deep obsidian baseline)
  - `bg-surface`: `#120a1f` (Primary structural panels)
  - `bg-elevated`: `#190e2b` (Secondary cards, inspection modules)
  - `bg-overlay`: `#22143d` (Active states, modals, popovers)
  - `bg-highlight`: `#1b1130` (Selected rows, muted hover wells)

- **Chromatics & Threat Spectrum:**
  - Primary Accent: `#8b5cf6` (Electric Iris - action triggers, primary verification badges)
  - Secondary Neon: `#c4b5fd` (Soft Lilac - active highlights, cursor locks, primary metrics)
  - Tertiary Vector: `#a78bfa` (Luminescent Violet - focus states, telemetry curves, glowing indicators)
  - Threat Critical: `#f43f5e` (Synthetic match / deepfake confirmed)
  - Threat Nominal: `#10b981` (Authentic cryptographic signature verified)
  - Threat Analyzing: `#fbbf24` (Deep analysis in flight)

- **Typography & Foreground:**
  - `text-primary`: `#fdfaff` (Crisp optical white with cool lilac bias)
  - `text-secondary`: `#d8cbfa` (Soft lilac for secondary data and metadata)
  - `text-muted`: `#9e8ec2` (Muted violet-gray for timestamps, grid ticks, inactive labels)
  - `border-glow`: `rgba(167, 139, 250, 0.2)` (Default structural outline)
  - `border-active`: `rgba(196, 181, 253, 0.5)` (Focused and alert borders)

## Typography
`Space Grotesk` drives the brand’s technical precision and robotic, mathematical cadence. Its geometric quirks and sharp joints mirror waveform analysis, pixel grids, and neural network nodes.

- **Display & Headlines:** Use tight negative letter spacing to project density and authority. Numbers and status metrics must render in tabular lining figures when displaying confidence percentages.
- **Labels & Micro-Data:** Set `label-sm` in full uppercase with expanded letter-spacing (`0.08em`) for hardware-style diagnostics, security clearances, and packet states.
- **Monospace Fallback:** For raw cryptographic hash values, byte streams, and facial landmark coordinates, deploy `JetBrains Mono` strictly as an auxiliary data conduit.

## Layout & Spacing
The layout adheres to a rigid 12-column modular grid designed to accommodate multi-stream telemetry, live video analysis, and diagnostic logs.

- **Breakpoints:**
  - `mobile`: `< 768px` (4-column flow, 1rem margins, stacked inspection panels)
  - `tablet`: `768px - 1199px` (8-column flow, 1.5rem gutters)
  - `desktop`: `≥ 1200px` (12-column fluid-locked grid, fixed sidebar controls, max canvas width 1600px)

- **Rhythm & Structure:** All spatial increments strictly step along a 4px baseline grid. Density is favored over vast emptiness: panels maintain compact padding (`space-md` to `space-lg`) to maximize situational awareness on high-resolution monitor walls.

## Elevation & Depth
Depth is created through chromatic density layering coupled with low-intensity photon diffusion (neon blooms) rather than physical drop shadows.

1. **Layer 0 (Canvas):** Pure `#0c0714`. Receded background for grid coordinates and global scanlines.
2. **Layer 1 (Card/Surface):** `#120a1f` with a hairline stroke: `1px solid rgba(167, 139, 250, 0.15)`.
3. **Layer 2 (Inspected Focus):** `#190e2b` with `1px solid rgba(167, 139, 250, 0.35)` and an ambient, diffuse outer glow: `box-shadow: 0 0 20px -4px rgba(139, 92, 246, 0.18)`.
4. **Layer 3 (Overlay / Modal / Threat Intercept):** `#22143d` elevated with `box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.8), 0 0 30px 0 rgba(167, 139, 250, 0.25)`.
5. **Backdrop Filters:** Translucent surfaces utilize `backdrop-filter: blur(16px)` tinted with `rgba(18, 10, 31, 0.75)` to maintain readability over streaming forensic video feeds.

## Shapes
The shape language is strictly **Soft Technical** (`roundedness: 1`), utilizing restrained 4px (`0.25rem`) corners across components, elevating to 8px (`0.5rem`) on parent containers, and 12px (`0.75rem`) on root viewport windows. 

Sharp, near-orthogonal silhouettes preserve the tactile, industrial instrumentation aesthetic. Overly rounded or organic forms are intentionally banned to eliminate visual latency and avoid soft consumer connotations.

## Components

### Buttons
- **Primary (Intercept/Confirm):** Background `#8b5cf6`, text `#fdfaff`, 4px corner radius. Border: `1px solid #c4b5fd`. Hover triggers an outward violet radiance: `box-shadow: 0 0 16px rgba(139, 92, 246, 0.6)`.
- **Secondary (Scan/Filter):** Background `#1b1130`, text `#d8cbfa`, border `1px solid rgba(167, 139, 250, 0.3)`. Hover transitions border to `#a78bfa` with background `#22143d`.
- **Ghost/Tertiary:** Background transparent, text `#9e8ec2`, hover text `#fdfaff` with subtle `rgba(167, 139, 250, 0.1)` background fill.

### Chips & Badges
- **Status Chips:** Height 24px, 4px border radius. Padding: `0 8px`. Font: `label-sm` uppercase.
- **Deepfake Threat Badge:** Background `rgba(244, 63, 94, 0.15)`, text `#fda4af`, border `1px solid rgba(244, 63, 94, 0.4)`.
- **Verified Authentic Badge:** Background `rgba(16, 185, 129, 0.15)`, text `#6ee7b7`, border `1px solid rgba(16, 185, 129, 0.4)`.
- **Telemetry Tag:** Background `#1b1130`, text `#c4b5fd`, border `1px solid rgba(167, 139, 250, 0.2)`.

### Input Fields & Controls
- **Inputs:** Base `#120a1f`, text `#fdfaff`, placeholder `#9e8ec2`. Perimeter: `1px solid rgba(167, 139, 250, 0.25)`. Focus brings border to `#c4b5fd` paired with an inner and outer glow: `box-shadow: 0 0 8px rgba(167, 139, 250, 0.3)`.
- **Checkboxes & Radios:** Compact square/chiseled glyphs. Checked state fills with `#8b5cf6`, carrying an `#fdfaff` micro indicator and subtle purple outer bloom.

### Cards & Telemetry Containers
- Built on `#190e2b` with a hairline `1px solid rgba(167, 139, 250, 0.2)` border. Headers feature an integrated sub-divider in `rgba(167, 139, 250, 0.12)`.
- Interactive cards elevate on hover to `#22143d` with borders intensifying to `rgba(196, 181, 253, 0.4)`.

### Lists & Activity Feeds
- Zebra or partitioned rows with border-bottom `1px solid rgba(167, 139, 250, 0.08)`.
- Active scanning row features a left-hand 2px accent line in `#c4b5fd` with a horizontal linear gradient fade of `rgba(139, 92, 246, 0.08)` across the item width.

### Diagnostic Visualizers & HUD Reticles
- Video overlays employ hairline corner brackets (`length: 12px`, `stroke: 1.5px #c4b5fd`) surrounding detected face zones.
- Real-time confidence score bars use segmented blocks: nominal steps in `#8b5cf6`, anomaly alerts flashing `#f43f5e`.