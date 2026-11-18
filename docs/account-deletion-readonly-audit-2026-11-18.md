# Read-only production catalog audit and next gates

Date: 2026-11-18 UTC. Project: univeracademy-mvp. Scope: catalog SELECTs through the connected Supabase service only. No user rows, credentials, function bodies containing possible secrets, or connection strings were retrieved. No DDL, DML, role switch, login change, deployment, push, Clerk request or account deletion was performed. Function definitions were compared by hash on the server without returning bodies.

## Verified baseline

- PostgreSQL 17.11. No deletion roles and no deletion-named relations installed.
- 30 private base tables, all with RLS and FORCE RLS.
- Captured columns/types/nullability: no missing/changed or added columns.
- Base captured PK/unique/FK constraints: no missing/changed entries.
- 15 captured functions: definition hash, owner and ACL match; no additional private functions.
- 28 captured non-internal triggers: definition hashes match; count matches.
- 61 policies: no changed/missing/added policies.
- 30 table ACL/owner/RLS and 42 column ACL entries: match; count matches.
- 37 table CHECK definitions, 3 domain definitions/CHECKs and schema owner/ACL match. No column defaults present.
- All seven application roles and eight membership edges match the existing snapshot. Managed postgres has ADMIN-only membership edges; it has no INHERIT/SET authority through those edges. ua_api_login inherits ua_runtime with SET and ADMIN disabled.

The 49 constraints absent from the lightweight deletion fixture were not newly discovered production drift: 37 table CHECKs + 3 domain CHECKs + 9 constraint triggers are present in the extended auth snapshot. They were not installed by the simplified deletion fixture.

## Expanded local parity test

`schema-production-parity.test.mjs` now replays the existing complete captured auth catalog using `nativeFixture`, then installs our deletion SQL and exact ACL proposal, WITHOUT the older fixture's broad helper grants. It runs the actual request/recovery TypeScript adapters as their restricted roles.

All 49 previously omitted constraints are installed and active. Negative cases prove invalid domain values, malformed profile JSON and a deferred missing Clerk family binding fail. A target with both active and historically revoked families can be prepared and completed under real RLS/helper ownership/constraints; historical revocation is preserved and another student's profile remains byte-identical. Native parity assertions after populated-education follow-up: 6/6 pass. Total deletion native assertions: 33/33. General suite: 104 pass, 3 native-only skips; TypeScript and whitespace checks pass.

The populated-education follow-up now seeds two students with real frozen assignments, pinned question/option order, submitted attempts, answers, ordinary results, current/official exam-series pointers, bonuses, cancellation records, command receipts and grants. All captured CHECK/domain/projection/history triggers remain enabled. Invalid terminal-answer writes and result-history rewrites reject. Pending deletion freezes attempts/results/grants. Restricted recovery deletes all eight owned education record types for the target while byte-for-byte preserving the other student's records and all five shared tables (groups/demos/test_versions/draft_questions/assignments). Deferred attempt-series/result constraints and FK cleanup passed without a production SQL change.

This closes the previously noted populated education-graph gap for this representative submitted-attempt scenario. It is not exhaustive across every attempt status, recovery generation, lifecycle transition or concurrency combination. Real-provider E2E remains separate.

## Other-schema exposure

For anon, authenticated and ua_api_login, catalog checks found no external view/materialized-view dependency on ua_private and no external SECURITY DEFINER body containing the literal ua_private schema name. The one reachable public definer is `rls_auto_enable`, owned by postgres with search_path=pg_catalog; it returns event_trigger and has an event-trigger binding. Its EXECUTE ACL alone is not evidence of a callable ordinary RPC. It was NOT invoked.

Supabase-managed storage/realtime tables and two extension views have effective grants for anon/authenticated. Those grants alone do not establish accessible rows or a vulnerability; their RLS and platform behavior were not fully audited here. ua_api_login had no comparable other-schema table/view access in this scan.

Limitations: literal-reference and dependency searches do not prove absence of indirect/dynamic SQL bridges, extension behavior or public API exposure settings. This is a focused application-schema audit, not a database penetration test or database-wide safety certificate. Newly provisioned deletion logins do not exist yet, so their actual live effective grants cannot be tested until a separately approved installation. Public inheritance must be rechecked then.

## Credential/binding preparation, not performed

