# Read-only cabinet pilot: offline approval checklist

Private source checkpoint: `6d40560f5aa71e13d3562076be8e38b2d382eeaa`. Covers only Student-authenticated `GET /api/v1/me/cabinet-access`: `{data:{person_id,default_cabinet}}`. Not activation approval.

## Exact minimum and isolation

The second connection runs one bounded parameterized `SELECT EXISTS` by a verified `person_id, issuer, subject`. It needs schema `ua_private` USAGE, not CREATE, and only the following column SELECT privileges, with approved effective SELECT policies:

| Relation | Required columns |
|---|---|
| `people` | `id, enabled, roles` |
| `clerk_identities` | `person_id, issuer, subject, enabled` |
| `staff_access` | `person_id, approved` |
| `teacher_subject_approvals` | `person_id, approved, revoked_at_ms, subject_id` |

The predicate checks matching enabled Clerk identity, enabled person, Teacher role, staff approval and at least one approved, unrevoked, nonempty subject. No witness rows, subject lists, writes, broad SELECT, or second lock. This connection sets no Student phase/context variables. Do not copy Student GUC policies or treat mutable labels as identity. A dedicated database login can read its granted columns across RLS-visible rows, so the Worker-only binding and audited query are part of the privacy boundary, not proof of per-person DB enforcement. If the reviewed policy cannot provide complete evidence without unapproved access, leave the feature disabled.

Do not change existing Student grants or add staff access. Verify single-person Student `domain` RLS covers `people(id,enabled)`, `clerk_identities(person_id,issuer,subject,enabled)`, `exam_series(id,person_id,demo_id,current_attempt_id,generation)`, and `attempts(id,person_id,demo_id,generation,body)` for matched current attempts. Auth-phase RLS can suppress attempt rows and cannot prove absence. Missing, orphaned, contradictory or unreadable evidence cannot allow Teacher. Outer person lock and Clerk liveness/lease are checked before, after, and again before commit; independent connection snapshots are not atomic.

## Missing approvals vs unfinished delivery

- **Database approval:** exact dedicated role, column grants/policies and inherited/PUBLIC access, distinct unprivileged principal, no ownership, bypass, mutating permission, role escalations or unsafe function execution. Check Student requires no broader staff grant. Companion local SQL checks catalog metadata only, not real RLS visibility, platform-resolved identity, or every privilege outside the private schema.
- **Infrastructure approval:** exact private Worker-only binding and resolved principal, verified upstream TLS/no query cache, bounded abort/disposal and log redaction. The DSN username check prevents accidentally equal configured role names only. Dedicated client is lazy/request-owned, one read followed by release/discard and awaited close; no raw bearer/digest, family or Clerk session ID crosses to it. Verify this on the actual driver before activation.
- **Pilot approval:** exact environment, deployment/rollback configuration, named owner-designated account set and allowed actions; no role change, grant, main update or deployment is authorized by this checklist.
- **Incomplete functionality:** separate Clerk browser destination, complete authorized metadata/titles and browser transport, and the 650 ms routing budget require implementation/real measurement. Appointment is deferred; use an already authorized teacher if one exists, otherwise teacher-positive checks cannot run yet. Teacher group/test operations are separate. A routing pass is not a completed cabinet.

## Real-account validation, only after approval

| Case | Expected outcome |
|---|---|
| Default-disabled/no adapter | Exact GET no-store 503; no capability connection; Student/deletion unaffected. |
| Verified Student without Teacher approval | Own person and `student`; no rotate/relink/clear. |
| Existing approved Teacher with authorized subject and no active attempt | Own person and `teacher`; browser independently verifies same account and scope; no proof in URL. |
| Existing active attempt; reopen after group admission closes and before personal deadline | Student path, same attempt ID/generation, saved answer and original deadline; no reset. |
| Revocation, mismatched session, or delayed result after identity switch | No Teacher display or stale result, no proof/log leakage. |
| Missing/unreliable/late capability or attempt evidence | No Teacher hint, preserve safe Student path and check disposal. |

The companion `cabinet-acl-audit.sql` is offline, read-only and uses explicit placeholders. Do not execute it, use SET ROLE, configure a live binding, inspect application rows, or deploy based on this artifact alone.
