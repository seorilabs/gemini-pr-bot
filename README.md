# Seori Review Bot

Seorilabs organization-wide GitHub App webhook daemon for multi-provider PR review and PR conversation replies.

```mermaid
flowchart LR
  GitHub["GitHub App Webhook"] --> Ingress["K8s Ingress"]
  Ingress --> Bot["gemini-pr-bot"]
  Bot --> GitHubAPI["GitHub App Installation API"]
  Bot --> Providers["Gemini / Cursor / Copilot"]
  Bot --> Comment["PR comments / inline replies / check runs"]
```

## Behavior

- Reviews PRs automatically on `pull_request.opened` and `pull_request.reopened`.
- Responds to PR comments containing `@gemini-cli` or `@gemini`.
- Runs explicit review on `@gemini-cli /review`; if there are no actionable findings, it submits an approval review instead of only commenting.
- Submits a GitHub approval review on `@gemini-cli /approve [reason]`.
- Treats a normal mention as an agent handoff: it analyzes PR context, comments when action is needed, and approves when no actionable findings remain.
- Requests changes with conflict-resolution instructions when GitHub reports merge conflicts.
- Replies directly to inline review comments when mentioned there.
- Creates a `Seori Review` check run for review and agent jobs.
- Can route AI jobs across Gemini CLI, GitHub Copilot CLI, and Cursor Agent with weighted fallback.
- Cancels stale review check runs when a PR is merged, closed, or updated while a review is running.
- Blocks approval while tests, build, lint, typecheck, or status checks are failing or pending.
- Ignores resolved inline review threads.
- Runs as a daemon with a MySQL-backed workflow queue in Kubernetes. Webhooks are durably enqueued, then a worker leases and processes jobs.
- Persists active check-run IDs so a restarted worker can resume a job instead of leaving stale pending checks.
- Ignores public repositories by default with `ALLOW_PUBLIC_REPOS=false`.
- Only responds to `OWNER`, `MEMBER`, or `COLLABORATOR` comments by default.

## Commands

```text
@gemini-cli /review
@seorilabs-seori /review
@seorilabs-gemini-pr-bot /review
/gemini review
@gemini-cli /approve [reason]
/gemini approve [reason]
@gemini-cli /help
@gemini-cli <question>
@seorilabs-seori <question or handoff>
@seorilabs-gemini-pr-bot <question or handoff>
```

`/approve` submits a real GitHub approval review for the current PR HEAD. The approval review body includes a hidden coordination marker:

```html
<!-- seorilabs-gemini-pr-bot:status=no-action-required head=<head-sha> -->
```

Other review agents should treat the latest non-stale approval marker as "no further agent action required". A new commit makes the marker stale when the repository's branch protection dismisses stale approvals.

```mermaid
flowchart TD
  Review["/review or PR opened"] --> Context["Build PR context"]
  Context --> Conflict{"Merge conflict?"}
  Conflict -->|Yes| RequestChanges["REQUEST_CHANGES review with resolution steps"]
  Conflict -->|No| AI["Strict review prompt"]
  AI --> Decision{"Actionable findings?"}
  Decision -->|Yes| Output["Post findings comment + check run"]
  Decision -->|No| Approval["GitHub APPROVE review with HEAD marker"]
  Output --> Approve["Maintainer or trusted agent runs /approve"]
  Approve --> Approval
  Approval --> Agent["Other agents read review state + marker"]
  Agent -->|Approval current| Stop["No further agent action"]
  Agent -->|New commit or stale approval| Review
```

Normal mentions use agent mode. The bot asks the configured AI provider chain to choose one action:

```mermaid
flowchart TD
  Mention["Bot mentioned"] --> Context["Build PR context"]
  Context --> Decide["Agent decision"]
  Decide -->|Action: comment| Comment["Post PR comment or inline reply"]
  Decide -->|Action: approve + no actionable findings| Approval["Submit GitHub APPROVE review"]
  Decide --> Check["Complete Seori Review check"]
```

Approval from agent mode is guarded: the model output must include the approval action marker and the exact `No actionable findings.` finding result. Otherwise the bot only comments.

## Workflow Persistence

In production, set `WORKFLOW_STORE=mysql`. The daemon creates and uses the `base.gemini_pr_bot_workflows` table.

```mermaid
flowchart TD
  Webhook["GitHub webhook"] --> Enqueue["Insert workflow row"]
  Enqueue --> Ack["Return 202 accepted"]
  Worker["Daemon worker"] --> Lease["Lease queued or expired workflow"]
  Lease --> Bot["Run PR review/agent logic"]
  Bot --> Check["Create or reuse Seori Review check-run"]
  Check --> Done["Complete workflow row"]
  Lease -->|worker dies| Expire["Lease expires"]
  Expire --> Lease
```

The workflow table stores delivery dedupe keys, payload JSON, attempts, lease owner/expiry, PR identity, and `check_run_id`. If a pod restarts after creating a check-run, the next worker lease reuses that check-run instead of creating an untracked pending check.

## Required Secrets

Create an organization-owned GitHub App using [docs/github-app-settings.md](docs/github-app-settings.md).

Then create the K8s secrets.

```bash
export GITHUB_APP_ID="..."
export GITHUB_PRIVATE_KEY_FILE="/path/to/seorilabs-gemini-pr-bot.private-key.pem"
export GITHUB_WEBHOOK_SECRET="..."

./scripts/create-k8s-secret.sh
./scripts/create-gemini-cli-oauth-secret.sh
./scripts/copy-mysql-app-secret.sh
```

Optional multi-provider review routing:

```bash
kubectl -n apps create secret generic gemini-pr-bot-provider-secrets \
  --from-literal=COPILOT_GITHUB_TOKEN="$COPILOT_GITHUB_TOKEN" \
  --from-literal=CURSOR_API_KEY="$CURSOR_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Use a dedicated automation account for these credentials. Personal tokens are acceptable for a short smoke test, but not for steady production use.

The production default is:

```text
AI_REVIEW_PROVIDERS=gemini,copilot,cursor
AI_REVIEW_PROVIDER_WEIGHTS=gemini:100,copilot:0,cursor:0
AI_REVIEW_PROVIDER_FALLBACK_ORDER=gemini,cursor,copilot
COPILOT_MODEL=auto
CURSOR_MODEL=gpt-5.2
```

Explicit review jobs, automatic PR reviews, PR Q&A, and agent approval decisions all use the multi-provider router. This keeps `/agent` approval decisions working when Gemini CLI is temporarily quota-blocked.

## Build And Deploy

```bash
npm ci
npm run check
./scripts/build-and-push.sh
kubectl apply -k k8s
kubectl -n apps rollout restart deployment/gemini-pr-bot
kubectl -n apps rollout status deployment/gemini-pr-bot
```

If the local machine does not have Docker, build and push from the cluster with Kaniko:

```bash
./scripts/build-in-cluster.sh
kubectl apply -k k8s
kubectl -n apps rollout restart deployment/gemini-pr-bot
kubectl -n apps rollout status deployment/gemini-pr-bot
```

Webhook endpoint:

```text
https://gemini-pr-bot.vzyx.xyz/github/webhook
```

## Local Development

```bash
cp .env.example .env
npm ci
npm run dev
```
