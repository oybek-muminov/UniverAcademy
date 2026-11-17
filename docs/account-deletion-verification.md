# Local verification ledger

Base main: `3d4afd1a55918775eb3cbd2da7a004e19d37a6b8`. New reconstruction, not recovered prior candidate. All provider requests simulated; no live account or production database changes.

Observed before public recovery host extension:
- Root TypeScript and Mini App TypeScript: pass.
- New deletion/atomic Telegram/client suites:149 pass,1 native test skipped without fixture URL.
- Dedicated native PostgreSQL17.11 runner:12 lifecycle assertions plus4 concurrent assertions pass. Temporary loopback database only, rich18-owned/5-shared catalog fixture. Production CHECK/default/trigger/RLS differences remain.
- Existing Cloudflare and Clerk regression:410 pass,1 skipped. Validator installed from committed lock before successful rerun.
- Existing and new selected-source guard:674 pass. Historic manifests retained byte-for-byte. Source guard fixture missing dependency copies corrected in test setup only.

Counts are snapshots, not a production-readiness score. Additions after this checkpoint must rerun their focused tests, typecheck and generated overlay check. No real Clerk reverification, deployment role ACL, provider domain API smoke or full browser end-to-end proof is included here.
