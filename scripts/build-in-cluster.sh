#!/usr/bin/env bash
set -euo pipefail

namespace="${NAMESPACE:-apps}"
image="${IMAGE:-registry.vzyx.xyz/seorilabs/gemini-pr-bot}"
tag="${TAG:-$(git rev-parse --short HEAD)}"
timeout="${TIMEOUT:-20m}"
node_name="${BUILD_NODE:-rpi5}"

safe_tag=$(printf '%s' "${tag}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | cut -c1-24)
job_name="build-gemini-pr-bot-${safe_tag}"
context_configmap="${job_name}-context"
tmpdir=$(mktemp -d)
context_tgz="${tmpdir}/context.tgz"
job_yaml="${tmpdir}/job.yaml"

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
  kubectl -n "${namespace}" delete configmap "${context_configmap}" --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes; building committed HEAD only." >&2
fi

git archive --format=tar HEAD | gzip -9 >"${context_tgz}"

retry kubectl -n "${namespace}" delete job "${job_name}" --ignore-not-found
retry kubectl -n "${namespace}" delete configmap "${context_configmap}" --ignore-not-found
retry kubectl -n "${namespace}" create configmap "${context_configmap}" --from-file=context.tgz="${context_tgz}"

cat >"${job_yaml}" <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job_name}
  namespace: ${namespace}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      nodeSelector:
        kubernetes.io/hostname: ${node_name}
        kubernetes.io/os: linux
        kubernetes.io/arch: arm64
      initContainers:
        - name: unpack-context
          image: busybox:1.37.0
          command:
            - sh
            - -c
          args:
            - |
              set -eu
              tar -xzf /context/context.tgz -C /workspace
          volumeMounts:
            - name: build-context
              mountPath: /context
              readOnly: true
            - name: workspace
              mountPath: /workspace
      containers:
        - name: kaniko
          image: gcr.io/kaniko-project/executor:latest
          args:
            - --dockerfile=/workspace/Dockerfile
            - --context=dir:///workspace
            - --destination=${image}:${tag}
            - --destination=${image}:latest
            - --cache=true
            - --cache-repo=registry.vzyx.xyz/seorilabs/kaniko-cache
            - --build-arg=TARGETARCH=arm64
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: docker-config
              mountPath: /kaniko/.docker
              readOnly: true
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
      volumes:
        - name: build-context
          configMap:
            name: ${context_configmap}
        - name: workspace
          emptyDir: {}
        - name: docker-config
          secret:
            secretName: registry-pull-cred
            items:
              - key: .dockerconfigjson
                path: config.json
YAML

retry kubectl apply --validate=false -f "${job_yaml}"

if ! kubectl -n "${namespace}" wait --for=condition=complete "job/${job_name}" --timeout="${timeout}"; then
  kubectl -n "${namespace}" describe "job/${job_name}" || true
  kubectl -n "${namespace}" logs "job/${job_name}" -c unpack-context --tail=-1 || true
  kubectl -n "${namespace}" logs "job/${job_name}" -c kaniko --tail=-1 || true
  exit 1
fi

kubectl -n "${namespace}" logs "job/${job_name}" -c kaniko --tail=80
echo "Pushed ${image}:${tag} and ${image}:latest"
