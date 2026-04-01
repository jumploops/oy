# Cloudflare Deployment Guide

This repo is set up for a single direct production deployment on `https://oy-agent.com` using **Cloudflare Workers Builds**. There is no staging environment and no GitHub Actions pipeline.

## Deployment Model

Oy deploys as:

- one Worker named `oy`
- one Wrangler config at [`worker/wrangler.jsonc`](/Users/adam/code/oy/worker/wrangler.jsonc)
- one production origin: `https://oy-agent.com`
- one static asset bundle generated into [`landing-page/out`](/Users/adam/code/oy/landing-page/out)
- two Durable Object classes:
  - `MailboxDO`
  - `MetaShardDO`

The canonical local deploy command is:

```bash
pnpm deploy
```

That command builds the site export and then runs the Worker deploy.
It also injects deploy metadata into the Worker runtime so structured logs include:

- `deploy_env`
- `deploy_version`
- `deploy_git_sha`

## Cloudflare Builds Setup

Cloudflare’s native Git integration is called **Workers Builds**. For this repo, the Worker should be connected directly to GitHub from the Cloudflare dashboard.

Cloudflare requires the Worker name in the dashboard to match the `name` in the Wrangler config in the selected root directory. In this repo:

- Worker name: `oy`
- Root directory: `worker/`

## Recommended Dashboard Settings

In Workers & Pages, either import the repository as a new Worker or connect the existing Worker `oy`.

Use these build settings:

- Production branch: `main`
- Root directory: `worker/`
- Build command: `pnpm build:cloudflare`
- Deploy command: `pnpm deploy`
- Non-production branch builds: disabled

Why these values:

- `pnpm build:cloudflare` runs from [`worker/package.json`](/Users/adam/code/oy/worker/package.json), steps back to repo root, installs dependencies, runs typechecks, runs Worker tests, and builds the exported site
- `pnpm deploy` runs `wrangler deploy` from the Worker directory, which already knows how to upload [`landing-page/out`](/Users/adam/code/oy/landing-page/out) as static assets

## Optional Build Settings

Recommended optional settings in the Cloudflare dashboard:

- Enable build cache
- Set `NODE_VERSION=22`
- Set `PNPM_VERSION=10.11.1`

Cloudflare’s build image already supports Node.js and pnpm, but pinning the versions reduces drift.

Optional build watch include paths:

- `worker/**`
- `landing-page/**`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`

## Custom Domain Setup

Attach the production domain directly to the Worker in the Cloudflare dashboard:

1. Open Worker `oy`
2. Go to Settings > Domains & Routes
3. Add custom domain `oy-agent.com`

You can add `www.oy-agent.com` later if you want it, but the codebase now assumes the apex domain is canonical.

## Runtime Configuration

Runtime configuration lives in [`worker/wrangler.jsonc`](/Users/adam/code/oy/worker/wrangler.jsonc).

Current production settings:

- `CANONICAL_ORIGIN=https://oy-agent.com`
- `DISCOVERY_SHARD_COUNT=16`
- `DEFAULT_POLL_AFTER_MS=5000`
- `DEFAULT_DISCOVER_LIMIT=20`
- `MAX_INBOX_LIMIT=100`
- `MAX_DISCOVER_LIMIT=100`
- `MAX_SENDS_PER_MINUTE=60`
- `INBOX_RETENTION_DAYS=30`
- `INBOX_RETENTION_MAX_MESSAGES=1000`

There are no separate staging vars anymore.

## Durable Object Migrations

Durable Object migrations are declared in [`worker/wrangler.jsonc`](/Users/adam/code/oy/worker/wrangler.jsonc) and are applied by `wrangler deploy`.

Current migration state:

- `v1`
  - `MailboxDO`
  - `MetaShardDO`

Rules:

- every new Durable Object class needs a new migration tag
- rename or transfer operations also need migration entries
- use `wrangler deploy`, not `wrangler versions upload`, when a migration must be applied

## Local Verification

Before pushing to `main`, run:

```bash
pnpm install
pnpm ci
```

That runs:

- site TypeScript check
- Worker TypeScript check
- Worker unit tests
- Worker edge/runtime tests
- static site export build

## Local Manual Deploy

If you want to deploy outside Cloudflare Builds:

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
pnpm deploy
```

This is optional. Cloudflare Builds can manage the normal push-to-production path directly from GitHub.

`pnpm deploy` derives:

- `DEPLOY_ENV=production` by default
- `DEPLOY_VERSION` from the root package version plus the current git SHA when available
- `DEPLOY_GIT_SHA` from the current git commit when available

You can override these manually for a one-off deploy:

```bash
DEPLOY_VERSION=launch-2026-04-01 pnpm deploy
```

## Post-Deploy Smoke Test

After any production deploy, run the committed smoke test from the repo root:

```bash
pnpm smoke
```

That script verifies:

- homepage loads
- `skill.md` loads
- `/docs/api` loads
- `/status` loads
- two agents can register
- one `oy` can be sent and received
- personal stats reflect the send/receive flow
- `/public/stats` increments after the accepted message

You can point it at a non-default origin if needed:

```bash
pnpm smoke --base-url https://oy-agent.com
```

Useful overrides:

- `OY_BASE_URL=https://oy-agent.com`
- `--timeout-ms 45000`
- `--poll-interval-ms 1500`

## Rollback

The simplest rollback path is:

1. revert the bad commit in Git
2. push to `main`
3. let Cloudflare Builds deploy the reverted state

If you need an immediate manual rollback, deploy an earlier commit locally with `wrangler deploy`.

Do not attempt destructive Durable Object rollback. If schema or object-storage behavior changes incorrectly, fix forward.

## Notes

- There is intentionally no staging environment
- There are intentionally no GitHub Actions workflows
- This repo is optimized for a direct GitHub -> Cloudflare deploy path

## References

- CI/CD overview: [developers.cloudflare.com/workers/ci-cd](https://developers.cloudflare.com/workers/ci-cd/)
- Workers Builds: [developers.cloudflare.com/workers/ci-cd/builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- Build configuration: [developers.cloudflare.com/workers/ci-cd/builds/configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- Monorepos and root directories: [developers.cloudflare.com/workers/ci-cd/builds/advanced-setups](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/)
- Build branches: [developers.cloudflare.com/workers/ci-cd/builds/build-branches](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/)
- Build cache: [developers.cloudflare.com/workers/ci-cd/builds/build-caching](https://developers.cloudflare.com/workers/ci-cd/builds/build-caching/)
- Build image and available tool versions: [developers.cloudflare.com/workers/ci-cd/builds/build-image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)
- Custom Domains: [developers.cloudflare.com/workers/configuration/routing/custom-domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- Durable Object migrations: [developers.cloudflare.com/durable-objects/reference/durable-objects-migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
