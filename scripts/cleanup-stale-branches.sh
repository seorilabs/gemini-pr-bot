#!/usr/bin/env bash
#
# Delete stale remote branches whose pull request was already merged.
#
# A branch is deleted only when ALL of these hold:
#   - it is not the repository default branch
#   - it does not match a protected/keep pattern (main|master|develop|release/*|hotfix/*)
#   - it has at least one associated PR that was MERGED
#   - it has NO associated OPEN PR
#
# Squash-merge safe: merge status comes from the GitHub PR API, not git ancestry.
# Branches with no PR at all, or only closed-unmerged PRs, are left untouched
# (abandoned work is not silently destroyed).
#
# Usage:
#   ORG=seorilabs DRY_RUN=true  scripts/cleanup-stale-branches.sh                # all org repos
#   ORG=seorilabs DRY_RUN=false scripts/cleanup-stale-branches.sh reascend       # one or more repos
#   REPOS="seorilabs/reascend seorilabs/foo" DRY_RUN=true scripts/cleanup-stale-branches.sh
#
# Env:
#   ORG                 GitHub org (default: seorilabs)
#   DRY_RUN             true (default) = print only; false = actually delete
#   KEEP_PATTERN        extended regex of branch names to never delete
#   ENABLE_AUTODELETE   true (default) = also set delete_branch_on_merge=true per repo
#   GH_TOKEN/GITHUB_TOKEN  auth for gh (falls back to gh's own auth)
set -euo pipefail

ORG="${ORG:-seorilabs}"
DRY_RUN="${DRY_RUN:-true}"
ENABLE_AUTODELETE="${ENABLE_AUTODELETE:-true}"
KEEP_PATTERN="${KEEP_PATTERN:-^(main|master|develop|release/.*|hotfix/.*)$}"

log() { printf '%s\n' "$*" >&2; }

# Resolve the repo list: explicit args > $REPOS > all non-archived org repos.
resolve_repos() {
  if [[ $# -gt 0 ]]; then
    for r in "$@"; do [[ "$r" == */* ]] && echo "$r" || echo "${ORG}/${r}"; done
    return
  fi
  if [[ -n "${REPOS:-}" ]]; then
    for r in ${REPOS}; do [[ "$r" == */* ]] && echo "$r" || echo "${ORG}/${r}"; done
    return
  fi
  gh repo list "$ORG" --limit 500 --no-archived --json nameWithOwner -q '.[].nameWithOwner'
}

total_deleted=0
total_candidates=0

process_repo() {
  local repo="$1"
  local default_branch
  default_branch="$(gh api "repos/${repo}" -q '.default_branch' 2>/dev/null || echo "")"
  if [[ -z "$default_branch" ]]; then
    log "!! ${repo}: skipped (cannot read repo)"
    return
  fi

  if [[ "$ENABLE_AUTODELETE" == "true" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
      local cur
      cur="$(gh api "repos/${repo}" -q '.delete_branch_on_merge' 2>/dev/null || echo "?")"
      [[ "$cur" != "true" ]] && log "   ${repo}: would set delete_branch_on_merge=true (now: ${cur})"
    else
      gh api -X PATCH "repos/${repo}" -F delete_branch_on_merge=true >/dev/null 2>&1 || true
    fi
  fi

  # All branch names.
  local branches
  branches="$(gh api "repos/${repo}/branches" --paginate -q '.[].name' 2>/dev/null || echo "")"
  [[ -z "$branches" ]] && return

  while IFS= read -r branch; do
    [[ -z "$branch" ]] && continue
    [[ "$branch" == "$default_branch" ]] && continue
    [[ "$branch" =~ $KEEP_PATTERN ]] && continue

    # Associated PR states via gh's embedded jq (no python/jq binary needed).
    local open_count merged_count
    open_count="$(gh pr list --repo "$repo" --head "$branch" --state open --json number -q 'length' 2>/dev/null || echo 0)"
    [[ "${open_count:-0}" != "0" ]] && continue    # active PR: keep
    merged_count="$(gh pr list --repo "$repo" --head "$branch" --state merged --json number -q 'length' 2>/dev/null || echo 0)"
    [[ "${merged_count:-0}" == "0" ]] && continue  # no merged PR: keep (abandoned/WIP)

    total_candidates=$((total_candidates + 1))
    if [[ "$DRY_RUN" == "true" ]]; then
      log "   ${repo} :: DELETE (merged) ${branch}"
    else
      if gh api -X DELETE "repos/${repo}/git/refs/heads/${branch}" >/dev/null 2>&1; then
        total_deleted=$((total_deleted + 1))
        log "   ${repo} :: deleted ${branch}"
      else
        log "   ${repo} :: FAILED to delete ${branch}"
      fi
    fi
  done <<< "$branches"
}

log "== branch cleanup (DRY_RUN=${DRY_RUN}, org=${ORG}) =="
while IFS= read -r repo; do
  [[ -z "$repo" ]] && continue
  process_repo "$repo"
done < <(resolve_repos "$@")

if [[ "$DRY_RUN" == "true" ]]; then
  log "== dry-run done: ${total_candidates} branch(es) would be deleted =="
else
  log "== done: ${total_deleted} branch(es) deleted =="
fi
