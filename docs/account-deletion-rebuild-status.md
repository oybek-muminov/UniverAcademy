# Account deletion rebuild candidate

Base: main 3d4afd1. This is a new reconstruction, not the missing prior candidate.

## Present
- Unmounted request coordinator with same-subject DB-port contract, verified Clerk liveness, explicit confirmation, hash-only receipt.
- Signed fva verification after existing issuer/azp/RS256 token verification. Conservative first-factor freshness: strictly less than five minutes including token age and minute-rounding upper bound.
- Recovery runner only claims durably accepted jobs. Provider target comes from trusted claim, not user input. Ambiguous outcomes remain frozen for retry.
- Fixed-origin bounded Clerk DELETE transport: redirect denied, exact response identity checked, timeout and body limit.
- Unmounted HTTP candidate checks origins, exact body shape, no receipt in URL and no-store responses.
- PostgreSQL request/recovery adapters enforce separate runtime roles and propagate uncertain commit outcomes.
- Additive unmounted UI controller/panel and fixed-origin HTTP port preserve recovery receipts through ambiguous failures.
- Review-only SQL proposal and embedded PostgreSQL lifecycle tests cover role separation, freeze, lease and owned graph cleanup. Native concurrency and complete race audit remain required.

## Not yet active or proved
No live code, DB, role, Clerk or account mutations have occurred. Existing ordinary entry routes are retained; exact deletion routes are now dispatched to a separate default-off request composition. No production readiness claim.

Before activation: verify deployed PostgreSQL adapter and actual scoped request/recovery roles, identity lock order, all write freeze guards, tombstone old-subject/replay guards, explicit owned graph cleanup, retention agreement, external Clerk self-delete reconciliation, exact migration/ACL review, recovery deployment, provenance guard/contract update, real Clerk cancel/account-switch/reverification E2E, and controlled main rollout. Old shared-device unsafe login remains in main until separately repaired.

A 404 status is unknown/expired, not proof of completed deletion. A failed request after uncertain commit may have created a job: retain receipt. Definite authorization rejection after confirmed rollback may clear only that new receipt, not the current cabinet session.

Clerk-only accounts are never enumerated or deleted. Staff/owner deletion is fail-closed pending an explicit shared-resource transfer policy. Account deletion preserves the existing ten-digit UniverAcademy IDs of other accounts.

## Sources checked
- https://clerk.com/docs/guides/sessions/session-tokens
- https://clerk.com/docs/guides/secure/reverification
- https://clerk.com/docs/reference/backend/user/delete-user

## Focused verification
`node --test tests/account-deletion/*.test.mjs`
`npm run typecheck`
No mock/unit result is a production end-to-end result.

Rebuild checkpoint verification: 78 backend/SQL test assertions and 27 client tests passed; root and Mini App TypeScript checks passed. Embedded PostgreSQL tests are not a substitute for native PostgreSQL concurrency/ACL verification.

Audit follow-up: provider transport now checks authenticated production instance ID and primary issuer domain under the same secret before each DELETE. Client fetch/body deadline preserves uncertain receipts. Staff audit/receipt actor and target writes freeze with ordered locks. Native PostgreSQL17.11 disposable fixture lifecycle (12 assertions) and concurrent races (4 assertions) passed using `node tests/account-deletion/run-native.mjs`; this does not establish production ACL/DDL parity or all graph/concurrency cases.

## Backend integration checkpoint
- Request paths now wired behind explicit default-off binding; status remains available when acceptance is disabled but request config remains.
- Scheduled-only recovery Worker uses its own restricted role, no HTTP-triggered recovery, bounded batch/timeouts and same-instance provider readiness.
- Additive atomic Telegram entry candidate verifies both identities before provisioning and commits linking/session/replay together. It is NOT mounted and does not yet remove the old two-phase fallback.
- New review OpenAPI fragment and exact source overlay preserve all historic manifest bytes. Generator `--check` and CI guards detect stale candidate pins; local regeneration is reviewable, never done silently in CI.
- Scope excludes new dashboard/layout. Deletion initiation controller/panel remain unmounted pending real Clerk reverification; minimal public receipt recovery is now routed before auth at /account-deletion-status, without a dashboard redesign.

Public recovery stores each request under its own device-local key to avoid cross-tab index overwrite. It exposes only generic status, never account identity or session cleanup. It requires explicit selection and polling and treats unknown/expired receipts as unconfirmed.

Receipt lifecycle audit correction: no artificial20-ticket limit; pending/unknown receipts are never forgotten. Only completed results can be explicitly forgotten, while definite pre-acceptance rejection or unsent partial write cleans its own receipt. Scoped and public index records both use per-request keys, protecting another tab’s concurrent request.46client tests pass, including adversarial read/remove interleaving.

## Atomic backend integration checkpoint
Explicit default-off atomic mode now routes /api/v1/auth/telegram/entry. A trusted configured subset of signed Clerk azp parties distinguishes Telegram Mini App from other web clients: old Telegram link is retired and old Clerk exchange excludes that subset when enabled. Header spoofing does not change signed azp. Existing production configuration remains unchanged.

Native PostgreSQL17.11 atomic suite9 assertions passed using captured helper/RLS/ACL/domain/CHECK/trigger definitions and restricted SESSION AUTHORIZATION ua_api_login. It covers provisioning/link/session commit, conflict/replay rollback, direct Telegram update denial, deletion freeze, completed-deletion old-subject barrier, re-register same Telegram with new Clerk, and concurrent different owners. Native run exposed and fixed locator context ordering before trusted Clerk scope. Deployment-time parity, broader race cases and real user-facing Clerk account choice/reverification remain gates.

## Existing auth UI integration checkpoint
Default-off VITE_TELEGRAM_ATOMIC_ENTRY now selects a separate atomic Telegram runtime within the existing sign-in card, not a dashboard redesign. It displays the chosen Clerk account, requires explicit confirmation, uses actual public @clerk/react useReverification and @clerk/shared reverificationError first-factor4-minute policy, then fetches an uncached token for the captured user/session. The mutation is outside SDK retries. Signed Telegram resume stays available; uncertain resume never falls back to new registration. Old two-step exchange/link is not constructed in atomic mode.

Canonical additive atomic client and identical owner copy are contract-hash pinned. Shared-device account changes invalidate pending verification or abort submitted work; a submitted outcome stays explicitly uncertain and late results cannot expose an abandoned cabinet. Independent review confirmed the final12 runtime tests. Actual Clerk modal/Google/Telegram browser E2E remains an activation gate; local compile and fixtures are not that proof.
