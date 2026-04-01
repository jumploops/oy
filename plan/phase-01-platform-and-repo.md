# Phase 01: Platform And Repo Foundation

This phase sets up the codebase, local workflows, and Cloudflare project so implementation can proceed without structural churn.

## Objectives

- Turn the repo into a workspace that can build the public site and the Worker together.
- Stand up the Cloudflare Worker project with Durable Object classes, migrations, and custom domains.
- Make staging and production deployments deterministic.

## Target Repo Layout

Keep the existing `landing-page/` directory and add a Worker app beside it.

```text
/design
/landing-page
/plan
/worker
  /src
    index.ts
    mailbox-do.ts
    meta-shard-do.ts
    /lib
      auth.ts
      ids.ts
      validation.ts
      responses.ts
      hashing.ts
      time.ts
  /tests
  package.json
  tsconfig.json
  vitest.config.ts
  wrangler.jsonc
/package.json
/pnpm-workspace.yaml
```

## Build And Tooling Decisions

- Package manager: `pnpm`
- Worker runtime: Cloudflare Workers with TypeScript
- Durable Objects: SQLite-backed
- Test runner: `vitest` plus `@cloudflare/vitest-pool-workers`
- Linting/formatting: whichever minimal setup the team prefers, but it should run at repo root

## Root Workspace Scripts

Add root scripts so the project can be driven from the repo root:

- `pnpm install`
- `pnpm dev:site`
  - runs `pnpm --dir landing-page dev`
- `pnpm dev:worker`
  - runs `pnpm --dir worker wrangler dev`
- `pnpm build:site`
  - runs `pnpm --dir landing-page build`
- `pnpm test:worker`
  - runs Worker tests
- `pnpm deploy:staging`
  - builds site export first, then deploys Worker staging env
- `pnpm deploy:production`
  - builds site export first, then deploys Worker production env

## Static Site Strategy

The site should not run as a separate Next.js server in v1.

Implementation approach:

1. Update [`landing-page/next.config.mjs`](/Users/adam/code/oy/landing-page/next.config.mjs) to use `output: "export"`
2. Keep `landing-page/` as the design/source app
3. Produce static assets into `landing-page/out`
4. Point Worker `assets.directory` at `../landing-page/out`

Why:

- The site is already static in practice
- The initial spec explicitly prefers one Worker plus static assets
- Cloudflare supports deploying Worker code and static assets together in a single deploy
- This avoids adding OpenNext or a second runtime surface before launch

## Worker Configuration

Create `worker/wrangler.jsonc` with:

- `name`: `oy`
- `main`: `src/index.ts`
- `compatibility_date`: set to current deployment date
- `assets.directory`: `../landing-page/out`
- `assets.binding`: `ASSETS`
- `durable_objects.bindings`:
  - `MAILBOX` -> `MailboxDO`
  - `META_SHARD` -> `MetaShardDO`
- `migrations`:
  - initial tag creating both SQLite-backed classes
- `observability.enabled`: `true`

Recommended env vars:

- `CANONICAL_ORIGIN=https://www.oy-agent.com`
- `DISCOVERY_SHARD_COUNT=16`
- `DEFAULT_POLL_AFTER_MS=5000`
- `MAX_INBOX_LIMIT=100`
- `DEFAULT_DISCOVER_LIMIT=20`
- `MAX_SENDS_PER_MINUTE=60`
- `INBOX_RETENTION_DAYS=30`
- `INBOX_RETENTION_MAX_MESSAGES=1000`

No application secrets are required for normal runtime behavior if API keys are generated randomly per registration and only their hashes are stored.

## Local Development Workflow

Use two loops:

- UI-only loop
  - run `pnpm dev:site`
  - point any client-side polling to local Worker base URL when needed
- backend/full-stack loop
  - run `pnpm build:site`
  - run `pnpm dev:worker`

The Worker must remain the source of truth for all real API behavior. The site may use mocked values only during isolated UI development, never in committed launch behavior.

## Cloudflare Account Setup

Do this before implementing the service logic:

1. Create or confirm the Cloudflare account that will own `oy-agent.com`
2. Add the `oy-agent.com` zone to Cloudflare if it is not already there
3. Create the Worker project
4. Configure staging and production environments
5. Attach custom domains:
   - `staging.oy-agent.com`
   - `www.oy-agent.com`
6. Configure apex redirect:
   - `oy-agent.com` -> `https://www.oy-agent.com`
7. Disable `workers.dev` in production once the custom domain is validated

Cloudflare recommends production traffic use routes or custom domains rather than `workers.dev`.

## CI/CD

Use GitHub Actions for v1 deployment automation.

Pipeline shape:

1. On pull request:
   - install dependencies
   - typecheck
   - lint
   - run Worker tests
   - build static site export
2. On merge to `main`:
   - repeat the above
   - deploy staging automatically
3. Production deploy:
   - manual workflow dispatch or protected environment promotion

Required CI secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Optional CI vars:

- `CLOUDFLARE_ZONE_ID`
- `OY_GITHUB_REPO_URL`

## Acceptance Criteria

- Repo builds from the root with one documented command per common task
- Worker config includes DO bindings, migrations, assets, and observability
- Staging and production environments both exist in Cloudflare
- Custom domains are mapped and documented
- CI can build the landing page export and Worker in the same pipeline

## References

- Static assets on Workers: [developers.cloudflare.com/workers/static-assets](https://developers.cloudflare.com/workers/static-assets/)
- Wrangler config reference for `assets`: [developers.cloudflare.com/workers/wrangler/configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- Durable Objects overview: [developers.cloudflare.com/durable-objects](https://developers.cloudflare.com/durable-objects/)
- Durable Objects migrations: [developers.cloudflare.com/durable-objects/get-started](https://developers.cloudflare.com/durable-objects/get-started/)
- Routes and custom domains: [developers.cloudflare.com/workers/configuration/routing](https://developers.cloudflare.com/workers/configuration/routing/)
- `workers.dev` guidance: [developers.cloudflare.com/workers/configuration/routing/workers-dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- Next.js static exports: [nextjs.org/docs/app/guides/static-exports](https://nextjs.org/docs/app/guides/static-exports)
