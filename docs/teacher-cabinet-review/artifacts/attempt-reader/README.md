# Current exam continuity database reader (local candidate)

Apply candidate.patch to the canonical project checkout with the earlier cabinet-entry decision patch. It adds only the internal storage module, not an HTTP route, schema change or permission change.

Route composition may call readCabinetCurrentSeries(tx, binding, signal) from the existing person-locked Clerk-bound transaction, after its current-provider/family lease and verified Clerk binding and domain phase are established. Recheck existing liveness, expiry and cancellation before response and commit. The earlier student profile transaction opens domain phase after invoking its callback, so do not repurpose that callback for this read.

Uses one parameterized SELECT, existing scoped grants, a database-clock reading, and only current series and attempt scalar metadata. It neither uses group admission as authority nor loads answers, frozen tests, history, or writes expiry. Missing, inconsistent or oversized projections are unknown. The scoped anchor distinguishes a legitimately empty series list from a wrong context. Independently verify exact live role and policy parity for exam_series and attempts before activation: changed RLS could suppress otherwise present rows. GUCs assert consistency, never authenticate. SQL errors propagate; never reinterpret them as an empty projection.

Privileged staff read stays a separate blocker; no staff lookup, raw bearer SQL transit, generic credentials, GRANT, or migration. Do not wire a placeholder or widened staff read.

Static checks: forward/reverse whitespace-strict patch application, exact reconstructed-file comparison and Node 24 stripped TypeScript syntax parse. No SQL or runtime executed; no fixtures or live data used.
