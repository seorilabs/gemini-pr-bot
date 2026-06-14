# GitHub App Settings

Create this as an organization-owned GitHub App under `seorilabs`.

## Basic

- GitHub App name: `Seorilabs Seori`
- Homepage URL: `https://github.com/seorilabs/gemini-pr-bot`
- Webhook URL: `https://gemini-pr-bot.vzyx.xyz/github/webhook`
- Webhook secret: generate a random value and store the same value in K8s secret key `GITHUB_WEBHOOK_SECRET`
- Where can this GitHub App be installed?: `Only on this account`

## Repository Permissions

- Checks: `Read and write`
- Contents: `Read-only`
- Issues: `Read and write`
- Metadata: `Read-only`
- Pull requests: `Read and write`
- Commit statuses: `Read-only`

## Subscribe To Events

- Issue comment
- Pull request
- Pull request review
- Pull request review comment

## Installation

Install the app on `All repositories` for organization-wide behavior.
The daemon still ignores public repositories by default because `ALLOW_PUBLIC_REPOS=false`.

After installing, create and download one private key. Store the PEM file through `scripts/create-k8s-secret.sh`.
