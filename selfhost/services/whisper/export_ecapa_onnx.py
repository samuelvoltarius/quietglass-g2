#!/usr/bin/env python3
"""One-time export of the ECAPA speaker encoder (speechbrain/spkrec-ecapa-voxceleb) to ONNX.

Run ONCE in any Python that has torch + speechbrain (it need not be the server's Python):
    pip install torch speechbrain huggingface_hub onnx
    python export_ecapa_onnx.py models/spkrec-ecapa-voxceleb
The server itself then only needs `onnxruntime` + numpy (no torch/torchaudio version pinning).
Writes <dir>/ecapa.onnx: input "feats" [1, frames, 80] (log-mel fbank, see babel_stream.fbank),
output "emb" [1, 192].
"""
import os, sys
import numpy as np, torch

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "spkrec-ecapa-voxceleb")
if not os.path.exists(os.path.join(d, "embedding_model.ckpt")):
    from huggingface_hub import snapshot_download
    snapshot_download("speechbrain/spkrec-ecapa-voxceleb", local_dir=d)

from speechbrain.lobes.models.ECAPA_TDNN import ECAPA_TDNN

model = ECAPA_TDNN(80, channels=[1024, 1024, 1024, 1024, 3072], kernel_sizes=[5, 3, 3, 3, 1],
                   dilations=[1, 2, 3, 4, 1], attention_channels=128, lin_neurons=192)
model.load_state_dict(torch.load(os.path.join(d, "embedding_model.ckpt"), map_location="cpu"), strict=True)
model.eval()


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, feats):
        # sentence-level mean normalisation (speechbrain InputNormalization, norm_type=sentence, std_norm=False)
        feats = feats - feats.mean(dim=1, keepdim=True)
        return self.m(feats).reshape(1, 192)


w = Wrap(model).eval()
x = torch.randn(1, 300, 80)
out = os.path.join(d, "ecapa.onnx")
torch.onnx.export(w, (x,), out, input_names=["feats"], output_names=["emb"],
                  dynamic_axes={"feats": {1: "frames"}}, opset_version=17, dynamo=False)

import onnxruntime as ort
s = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
for n in (120, 300, 600):
    x = torch.randn(1, n, 80)
    with torch.inference_mode():
        ref = w(x).numpy()
    got = s.run(None, {"feats": x.numpy()})[0]
    print("frames %d  max abs diff %.2e" % (n, float(np.abs(ref - got).max())))
print("written", out, os.path.getsize(out) // 1024, "KiB")
