# Cloudflare Build Failure: 2026-04-01

## Status

The immediate `ERR_PNPM_CI_NOT_IMPLEMENTED` issue has been fixed in the repo by:

- renaming the root script from `ci` to `verify`
- changing [`worker/package.json`](/Users/adam/code/oy/worker/package.json) to call `pnpm run verify`

The ignored dependency build-script warning for `esbuild`, `sharp`, and `workerd` is still a possible follow-up issue if Cloudflare fails later in the build.

## Context

Cloudflare Workers Builds is currently configured with:

- root directory: `worker/`
- build command: `pnpm build:cloudflare`
- deploy command: `pnpm deploy`

The failing log excerpt is:

```text
> oy-worker@0.1.0 build:cloudflare /opt/buildhome/repo/worker
> cd .. && pnpm install --frozen-lockfile && pnpm ci

...

ERR_PNPM_CI_NOT_IMPLEMENTED The ci command is not implemented yet
```

Cloudflare also printed an earlier warning during `pnpm install`:

```text
Ignored build scripts: esbuild, sharp, workerd.
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

## Implementation At Failure Time

### Root workspace script

[`package.json`](/Users/adam/code/oy/package.json) defines:

```json
"ci": "pnpm typecheck:site && pnpm typecheck:worker && pnpm test:worker:unit && pnpm test:worker && pnpm build:site"
```

### Worker Cloudflare build script

[`worker/package.json`](/Users/adam/code/oy/worker/package.json) defines:

```json
"build:cloudflare": "cd .. && pnpm install --frozen-lockfile && pnpm ci"
```

### Deploy docs

[`docs/cloudflare-deploy.md`](/Users/adam/code/oy/docs/cloudflare-deploy.md) currently describes `pnpm build:cloudflare` as the command that installs dependencies, runs checks, runs tests, and builds the exported site.

## Findings

### 1. The immediate failure is script invocation, not application code

The current Cloudflare build command ends with `pnpm ci`.

In this environment, `pnpm ci` is treated as pnpm's own CLI subcommand, not as the root package's `"ci"` script. pnpm then fails with:

- `ERR_PNPM_CI_NOT_IMPLEMENTED`

So the build never reaches:

- root typechecks
- Worker tests
- Next static export build

This is a build-command bug in our repo setup, not a Worker or Next runtime failure.

### 2. Our docs are currently overstating what the build command does

The docs say `pnpm build:cloudflare` runs the full verification path. In practice, on Cloudflare it currently stops before any of that happens because `pnpm ci` never resolves to the script we intended.

### 3. There is likely a second issue waiting behind the first one

During `pnpm install`, Cloudflare/pnpm warned that build scripts for:

- `esbuild`
- `sharp`
- `workerd`

were ignored.

That did not cause the first failure, but it is likely to matter once the `pnpm ci` problem is fixed:

- `esbuild` is commonly needed by build tooling
- `sharp` is often involved in Next.js image/build flows, even when image optimization is disabled
- `workerd` is relevant to Wrangler / Worker-local tooling

At minimum, this warning needs to be treated as a likely follow-up blocker rather than noise.

### 4. The current monorepo layout is not itself the failing part

The root-directory strategy still makes sense:

- Cloudflare builds from `worker/`
- the script steps back to repo root
- the root workspace contains both `landing-page/` and `worker/`

The failure is specifically the choice of `pnpm ci`, not the workspace layout.

## Hypotheses

### Hypothesis A: The primary fix is to stop using `pnpm ci`

Most likely minimal fix:

- change the Worker build script to invoke the root script explicitly with `pnpm run ci`

This should allow Cloudflare to actually execute the intended root `"ci"` script.

### Hypothesis B: A more robust fix is to rename the root `ci` script

Even if `pnpm run ci` works, the current script name is easy to confuse with pnpm's own reserved command surface.

Stronger long-term option:

- rename the root script to something unambiguous such as `verify`, `check`, or `build:verify`
- have `worker/build:cloudflare` call that explicit script

This reduces future operator error and makes the build path more self-explanatory.

### Hypothesis C: Cloudflare will fail again until dependency build scripts are approved

Once the `pnpm ci` invocation is corrected, the next failure may be caused by pnpm's ignored build scripts.

Possible fixes to investigate:

- commit repo-level pnpm configuration that allows the required dependency build scripts
- use pnpm's approved-builds mechanism and commit the resulting config
- simplify the build flow if some install step is redundant and causing secure-install friction

This needs confirmation from the next Cloudflare build attempt after fixing Hypothesis A.

## Recommended Debug Order

1. Fix the build command invocation issue first.
   Replace the ambiguous `pnpm ci` call with an explicit script invocation.

2. Re-run Cloudflare build without changing anything else.
   That will tell us whether the next blocker is the ignored build scripts warning.

3. If the build then fails later during Next/Wrangler/tooling setup, address pnpm build-script approval as a separate change.

4. Update [`docs/cloudflare-deploy.md`](/Users/adam/code/oy/docs/cloudflare-deploy.md) after the final build command shape is confirmed.

## Current Best Guess

The first fix will almost certainly be:

- `pnpm ci` -> `pnpm run ci`

The second fix is probable but not yet proven:

- add pnpm build-script approval/config for `esbuild`, `sharp`, and `workerd`

No application runtime bug is indicated by the current Cloudflare logs.
