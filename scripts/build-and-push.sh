#!/usr/bin/env bash
set -euo pipefail

image="${IMAGE:-registry.vzyx.xyz/seorilabs/seori-pr-bot}"
platform="${PLATFORM:-linux/arm64}"
docker_context="${DOCKER_CONTEXT:-}"
registry_secret_namespace="${REGISTRY_SECRET_NAMESPACE:-apps}"
registry_secret_name="${REGISTRY_SECRET_NAME:-registry-pull-cred}"
use_k8s_registry_secret="${USE_K8S_REGISTRY_SECRET:-0}"
source_docker_config="${DOCKER_CONFIG:-${HOME}/.docker}"
build_docker_config="$(mktemp -d)"
build_context="${build_docker_config}/context.tar"
build_worktree="${BUILD_WORKTREE:-0}"
push_latest_setting="${PUSH_LATEST:-}"

cleanup() {
  rm -rf "${build_docker_config}"
}
trap cleanup EXIT

if [[ -z "${docker_context}" ]] && [[ "$(uname -s)" == "Darwin" ]] && command -v colima >/dev/null 2>&1; then
  if ! colima status >/dev/null 2>&1; then
    echo "Colima를 시작합니다..." >&2
    colima start
  fi
  docker_context="${docker_context:-colima}"
fi

docker_cmd=(docker)
if [[ -n "${docker_context}" ]]; then
  docker_cmd+=(--context "${docker_context}")
fi

"${docker_cmd[@]}" info >/dev/null

if [[ -f "${source_docker_config}/config.json" ]]; then
  cp "${source_docker_config}/config.json" "${build_docker_config}/config.json"
else
  printf '{}\n' >"${build_docker_config}/config.json"
fi

for docker_state_dir in cli-plugins buildx contexts; do
  if [[ -d "${source_docker_config}/${docker_state_dir}" ]]; then
    ln -s "${source_docker_config}/${docker_state_dir}" "${build_docker_config}/${docker_state_dir}"
  fi
done

if [[ "${use_k8s_registry_secret}" == "1" ]] && command -v kubectl >/dev/null 2>&1 &&
  kubectl -n "${registry_secret_namespace}" get secret "${registry_secret_name}" >/dev/null 2>&1; then
  kubectl -n "${registry_secret_namespace}" get secret "${registry_secret_name}" \
    -o jsonpath='{.data.\.dockerconfigjson}' \
    | base64 --decode >"${build_docker_config}/registry-secret.json"

  # JavaScript template syntax is intentionally literal.
  # shellcheck disable=SC2016
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

if [[ "${build_worktree}" != "0" && "${build_worktree}" != "1" ]]; then
  echo "BUILD_WORKTREE는 0 또는 1이어야 합니다." >&2
  exit 1
fi

if [[ -n "${push_latest_setting}" && "${push_latest_setting}" != "0" && "${push_latest_setting}" != "1" ]]; then
  echo "PUSH_LATEST는 0 또는 1이어야 합니다." >&2
  exit 1
fi

head_tag="$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d-%H%M)"
current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
head_sha="$(git rev-parse HEAD 2>/dev/null || true)"

if [[ -n "${TAG:-}" ]]; then
  tag="${TAG}"
elif [[ "${build_worktree}" == "1" ]]; then
  tag="${head_tag}-worktree-$(date -u +%Y%m%d%H%M%S)-$$"
else
  tag="${head_tag}"
fi

if [[ "${build_worktree}" == "0" ]] &&
  { ! git diff --quiet || ! git diff --cached --quiet; }; then
  echo "추적 중인 미커밋 변경이 있습니다. 커밋 후 다시 실행하거나 실험용으로 BUILD_WORKTREE=1을 지정하세요." >&2
  exit 1
fi

if [[ -n "${push_latest_setting}" ]]; then
  push_latest="${push_latest_setting}"
  if [[ "${push_latest}" == "1" ]]; then
    echo "PUSH_LATEST=1 지정으로 브랜치와 upstream 일치 검사를 override합니다." >&2
  fi
else
  push_latest="0"
  if [[ "${build_worktree}" == "1" ]]; then
    echo "worktree 빌드는 latest를 자동 갱신하지 않습니다." >&2
  elif [[ "${current_branch}" != "main" ]]; then
    echo "현재 브랜치가 main이 아니므로 latest를 갱신하지 않습니다: ${current_branch:-detached HEAD}" >&2
  elif ! git fetch --quiet origin main; then
    echo "origin/main fetch에 실패해 latest를 갱신하지 않습니다." >&2
  else
    upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
    if [[ -z "${upstream_ref}" ]]; then
      echo "main 브랜치에 upstream이 없어 latest를 갱신하지 않습니다." >&2
    elif [[ "${upstream_ref}" != "origin/main" ]]; then
      echo "main의 upstream이 origin/main이 아니므로 latest를 갱신하지 않습니다: ${upstream_ref}" >&2
    else
      upstream_sha="$(git rev-parse '@{upstream}' 2>/dev/null || true)"
      if [[ -n "${head_sha}" && "${head_sha}" == "${upstream_sha}" ]]; then
        push_latest="1"
      else
        ahead_count="0"
        behind_count="0"
        read -r ahead_count behind_count < <(
          git rev-list --left-right --count HEAD...'@{upstream}' 2>/dev/null || printf '0 0\n'
        )
        if (( ahead_count > 0 && behind_count > 0 )); then
          upstream_state="분기됨(ahead ${ahead_count}, behind ${behind_count})"
        elif (( ahead_count > 0 )); then
          upstream_state="앞섬(ahead ${ahead_count})"
        elif (( behind_count > 0 )); then
          upstream_state="뒤처짐(behind ${behind_count})"
        else
          upstream_state="HEAD 불일치"
        fi
        echo "main이 origin/main과 일치하지 않아 latest를 갱신하지 않습니다: ${upstream_state}" >&2
      fi
    fi
  fi
fi

build_args=(
  buildx build
  --platform "${platform}"
  -t "${image}:${tag}"
  --provenance=false
  --push
)

if [[ "${push_latest}" == "1" ]]; then
  build_args+=( -t "${image}:latest" )
fi

if [[ "${build_worktree}" == "0" ]]; then
  git archive --format=tar HEAD >"${build_context}"
  DOCKER_CONFIG="${build_docker_config}" "${docker_cmd[@]}" "${build_args[@]}" - <"${build_context}"
else
  echo "현재 worktree를 실험용 이미지 ${image}:${tag}로 빌드합니다." >&2
  DOCKER_CONFIG="${build_docker_config}" "${docker_cmd[@]}" "${build_args[@]}" .
fi

echo "Pushed ${image}:${tag}"
if [[ "${push_latest}" == "1" ]]; then
  echo "Pushed ${image}:latest"
fi
