#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_APP_ID:?Set GITHUB_APP_ID}"
: "${GITHUB_PRIVATE_KEY_FILE:?Set GITHUB_PRIVATE_KEY_FILE to the GitHub App private key PEM path}"
: "${GITHUB_WEBHOOK_SECRET:?Set GITHUB_WEBHOOK_SECRET}"
: "${GEMINI_API_KEY:?Set GEMINI_API_KEY}"

secret_yaml=$(
  kubectl -n apps create secret generic gemini-pr-bot-secrets \
    --from-literal=GITHUB_APP_ID="${GITHUB_APP_ID}" \
    --from-file=GITHUB_PRIVATE_KEY="${GITHUB_PRIVATE_KEY_FILE}" \
    --from-literal=GITHUB_WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET}" \
    --from-literal=GEMINI_API_KEY="${GEMINI_API_KEY}" \
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