1. Review a managed-Supabase ownership/creator plan. Do not paste fixture SQL into production: it is isolated-only and its role placeholders are NOLOGIN. Preserve managed ADMIN-only memberships; do not grant runtime executor membership or switch power.
2. Approve provision of two separate login identities matching `ua_deletion_request_login` and `ua_deletion_recovery_login`, with distinct strong credentials and only reviewed role attributes/ACLs. Store credentials through the approved secret manager/Hyperdrive setup, never chat, source, command history, logs or frontend variables.
3. Configure separate `HYPERDRIVE_DELETION_REQUEST` and `HYPERDRIVE_DELETION_RECOVERY` bindings with origin TLS verify-full and caching disabled. Validate actual authenticated current_user and full preflight using each binding. Request and recovery must not share a broad ordinary API connection.
4. Request needs reviewed `UA_CLERK_PROVIDER_SETTINGS` and server-only `UA_CLERK_SECRET_KEY`. Recovery additionally pins `UA_CLERK_ISSUER` and `UA_CLERK_INSTANCE_ID`. Confirm instance/domain readiness read-only with the actual server credential, without revealing its value or invoking user DELETE.
5. Keep SQL accepting=false, `UA_DELETION_REQUEST_ENABLED=false`, `UA_DELETION_RECOVERY_ENABLED=false`, and `VITE_ACCOUNT_DELETION_ENABLED` off until gates pass. Status must remain available for accepted receipts if submissions are later disabled. Scheduler setup, deployment and feature activation require their own approved change.

## Real Clerk/browser E2E plan, not performed

- Verify canceling reverification creates no accepted job and no provider request.
- Verify switching Clerk user/session or cabinet during verification cannot submit against the old identity; stale first-factor proof rejects and a fresh uncached same-session token succeeds only after explicit confirmation.
- Test Google/password/other configured sign-in methods, multiple tabs, lost response, duplicate receipt retries, session revocation, refresh, signed-out public status and unknown/expired receipt handling.
- Test wrong issuer/instance, readiness failure, DELETE timeout, stale lease, worker retry, provider-confirmed not-found and database-finalization failure using isolated fixtures or a specifically approved disposable environment.
- The existing recovery transport explicitly requires a production Clerk instance. Do not weaken that guard merely to make a development test pass. A development-only harness would need separate explicit implementation/review; any real production disposable-account deletion requires fresh concrete approval of that account and action. No such approval or destructive test is assumed here.
- End-to-end completion must prove provider state, exact local graph cleanup, tombstone replay rejection, unrelated-user preservation and recovery receipt status, not just a UI success message.

## Official guidance checked

