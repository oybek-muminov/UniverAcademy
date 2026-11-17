# Native Telegram entry fixture provenance and limits

## Source
Read-only PostgreSQL catalog captures taken on 2026-11-17 for the authorized UniverAcademy project:
- `production-auth-extended-catalog.json`: function definitions and owners/ACLs, table/column/schema ACLs, RLS policies, role flags/memberships, domains, table CHECKs and triggers.
- `../account-deletion/schema-catalog.json`: columns/types/nullability and primary/unique/foreign-key constraints.

These artifacts contain schema metadata only. No account rows, tokens, passwords or private profile values were queried or exported. Captures were separate read-only queries, not one transactional catalog snapshot. They do not establish that a later live deployment still has identical metadata.

## Replay
`native-fixture.mjs` creates an empty disposable loopback PostgreSQL database schema. It replays actual captured helper SQL without rewriting bodies, domains, CHECKs, triggers, ownership, table/column/schema/function rights, forced RLS, policies and runtime membership. It does not replace authorization helpers or RLS with allow-all mocks.

Local role LOGIN flags are suppressed. Test connections start using the disposable fixture administrator and then set SESSION AUTHORIZATION to ua_api_login. Both session_user and current_user are restricted for runtime work. Runtime inherits the captured ua_runtime membership; NOBYPASSRLS and ownership boundaries are retained. Local administrator membership metadata is intentionally not replayed. Default expressions capture was null; the fixture rejects a later nonempty default list until its format is explicitly handled.

## Deletion integration phase
Baseline atomic-entry tests run before installing deletion SQL. `installDeletion()` then installs the review-only deletion candidate locally and explicitly grants its two narrow freeze-helper EXECUTEs to the captured roles, including effective SECURITY DEFINER owners. Those grants and candidate policies are **new local composition**, not claims about current production permissions. The runtime is never granted executor membership or direct deletion-job write rights.

## Evidence boundary
Native scenarios can establish real transaction rollback, deferred constraints, effective-role RLS, advisory/row-lock races and trigger behavior for the tested flows. They do not establish real Clerk network behavior, HTTP/UI wiring, production migration approval, retention policy, deployment, background scheduling or all possible writer interleavings. Provider liveness and proof construction in the test harness are controlled fixtures. Always report the actual scenario test results separately from these fixture capabilities.

No fixture operation is a live service mutation. A non-loopback URL is rejected.
