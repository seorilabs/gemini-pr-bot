#!/usr/bin/env bash
set -euo pipefail

image="${IMAGE:-registry.vzyx.xyz/seorilabs/gemini-pr-bot}"
tag="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M)}"
platform="${PLATFORM:-linux/arm64}"

docker buildx build \
  --platform "${platform}" \
  -t "${image}:${tag}" \
  -t "${image}:latest" \
  --push \
  .

echo "Pushed ${image}:${tag} and ${image}:latest"

