#!/usr/bin/env python3
"""Optional, only for unified-memory GPUs (e.g. NVIDIA GB10 / Jetson): before Whisper starts,
push the page cache out so CUDA gets memory again. Without root there is no drop_caches,
so this briefly allocates anonymous memory (the kernel evicts cache for it) and frees it.
Never allocates more than MemAvailable minus 1.5 GiB. Not needed on a normal GPU with its own VRAM."""
import re
GIB = 1 << 30
info = open("/proc/meminfo").read()
kb = lambda k: int(re.search(rf"^{k}:\s+(\d+)", info, re.M).group(1)) * 1024
target = min(6 * GIB, kb("MemAvailable") - int(1.5 * GIB))
chunks, step = [], 256 << 20
while target > 0:
    b = bytearray(min(step, target)); b[::4096] = b"\x01" * len(b[::4096]); chunks.append(b); target -= len(b)
print(f"free-cache: {sum(map(len, chunks)) // (1 << 20)} MiB allocated and released again", flush=True)