[Supabase API security](https://supabase.com/docs/guides/api/securing-your-api) distinguishes grants, RLS and exposed schemas. [Clerk reverification](https://clerk.com/docs/guides/secure/reverification) documents step-up authentication for sensitive actions. Our tighter freshness checks and staged activation gates are application-specific choices, not claims of automatic provider guarantees.

## Cloudflare deployment readiness, read-only follow-up (2026-11-18)

Observed through GET-only Cloudflare API calls; no configuration, credential,
deployment, schedule or data writes. Secret values were not printed or retrieved.

- Live Worker inventory: `univeracademy-api`, `univeracademy-bot`,
  `univeracademy-mini`; no deletion recovery Worker.
- Exactly one Hyperdrive exists, `univeracademy-api-db`, bound as normal
  `HYPERDRIVE`. Origin role `ua_api_login`, Supabase direct PostgreSQL port 5432,
  database `postgres`; query caching disabled and origin TLS `verify-full` with
  an existing CA certificate reference. Preserve this connection unchanged.
- Neither deletion Hyperdrive nor either deletion binding exists.
- API settings contain no `UA_DELETION_REQUEST_ENABLED` or
  `UA_TELEGRAM_ATOMIC_ENTRY_ENABLED`. Absence is not explicit `false`; candidate
  semantics keep deletion routes unavailable when the request flag is absent.
  Live deployed code identity was not inferred from settings.
- API `UA_CLERK_SECRET_KEY` secret binding exists. This proves name/presence only,
  not its value, validity, instance match or ability to copy it to a new Worker.
- API issuer is `https://clerk.univeracademy.uz`; authorized party and allowed
  origin are `https://mini.univeracademy.uz`; API origin is
  `https://api.univeracademy.uz`. Preserve existing audience/session/provider
  policy rather than replacing it with guessed defaults.
- API and Mini schedules are empty. Mini has no runtime bindings and uses static
  assets; this does NOT establish Vite build-time flags. No Pages project exists.
- The repository `production-guards.yml` uses a deletion-enabled build for CI;
  that is not evidence of the live Mini build's deletion flag.

### Remaining sequence and owner involvement

1. Obtain the exact upload approval for the reviewed source package, excluding
   historical synthetic fixture additions. Obtain a separate reviewed maintenance
   and deployment authorization. Recheck database fingerprint and backup/restore
   readiness immediately before the approved change; do not assume an existing
   encryption-key test proves that production database backup is restorable.
2. Apply managed migration only in approved quiet window: accepting=false,
   guards_active=false, 31 guards disabled, request/recovery roles NOLOGIN. Read
   catalog postflight rather than creating fake rows or invoking deletion work.
3. Provision two distinct strong DB credentials and enable LOGIN only for the
   dedicated request/recovery roles; create two new Hyperdrives with cache disabled
   and verified origin TLS, reusing the validated existing CA reference where
   supported. Never reuse ua_api_login or the admin credential for deletion.
   Credential creation/storage requires the owner's scoped authorization, but
   passwords can be generated and transferred securely without asking the owner
   to invent or paste them into chat. Runtime receives Hyperdrive bindings, not
   raw database passwords in code.
4. Prepare/review a dedicated recovery deployment configuration (currently absent):
   entry runtime/account-deletion-recovery-worker.mjs, only its five allowed env
   bindings, disabled flag, no initial cron and no public trigger route. Preserve
   API's existing env/services/secrets and attach only request Hyperdrive/flag.
5. The new recovery Worker needs the correct Clerk production secret. Existing
   Worker secret-name visibility is not a secret-copy facility. First locate an
   already-authorized secure source/provisioning mechanism without exposing it;
   only if unavailable ask the owner to enter that one secret directly into the
   approved secret destination. Do not rotate the existing key just to recover
   its value. Do not ask the owner for issuer, instance ID, role names, origins or
   CA details already verified through connected sources.
6. Independently verify Clerk /instance and /domains using that SAME recovery
   credential with GET only. Do not invoke createClerkDeletionTransport as a
   readiness probe: its normal successful path proceeds to DELETE /users/{id}.
   Connected Clerk app metadata alone does not prove this deployed secret matches.
7. Deploy API/recovery disabled after approval. Verify deployed metadata, exact
   permissions, status routing, redacted logging and Mini build provenance.
   Guard activation is a separate approved quiet-window step: NOWAIT table locks,
   exact fingerprints/writer ACL audit, zero jobs/tombstones, accepting remains
   false. Observe only authorized genuine project activity, no synthetic records.
8. The owner signs into the already-selected real test account and performs
   genuine re-verification/cancel/status navigation. Coordinate atomic-entry
   API+Mini rollout if required; no half-updated old/new authentication pairing.
9. Only after same-key Clerk readiness, monitoring, guard activation and recovery
   configuration are verified should scheduling and acceptance/UI be enabled in
   an approved coordinated window. Check pending jobs before enabling scheduling.
   Account-specific irreversible deletion still needs fresh explicit confirmation.
   Empty-history rollback is valid only before any accepted job/tombstone; after
   that keep guards/status/reconciliation and stop new acceptance, not protections.

The only unavoidable owner inputs should be scoped approvals, possibly one direct
Clerk-secret provisioning step if no authorized secure source exists, genuine login
interaction, and the eventual exact-account irreversible-deletion confirmation.
No production state has been changed by this audit.

## Telegram bot / Mini deletion follow-up

Read-only source inspection and live code/asset GETs, without submitting Telegram
updates, synthetic proofs, account actions or deletion requests:

- Bot accepts private `/start` navigation, not a `/delete` account command
  (`apps/telegram-bot/src/worker.mjs:109`). `deleteMessage` in bot code deletes old
  login messages, not platform accounts. Current bot routes users to the Mini
  cabinet/sign-in and has the lifecycle Durable Object enabled.
- Local Mini common and atomic entry mount `AccountDeletionHost` around the
  StudentApp. Dashboard button -> 10-digit cabinet ID confirmation -> same
  Clerk user/session first-factor reverification -> fresh token -> POST
  `/api/v1/me/deletion` with app bearer, Clerk token and persisted receipt.
  The ID entry is a UX confirmation, not authoritative authorization. Server
  verifies the proof/liveness and exact database person/identity/session binding.
- A Telegram-resumed cabinet without an active Clerk session cannot delete:
  the host asks the user to sign into Clerk again. This is intentional protection,
  but the current unavailable dialog does not itself provide a direct sign-in
  action; owner-approved real Telegram UI navigation must verify this handoff.
- Cancellation is allowed before submit; after submit it must not claim rollback.
  Ambiguous network outcomes go to receipt-based status, not repeated POST.
  Receipt route survives logout locally; completion is only from server status.
- Live API Worker download contains deletion route and flag code. Live bot code
  does not contain that route. Code presence is not activation or release parity.
- Live Mini index referenced `/assets/index-C7lqFBWT.js` and
  `/assets/common-production-entry-CebUOPh2.js`. Their public compiled env includes
  common auth, Clerk SDK and Telegram SDK but omits deletion-enabled and atomic-entry
  flags. The delivered common code checks both against explicit `true`, so those
  features are disabled in this inspected release. It contains deletion UI and
  the disabled-state explanation. No browser/login interaction was performed.
- API deletion flags/bindings and the recovery Worker remain absent as noted above;
  therefore a delivered button is not an operational deletion service.

### Concrete remaining bot-facing gap

Deletion recovery currently has no Telegram menu reconciliation notification.
`runtime/telegram-menu-completion.mjs` only handles successful auth link/entry/resume;
its paths do not include deletion, and recovery's strict five-key environment has
no bot service binding. Lifecycle polling stops after tracked login messages are
cleaned, so it cannot guarantee automatic menu refresh for a long-registered user.
After a future completed deletion, an old `Kabinet` menu/button can remain until
`/start` or another reconciliation. This is stale navigation, not continued account
access: authoritative lookup/session checks still deny or route to sign-in.

Minimum initial UX: after confirmed completion clearly instruct the user to return
to the bot and send `/start` for a fresh sign-in button. A seamless automatic menu
refresh requires a separately reviewed, authenticated backend-owned notification
that retains the trusted Telegram destination before unlink; do not accept a
client-supplied chat ID or casually add secrets/bindings to the recovery Worker.
This audit changes documentation only; it does not implement either behavior.

### Prepared minimum menu-recovery UX candidate

Two existing UI panels now show `/start` instructions only after confirmed
`completed` status. Public recovery wording is conditional because a saved receipt
can belong to a different account. No automatic Telegram messages, RPCs, new
credentials, files or data were added. TypeScript compilation is not claimed:
Mini dependencies/compiler are not installed in this workspace. Diff whitespace
check passed; no behavioral fixtures were run.

Static impact analysis:
- Long-registered user: receipts and menuDue may be empty; no alarm remains.
  Completed deletion alone cannot update the visible menu. `/start` performs an
  authoritative lookup and schedules the current menu plus fresh sign-in message.
- User with pending menu/login cleanup: a later alarm can refresh the menu, but
  this is contingent, not a guaranteed deletion notification.
- During pending deletion: old cabinet navigation may remain visible, but frozen
  session/access checks govern access. Do not call it completed or direct the user
  to create a replacement before server completion.
- Telegram outage/rate limiting: `/start` delivery/menu update may be delayed;
  bounded retry exists. Do not promise immediate disappearance of every historic
  chat message/button or cancellation of a completed account deletion.
- Public receipt from another account: no implicit current-account logout/menu
  modification is performed by this UI; the user chooses whether `/start` applies.
- Any old cabinet URL/button remains navigation, not an authorization capability.

A future automatic solution should persist a trusted Telegram recipient in a
short-lived, least-privilege menu-refresh outbox in the deletion transaction before
unlinking, then deliver an authenticated internal reconciliation after completion.
It must re-read current navigation (protecting re-registration races), retry
idempotently, retain no unnecessary identity history, and not make account deletion
completion contingent on Telegram delivery. This requires explicit schema/ACL,
worker binding, retention and failure-policy review. It is not implemented by this
small UX patch and must not be slipped into the approved SQL package.

### Deployment preparation update

A disabled `wrangler.account-deletion-recovery.jsonc` candidate is now prepared;
prior references to its absence describe the earlier audit point. JSONC parses,
cron/routes are empty, public/preview URLs disabled, and recovery flag is false.
Root `npm run typecheck` passed. The owner explicitly removed separate backup
completion as a gate for independent implementation work. No backup jobs,
production settings or accounts were changed.
