# Review-only PostgreSQL candidate

No production migration, grant, account deletion or live provider request has been performed. The SQL requires an isolated-fixture setting and creates a disabled control flag. Do not enable it on production merely because these tests pass.

## Evidence
Run from repository root:
`npm ci --prefix tests/account-deletion/tooling --cache /tmp/ua-npm-cache`
`node --test tests/account-deletion/schema-lifecycle.test.mjs`

PGlite 0.5.16 runs embedded PostgreSQL. The fixture uses read-only production catalog column/type/nullability and primary/unique/foreign-key definitions. Domains are simplified to bigint/text. It does NOT replicate production CHECKs, defaults, baseline RLS policies, existing triggers, ownership or function bodies. It verifies disabled-by-default operation, exact Clerk/session matching, stale proof rejection, role split, freeze and rejected writes, leased provider ordering, other-person preservation, shared-group preservation, Telegram ID reuse, old subject/proof replay rejection and receipt expiry. No real provider is contacted.

## API and trust
Only the trusted server verifies JWT issuer, subject, sid, liveness and recent re-verification. SQL rechecks matching current student access digest and Clerk mapping with database time (not in future; strictly within five minutes). A retry needs the exact opaque receipt digest and fresh verified identity. Digests must be generated server-side from secret high-entropy receipt/access values; clients never choose database identity parameters.

Prepare takes identity advisory lock, mapping row and person row. Finish reads immutable target, then same locks and the job row; it rechecks lease after locks. Claims serialize on job only. Marker and finish require an unexpired lease. Recovery target comes solely from the durable accepted job, never request input.

Executor is NOLOGIN/NOBYPASSRLS with exact table rights. No request/recovery ACL grants are shipped. Runtime must never inherit executor. Invoker write triggers call a narrow definer guard; an audited integration must grant existing writers EXECUTE on assert_deletion_writable, not executor membership or direct job/table access. Without the helper grant, ordinary writes fail closed.

## Activation blockers
1. Independently audit all current writers, trigger composition and privilege ownership against full production DDL. Dynamic freeze triggers cover the known student/person graph, not all possible future tables. Staff deletion is deliberately rejected. Staff audit/receipt ownership retention needs a separate design.
2. Native PostgreSQL17.11 fixture passed lifecycle12 and concurrent4 assertions via `node tests/account-deletion/run-native.mjs`: late profile/staff-target writes wait and reject, stale lease is fenced, finish waits behind prepare retry without inverse job lock. Remaining native PostgreSQL multi-connection races: delayed login vs prepare; prepare/finish/claim; late answers/access/replays; re-registration with original Telegram ID; unique-conflict replay insertion after delete; and updates moving ownership between profiles. PGlite's single connection alone does not prove concurrency, and the four native assertions do not cover every race family. Lock inversion with arbitrary preexisting child-row locks can abort a transaction; retry policy needs verification.
3. Fixture now populates all18 owned student tables and5 shared tables for two profiles, including deferred attempts/exam_series cycles. Exact other-person/shared surviving-row comparisons pass. Native delayed-child insertion during final deletion and missing-parent FK rejection pass. Production CHECK/default/trigger/RLS parity remains required.
4. Permanent records include issuer/subject, person UUID, receipt digest and proof digests. Review retention/privacy strategy before activation. Completed receipt status expires after 24h, tombstones currently do not.
5. Test provider retries and identity tenant boundaries against approved provider test strategy; UI re-auth/confirmation, CSRF and deployed recovery scheduler are not established by SQL tests.
6. A provider-deleted job must never be un-frozen. Failures preserve it for recovery and do not report completed. Only provider-confirmed deletion/not-found from the correct tenant authorizes marker.
7. Production RLS catalog parity, managed role ownership permissions, backup/recovery, operator monitoring and independent review are mandatory gates. This candidate is not a production migration.

## Staff-reference freeze follow-up
The invoker trigger also covers staff_audit and staff_receipts. Its separate helper collects all OLD/NEW actor_id and target_id values, locks existing people in sorted UUID order, then rejects any deletion-job reference. Existing staff references still reject prepare; unrelated staff records are preserved. Grant the helper EXECUTE to effective staff writers only after the same ACL audit. Tests include the circular receipt/audit FK pairing, preexisting target rejection, late actor/target inserts and retargeting. Native races remain a separate gate.
