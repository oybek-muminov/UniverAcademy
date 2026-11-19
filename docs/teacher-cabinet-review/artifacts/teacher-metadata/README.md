# Narrow Teacher catalog subset (local review candidate)

Base project 3dbb714f2f758c7dbe03548a71c161718cf9cb53; candidate.patch adds a storage module only. It is not a working bootstrap metadata provider; no route, schema, grant, provider config, or runtime change.

Source evidence:
- tests/account-deletion/schema-catalog.json records only id/revision/status for ua_private.groups; no verified group title field. It records group_id/demo_id/version_id on assignments, and title/subject_id on demos, with assignment foreign keys to group, demo and version/demo. It has no subject display-label relation linking teacher_subject_approvals.subject_id to a canonical label.
- supabase/functions/univeracademy-api/storage/staff-first-test-rows.ts reads group id/revision/status and joins test_versions to demos for title and subject; this demonstrates the relational title source for demos, not for groups or subjects, and does not settle which assignments should appear in Teacher bootstrap.
- supabase/functions/univeracademy-api/storage/staff-access-rows.ts reads explicit nonrevoked group scope and active approved subject IDs under authoritative Clerk mapping. These IDs are not to be used as pretend labels.
- tests/telegram-entry/production-auth-extended-catalog.json shows existing student-domain assignment SELECT policy, not a complete Teacher catalog policy. A zero-row assignment query under a wrong role can still look successful. Verify separately before deployment; the candidate cannot assert those policies from the repository or use Student privileges to widen reads.

One parameterized read in a verified, existing Clerk-backed Teacher transaction repeats current enabled teacher mapping and approval, scopes groups by explicit unrevoked staff_group_scope, and joins actual group-bound assignments to demos with current approved teacher subjects. SQL does not read assignment bodies, version/question contents, student data, or expand scope. It returns only typed group IDs/status and assignment-linked demo metadata. Corrupt, out-of-scope, over-cap, or missing current authority rejects. A scoped assignment, draft, or unassigned test listing policy is not presumed; output always carries a partial marker and is unsuitable for a successful browser bootstrap. Do not add grants or placeholder labels.

Validation: exact reconstructed bytes, forward/reverse whitespace-strict git apply, and Node 24 stripped TypeScript syntax check. No fixtures, live SQL, deployment, or type check.
