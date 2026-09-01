#!/usr/bin/env bash
# Set the seori-pr-bot-provider-secrets Kubernetes secret used by MiniMax.
#
# Usage:
#   export MINIMAX_API_KEY="..."
#   ./scripts/create-provider-secrets.sh
#
# 롤백 보전: GEMINI_API_KEY가 env에 함께 있으면 두 키를 모두 기록해
# 이전 이미지(secretKeyRef GEMINI_API_KEY)로의 rollout undo가 계속 뜬다.
set -euo pipefail

: "${MINIMAX_API_KEY:?Set MINIMAX_API_KEY to the MiniMax Coding Plan API key}"

namespace="${NAMESPACE:-apps}"
secret_name="${SECRET_NAME:-seori-pr-bot-provider-secrets}"

args=(
  --from-literal=MINIMAX_API_KEY="${MINIMAX_API_KEY}"
)

if [[ -n "${GEMINI_API_KEY:-}" ]]; then
  args+=(--from-literal=GEMINI_API_KEY="${GEMINI_API_KEY}")
fi

secret_yaml=$(
  kubectl -n "${namespace}" create secret generic "${secret_name}" \
    "${args[@]}" \
    --dry-run=client -o yaml
)

for attempt in 1 2 3 4 5; do
  if printf '%s\n' "${secret_yaml}" | kubectl apply -f -; then
    exit 0
  fi

  sleep_seconds=$((attempt * 3))
  echo "kubectl apply failed; retrying in ${sleep_seconds}s (${attempt}/5)" >&2
  sleep "${sleep_seconds}"
done

printf '%s\n' "${secret_yaml}" | kubectl apply -f -
