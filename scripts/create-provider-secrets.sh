#!/usr/bin/env bash
# Set the shared seori-pr-bot-provider-secrets Kubernetes secret used by the
# optional AI review providers. MiniMax is the default and required; Copilot
# is the optional fallback (quota returns 2026-07-01). Gemini and Cursor code
# is preserved in source for future re-enable but are no longer wired here.
#
# Usage:
#   export MINIMAX_API_KEY="..."
#   export COPILOT_GITHUB_TOKEN="..."   # optional
#   ./scripts/create-provider-secrets.sh
set -euo pipefail

: "${MINIMAX_API_KEY:?Set MINIMAX_API_KEY to the MiniMax platform API key}"
: "${COPILOT_GITHUB_TOKEN:=}"

namespace="${NAMESPACE:-apps}"
secret_name="${SECRET_NAME:-seori-pr-bot-provider-secrets}"

args=(
  --from-literal=MINIMAX_API_KEY="${MINIMAX_API_KEY}"
)
if [[ -n "${COPILOT_GITHUB_TOKEN}" ]]; then
  args+=(--from-literal=COPILOT_GITHUB_TOKEN="${COPILOT_GITHUB_TOKEN}")
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