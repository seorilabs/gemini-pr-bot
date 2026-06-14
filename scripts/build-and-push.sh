#!/usr/bin/env bash
set -euo pipefail

image="${IMAGE:-registry.vzyx.xyz/seorilabs/gemini-pr-bot}"
tag="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d-%H%M)}"
platform="${PLATFORM:-linux/arm64}"
registry_secret_namespace="${REGISTRY_SECRET_NAMESPACE:-apps}"
registry_secret_name="${REGISTRY_SECRET_NAME:-registry-pull-cred}"
source_docker_config="${DOCKER_CONFIG:-${HOME}/.docker}"
build_docker_config="$(mktemp -d)"
build_context="${build_docker_config}/context.tar"

cleanup() {
  rm -rf "${build_docker_config}"
}
trap cleanup EXIT

if [[ -f "${source_docker_config}/config.json" ]]; then
  cp "${source_docker_config}/config.json" "${build_docker_config}/config.json"
else
  printf '{}\n' >"${build_docker_config}/config.json"
fi

node -e '
const fs = require("node:fs");
const path = process.argv[1];
const config = JSON.parse(fs.readFileSync(path, "utf8"));
delete config.credsStore;
delete config.credHelpers;
config.auths ||= {};
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
' "${build_docker_config}/config.json"

if command -v kubectl >/dev/null 2>&1 &&
  kubectl -n "${registry_secret_namespace}" get secret "${registry_secret_name}" >/dev/null 2>&1; then
  kubectl -n "${registry_secret_namespace}" get secret "${registry_secret_name}" \
    -o jsonpath='{.data.\.dockerconfigjson}' \
    | base64 --decode >"${build_docker_config}/registry-secret.json"

  node -e '
const fs = require("node:fs");
const configPath = process.argv[1];
const secretPath = process.argv[2];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const secret = JSON.parse(fs.readFileSync(secretPath, "utf8"));
delete config.credsStore;
delete config.credHelpers;
config.auths = { ...(config.auths || {}), ...(secret.auths || {}) };
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
' "${build_docker_config}/config.json" "${build_docker_config}/registry-secret.json"
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes; building committed HEAD only." >&2
fi

git archive --format=tar HEAD >"${build_context}"

DOCKER_CONFIG="${build_docker_config}" docker buildx build \
  --platform "${platform}" \
  -t "${image}:${tag}" \
  -t "${image}:latest" \
  --push \
  - <"${build_context}"

echo "Pushed ${image}:${tag} and ${image}:latest"
