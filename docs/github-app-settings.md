# GitHub App Settings

Create this as an organization-owned GitHub App under `seorilabs`.

## Basic

- GitHub App name: `Seorilabs Seori PR Bot`
- Homepage URL: `https://github.com/seorilabs/seori-pr-bot`
- Webhook URL: `https://seori-pr-bot.vzyx.xyz/github/webhook`
- Webhook secret: generate a random value and store the same value in K8s secret key `GITHUB_WEBHOOK_SECRET`
- Where can this GitHub App be installed?: `Only on this account`

## Repository Permissions

- Checks: `Read and write`
- Contents: `Read and write`
- Issues: `Read and write`
- Metadata: `Read-only`
- Pull requests: `Read and write`
- Commit statuses: `Read-only`

## Subscribe To Events

- Issue comment
- Pull request
- Pull request review
- Pull request review comment
- Pull request review thread

## Installation

Install the app on `All repositories` for organization-wide behavior.
The daemon still ignores public repositories by default because `ALLOW_PUBLIC_REPOS=false`.

After installing, create and download one private key. Store the PEM file through `scripts/create-k8s-secret.sh`.

## Jansoree Review App (secondary identity)

- App: **Jansoree** (app id `4792283`, slug `jansoree`)
- 용도: 게이트에서 확정된 치명 결함을 advisory 인라인 코멘트와 "## 잔소리" 요약으로 게시하는 전용 명의. `Seori Review` check와 acceptance-guide thread는 계속 기본 앱(Seori) 명의를 사용한다.
- Permissions: Contents `Read-only`, Issues `Read and write`, Pull requests `Read and write`, Metadata `Read-only`
- Webhook: 없음 (수신 이벤트를 구독하지 않는다)
- Installation: seorilabs 조직 전체 (All repositories)
- Bot env: `REVIEW_GITHUB_APP_ID`, `REVIEW_GITHUB_PRIVATE_KEY` — 미설정이면 advisory 게시만 조용히 스킵된다.
