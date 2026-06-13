#!/usr/bin/env bash
set -euo pipefail

gemini_home="${GEMINI_HOME_DIR:-${HOME}/.gemini}"
namespace="${NAMESPACE:-apps}"
secret_name="${SECRET_NAME:-gemini-pr-bot-cli-oauth}"
tmpdir=$(mktemp -d)

retry() {
  for attempt in 1 2 3 4 5; do
    if "$@"; then
      return 0
    fi

    sleep_seconds=$((attempt * 3))
    echo "command failed; retrying in ${sleep_seconds}s (${attempt}/5): $*" >&2
    sleep "${sleep_seconds}"
  done

  "$@"
}

cleanup() {
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

test -f "${gemini_home}/oauth_creds.json"
test -f "${gemini_home}/google_accounts.json"

printf '%s\n' '{"security":{"auth":{"selectedType":"oauth-personal"}}}' >"${tmpdir}/settings.json"

kubectl -n "${namespace}" create secret generic "${secret_name}" \
  --from-file=oauth_creds.json="${gemini_home}/oauth_creds.json" \
  --from-file=google_accounts.json="${gemini_home}/google_accounts.json" \
  --from-file=settings.json="${tmpdir}/settings.json" \
  --dry-run=client -o yaml |
  retry kubectl apply -f -
