#!/usr/bin/env bash
set -euo pipefail

source_namespace="${SOURCE_NAMESPACE:-data}"
target_namespace="${TARGET_NAMESPACE:-apps}"
secret_name="${SECRET_NAME:-mysql-app-cred}"

kubectl -n "${source_namespace}" get secret "${secret_name}" -o json \
  | jq --arg namespace "${target_namespace}" '
      del(
        .metadata.annotations,
        .metadata.creationTimestamp,
        .metadata.managedFields,
        .metadata.namespace,
        .metadata.resourceVersion,
        .metadata.uid
      )
      | .metadata.namespace = $namespace
    ' \
  | kubectl apply -f -

echo "Copied secret ${source_namespace}/${secret_name} to ${target_namespace}/${secret_name}"
