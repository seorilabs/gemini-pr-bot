#!/usr/bin/env bash
# Set the seori-pr-bot-review-app-secrets Kubernetes secret for the Jansoree
# advisory identity (secondary GitHub App).
#
# Usage:
#   export REVIEW_GITHUB_APP_ID="4792283"
#   export REVIEW_GITHUB_PRIVATE_KEY_FILE="/path/to/jansoree.private-key.pem"
#   ./scripts/create-review-app-secret.sh
set -euo pipefail

: "${REVIEW_GITHUB_APP_ID:?Set REVIEW_GITHUB_APP_ID to the Jansoree GitHub App id}"
: "${REVIEW_GITHUB_PRIVATE_KEY_FILE:?Set REVIEW_GITHUB_PRIVATE_KEY_FILE to the Jansoree PEM path}"

if [[ ! -s "${REVIEW_GITHUB_PRIVATE_KEY_FILE}" ]]; then
  echo "Private key file is missing or empty: ${REVIEW_GITHUB_PRIVATE_KEY_FILE}" >&2
  exit 1
fi

namespace="${NAMESPACE:-apps}"
secret_name="${SECRET_NAME:-seori-pr-bot-review-app-secrets}"

secret_yaml=$(
  kubectl -n "${namespace}" create secret generic "${secret_name}" \
    --from-literal=REVIEW_GITHUB_APP_ID="${REVIEW_GITHUB_APP_ID}" \
    --from-file=REVIEW_GITHUB_PRIVATE_KEY="${REVIEW_GITHUB_PRIVATE_KEY_FILE}" \
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
