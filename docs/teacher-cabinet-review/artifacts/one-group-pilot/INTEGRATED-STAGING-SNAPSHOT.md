> Public review copy: internal references were omitted. See the archive README for the current status.

# One-Fizika-group staging snapshot (offline, no draft work)


## Applied in order
```
01 one-group-pilot/one-group-pilot-assignment.patch
02 ordinary-presentation/ordinary-presentation.patch
03 ordinary-presentation/pilot/pilot-ordinary-numbers.patch
05 one-group-pilot/student-projection/pilot-student-projection-hardened.patch
06 one-group-pilot/staff-projection/pilot-staff-scope.patch
07 single-group-pilot-roster/candidate.patch
08 single-group-pilot-roster/locked-attachment-rows.patch
09 single-group-pilot-roster/opaque-preview-binding.patch
10 single-group-pilot-roster/attachment-receipt-minimization.patch
```
Only this numbered subset is applied. Mixed classifier 04 was inspected but left unapplied because it also recognizes draft editing and publication. Draft/bootstrap stack is omitted and source proposals remain untouched. Staff scope strengthens already-existing writer checks without mounting any route. Assignment/results are only for an already-published real test if one exists; no draft creation or seeded inputs. No account-deletion or registration changes.

From clean local sparse base:
```bash
set -euo pipefail
for n in 01 02 03 05 06 07 08 09 10; do
  git apply --check --whitespace=error-all "patches/$n.patch"
  git apply --whitespace=error-all "patches/$n.patch"
done
git diff --check
# To confirm restoration, in a disposable copy:
for n in 10 09 08 07 06 05 03 02 01; do
  git apply --reverse --check --whitespace=error-all "patches/$n.patch"
  git apply --reverse --whitespace=error-all "patches/$n.patch"
done
git diff --exit-code
test -z "$(git ls-files --others --exclude-standard supabase runtime)"
```

Reverified after narrowing: strict forward/reverse on all listed patches, exact pinned source restoration, then reapplied; all 10 staged TypeScript sources passed Node 24 stripped syntax. No compiler/full dependency checkout available, no runtime/type/fixture checks, live systems or remote changes.

## First blockers, not workaround authorization

Roster: exact private quota-limited existing-ID preview lookup and non-rebindable short-lived opaque permit store are not connected. The typed adapter exists but requires verified canonical Teacher+Student locks, actual scoped role/RLS completeness, and receipt/audit compatibility with unchanged current deletion guards. Group: real named group storage/provisioning and actual approved Fizika ID have separate offline proposals; no authorized writer is inferred here. Result: pinned Worker remains registration-only before the Student exam route and uses unavailable numeric scoring (runtime/cloudflare-entry.mjs lines 65–69, 96, 118). No staged patch mounts anything. No already-published real Fizika test was established in this offline review; keep the result route disabled without actual canonical evidence and a committed assignment pin. Do not substitute generic Admin, Student or deletion credentials.

## Patch hashes
```
$(sha256sum patches/01.patch patches/02.patch patches/03.patch patches/05.patch patches/06.patch patches/07.patch patches/08.patch patches/09.patch patches/10.patch)
```
