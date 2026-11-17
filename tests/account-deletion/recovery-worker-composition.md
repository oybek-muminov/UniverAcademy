# Recovery worker local composition

Entrypoint: `runtime/account-deletion-recovery-worker.mjs`.

Disabled unless `UA_DELETION_RECOVERY_ENABLED` is exactly the string `true`. Only a scheduled event runs recovery. All HTTP requests return404 and do not inspect bindings. No cron, routes, deployment config, secrets or database ACL were changed.

Required isolated bindings when enabled:
- `HYPERDRIVE_DELETION_RECOVERY`, using `ua_deletion_recovery_login`; no normal API/request binding fallback.
- `UA_CLERK_ISSUER`, exact reviewed issuer.
- `UA_CLERK_INSTANCE_ID`, independently reviewed production instance ID.
- `UA_CLERK_SECRET_KEY`, recovery secret. Every provider deletion validates its instance and domain binding.

One invocation owns a lazy native pg Client through the existing Cloudflare adapter, serial transactions, at most3 jobs,20-second execution deadline and3-second cleanup deadline. A provider timeout or DB/close uncertainty rejects the invocation with sanitized diagnostics; durable jobs remain frozen for subsequent scheduled recovery. If provider completion occurs after an execution timeout, DB finalization cannot proceed through the aborted adapter; the next invocation must reconcile it through the same instance-bound provider check.

Before activation: audit explicit recovery-only SQL function grants and effective role, cache-disabled Hyperdrive with verified origin TLS, bundle compatibility, true native PostgreSQL lease concurrency, actual read-only Clerk readiness, scheduled frequency/monitoring, and request/UI integration. This composition's simulated tests establish none of those production settings.
