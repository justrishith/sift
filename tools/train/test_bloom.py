import glob, math, sys
import numpy as np
import onnxruntime as ort
from PIL import Image

sess = ort.InferenceSession("site/bloom.onnx", providers=["CPUExecutionProvider"])
print("inputs:", [(i.name, i.shape) for i in sess.get_inputs()])
print("outputs:", [(o.name, o.shape) for o in sess.get_outputs()])

MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]

def prep(path):
    im = Image.open(path).convert("RGB").resize((192, 192))
    a = np.asarray(im, dtype=np.float32) / np.float32(255.0)
    a = (a - np.array(MEAN, dtype=np.float32)) / np.array(STD, dtype=np.float32)
    return a.transpose(2, 0, 1)[None].astype(np.float32)  # NCHW

for p in sys.argv[1:]:
    t = prep(p)
    outs = sess.run(None, {sess.get_inputs()[0].name: t})
    logits = outs[0][0]
    m = max(logits)
    e = [math.exp(l - m) for l in logits]
    ai = e[1] / (e[0] + e[1])
    print(p, "logits", [round(float(l), 4) for l in logits], "-> ai =", round(ai, 4))
