# Temporary Telegram start navigation

This local candidate implements the owner's temporary instruction: accept the
validated Telegram start RPC input and return `{status: "needs_clerk"}` without
querying any database. It is **not evidence that a person is absent**. Existing
and disabled accounts are routed to sign-in too; this response never grants a
session, account, role, or data access. The real authentication API must still
enforce its policies.

## Scope and configuration

- The existing `runtime/cloudflare-worker.mjs` and named
  `TelegramAccountDirectory` entrypoint are retained; there is no second backend.
- `UA_TELEGRAM_START_MODE=registration_only` is a private deployment setting.
  Callers cannot select it in the RPC payload. Unknown values fail closed.
- Exact existing `telegramStartInput` validation is retained before the response.
- This mode performs no Hyperdrive access, PostgreSQL query, Clerk request, or
  identity/session write. It needs no database binding or secret.
- `wrangler.api.registration-only.jsonc` is a candidate configuration for
  `univeracademy-api`. Public workers.dev and preview URLs are disabled. The current
  production transition retains this build-target filename while pinning
  api.univeracademy.uz and explicit Clerk-first public settings. No temporary
  start mode is set. Private secrets and real-account acceptance remain gates.
- After separately approved deployment, the bot must bind
  `TELEGRAM_START_LOOKUP` to service `univeracademy-api`, named entrypoint
  `TelegramAccountDirectory`. Binding to `default` is incorrect.
- This change does not supply `MINI_SIGN_IN_URL` or `MINI_CABINET_URL`, create
  the Mini App, or complete registration. Those existing bot dependencies remain.

## Publication boundary

No upload, deployment, binding change or database change is authorized by this
document. Obtain approval for the exact target and content before publishing.
Verify the Cloudflare account and current Worker state first. Do not deploy this
candidate over a functioning full API without comparing its pinned public
settings and explicit resource bindings to the deployed inventory. The production transition now sets `keep_vars` to true
to preserve separately reviewed dashboard variables on main auto-deploys.
The explicit Hyperdrive binding is retained. This does not configure the full
API, preserve omitted resource bindings, or create any missing secrets. Secrets
require a separate name/type inventory; do not assume `keep_vars` clears them.

Use reviewed pinned Wrangler 4.160.1 tooling for packaging, not an unpinned npx
download. The main branch does not yet contain that tooling package.

## Returning to real lookup

Remove `UA_TELEGRAM_START_MODE` when deploying the reviewed full API/database
configuration. Absence retains the original database lookup behavior. Do not
leave this temporary setting in the full API environment: its strict environment
allow-list intentionally does not accept it. Restore database lookup only after
the function, runtime role/permissions, Hyperdrive connection and real-account
acceptance have been verified. Database errors must never trigger this interim
response as an automatic fallback.

## Verification limits

Static syntax, type and bundle validation do not prove live operation. Synthetic
accounts, IDs and fixture-driven tests are not run under the owner's current
restriction. A real `/start` through the existing authenticated Telegram webhook
and named binding requires separate live deployment approval and owner action.

### Local preparation result (2026-11-15)

Base main commit: `5e229a3c266e9f2107a72960e2f9cac6914d6b44`.

- Node 24.22.1 syntax checks for directory and Worker entry: passed.
- Repository `npm run typecheck`: passed.
- `git diff --check`: passed.
- Wrangler 4.160.1 `deploy --dry-run --no-autoconfig` with this configuration:
  exit 0; only `UA_TELEGRAM_START_MODE` listed as a binding.
- Bundle: 634410 bytes, SHA256
  `043b45ba3749abcdd162e6941c4b2216cca33adb634abe1b56a76d05e7231791`.
- Runtime/fixture tests, real Telegram calls, database calls, upload and deploy:
  **not performed**. No claim of production acceptance.

Dependency install initially failed because the default npm cache location was
unavailable; it succeeded with a workspace-local cache. Wrangler similarly
required a workspace-local `XDG_CONFIG_HOME`. Neither workaround changes code,
credentials or deployed settings.
