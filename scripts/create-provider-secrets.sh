#!/usr/bin/env bash
# Set the seori-pr-bot-provider-secrets Kubernetes secret used by Gemini.
#
# Usage:
#   export GEMINI_API_KEY="..."
#   ./scripts/create-provider-secrets.sh
set -euo pipefail

: "${GEMINI_API_KEY:?Set GEMINI_API_KEY to the company Gemini API key}"

namespace="${NAMESPACE:-apps}"
secret_name="${SECRET_NAME:-seori-pr-bot-provider-secrets}"

args=(
  --from-literal=GEMINI_API_KEY="${GEMINI_API_KEY}"
)

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
