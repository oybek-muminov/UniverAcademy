> Public review copy: internal references were omitted. See the archive README for the current status.

# Teacher deletion: compatibility gate, not an erasure implementation

Pinned project main: `3dbb714f2f758c7dbe03548a71c161718cf9cb53`.

## Why a diagnostic only

- `supabase/proposals/account-deletion-rebuild.review.sql:87–93` rejects presence of staff access/identity/group/subject/teacher approval references or actor receipt and actor/target audit references. It tests staff group row presence, not whether the grant is currently active: marking it revoked alone cannot make the current guard pass. `deletion_write_barrier` also covers staff history; keep freeze and concurrency protections.
- The pinned catalog `tests/account-deletion/schema-catalog.json:550–650,1127–1180` lists audit actor, target and exact time, receipt actor, key, request payload and response. Receipt/audit have circular deferred foreign keys, and receipt actor is a non-null person FK; simply unlinking an audit actor is not the whole operation.
- The patch provides an internal v1 diagnostic only. It reports unknown unless it has complete authenticated, frozen, scoped evidence, and distinguishes active group rights, staff references and historical audit/receipt references. It does not publish data, approve deletion, change the old guard, or implement a retained record. A caller must not interpret the absence of a legacy blocker as account deletion authorization.
- No per-Teacher history projection is offered. A pseudonymous UUID, raw/digested command key, exact timing, group target, or individual count may still be joinable. Even an action-only entry can identify someone in a single-teacher pilot.

## Review gates for an eventual migration

1. Read only catalog metadata first: actual foreign keys, immutable triggers, write barrier, references in installed prepare/finalize and recovery functions, migration order, effective privileges, and deletion-time backups/logs. Do not assume the pinned fixture catalog matches deployed production. Inventory actor references *and typed person targets*, receipts' keys/payload/response, event timing and other correlators; legacy target IDs are polymorphic, so don't reinterpret them blindly. Check group-owned tests, histories and attempts are not reassigned or removed.
2. Design an exact authorized release operation under canonical person locks: release/detach only departing grants, leave other grants and memberships intact, permit no-successor, and never reinstate revoked grants on replay. Keep identifier verification, freeze, fresh Clerk auth, retention/recovery safety, and reauthorization. An active unclosed attempt is not a reason to mutate Student state in this operation.
3. If still identifiable in operational history, ensure reviewed deletion-time handling of linked audit *and* receipt pairs, including replay behavior and protected reference rewrites. Keep current block until verified. Any migration must prove no broken references, no lost unrelated history and no identifying data left in the proposed retained history. Define which artifacts are in scope and how pre-existing backups/logs expire or prevent reintroduction; a live deletion is not immediate erasure from immutable backups.
4. If retaining operational statistics is genuinely useful, separately review a fixed, coarse aggregate schema and whether it is non-reidentifying given cohort size and joins. Without evidence, retain no per-Teacher projection and do not represent it as anonymous. Do not set an arbitrary retention period or make legal assurances here.
5. Review with the owner before any actual privilege/migration/purge/account operation. Validate only using authorized real-account scenarios; no synthetic data or runtime acceptance was performed here.
