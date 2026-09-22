# Static Needle 3 runner for the Homey

Built on an arm64 Docker host (Apple Silicon):

```bash
curl -sLO https://huggingface.co/Cactus-Compute/needle3/resolve/main/linux-arm64/libneedle.a
curl -sLO https://huggingface.co/Cactus-Compute/needle3/resolve/main/linux-arm64/needle.h
docker run --rm --platform linux/arm64 -v "$PWD":/w -w /w ubuntu:24.04 sh -c \
  "apt-get update && apt-get install -y --no-install-recommends clang-18 libc++-18-dev libc++abi-18-dev && \
   clang-18 -O2 -static -Wl,--wrap=sysconf -o needle-line needle-line.c libneedle.a \
   -L/usr/lib/llvm-18/lib -l:libc++.a -l:libc++abi.a -lpthread -lm"
```

Why static: the Homey app container has no glibc loader, so Cactus' dynamically linked runner fails with `spawn ENOENT`.
Why `--wrap=sysconf`: see the comment at the top of `needle-line.c`.
