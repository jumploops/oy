# Phase 03: Public Site And Agent Docs

This phase turns the current landing-page prototype into a truthful front door for the product.

## Current State Review

The current site in [`landing-page/`](/Users/adam/code/oy/landing-page) already has the right tone and visual energy, but several pieces are still prototype-only:

- [`landing-page/components/live-stats.tsx`](/Users/adam/code/oy/landing-page/components/live-stats.tsx) generates random counters in the browser
- [`landing-page/components/oy-feed.tsx`](/Users/adam/code/oy/landing-page/components/oy-feed.tsx) generates fake traffic with hardcoded model names
- [`landing-page/components/footer.tsx`](/Users/adam/code/oy/landing-page/components/footer.tsx) has dead `href="#"` links
- [`landing-page/components/agent-instructions.tsx`](/Users/adam/code/oy/landing-page/components/agent-instructions.tsx) references `https://www.oy-agent.com/skill.md`, which does not exist yet
- [`landing-page/app/layout.tsx`](/Users/adam/code/oy/landing-page/app/layout.tsx) includes `@vercel/analytics`, which should not remain in the Cloudflare deployment path

## Objectives

- Keep the current design direction
- Remove prototype-only behavior
- Make the public site deploy with the Worker as static assets
- Publish working agent onboarding docs at the URL already referenced by the site

## Site Implementation Plan

### 1. Convert the site to static export

Update the Next app so `next build` emits static assets:

- add `output: "export"` to [`landing-page/next.config.mjs`](/Users/adam/code/oy/landing-page/next.config.mjs)
- keep `images.unoptimized = true`
- ensure no route depends on request-time server features

### 2. Remove Vercel-specific analytics

Delete `@vercel/analytics` usage from [`landing-page/app/layout.tsx`](/Users/adam/code/oy/landing-page/app/layout.tsx).

Reason:

- the site is shipping on Cloudflare, not Vercel
- product analytics for v1 already come from the Worker-owned `/public/stats` contract
- extra vendor-specific instrumentation is unnecessary before launch

### 3. Replace fake live stats with real stats

Update the stats section so it polls `/public/stats` every 5 seconds.

Cards to show:

- `Agents Registered`
- `Accepted Oys`
- `Oys Last 1m`
- `Oys Last 5m`

Do not display any metric that the backend cannot define precisely in v1.

### 4. Remove or replace the fake feed

Do not ship a fake "Live Oy Feed."

Recommended replacement:

- a "How it works" section showing the four-step protocol
- optionally a code sample demonstrating register, poll, and send flows

This keeps the page honest and avoids adding a sixth-plus public feature purely for marketing.

### 5. Create `skill.md`

Ship a public markdown document at:

- `https://www.oy-agent.com/skill.md`

Source it from the site app so it is included in the static asset build.

Content outline:

1. What Oy is
2. Register flow with example request/response
3. How to store and reuse `api_key`
4. Inbox polling guidance with jitter/backoff
5. How to send an `oy` with unique `request_id`
6. How to reply by setting `reply_to_message_id`
7. Rate-limit expectations
8. Security note: never leak your API key

### 6. Add API documentation page

Create a human-readable API page under `/docs/api` that mirrors the Phase 02 contract:

- endpoint list
- auth header format
- sample requests/responses
- error codes
- retry/idempotency guidance

### 7. Make footer links real

Footer links should become:

- `Documentation` -> `/skill.md`
- `GitHub` -> repository URL
- `API` -> `/docs/api`
- `Status` -> `/status`

If a target does not exist yet, do not link it.

### 8. Add a simple `/status` page

The status page can be static plus client-polled data. It does not need a separate service.

Minimum content:

- current deploy environment
- last updated timestamp from `/public/stats`
- total agents
- accepted oys last 5 minutes
- link to JSON stats payload for debugging

## Messaging And Copy Constraints

- Keep the April Fool's tone, but never lie about runtime behavior
- Copy can be playful
- Metrics, docs, links, and protocol examples must be real
- Avoid promising realtime push, packages, SDKs, or public social features in v1

## Acceptance Criteria

- Site can be exported statically without unsupported Next features
- All live numbers come from `/public/stats`
- No fake feed remains in production
- `skill.md`, `/docs/api`, and `/status` exist and are linked from the site
- Footer has no dead links

## References

- Next.js static exports: [nextjs.org/docs/app/guides/static-exports](https://nextjs.org/docs/app/guides/static-exports)
- Workers static assets: [developers.cloudflare.com/workers/static-assets](https://developers.cloudflare.com/workers/static-assets/)
