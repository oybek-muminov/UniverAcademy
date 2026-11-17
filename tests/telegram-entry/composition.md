# Atomic Telegram entry composition review candidate

No deployment flags, secrets, database grants or production resources were changed.

`UA_TELEGRAM_ATOMIC_ENTRY_ENABLED` accepts only own string `true` or `false`; absent/false preserves existing behavior and leaves `/api/v1/auth/telegram/entry` disabled. Enablement is a coordinated release gate, not included in this candidate.

When true, `UA_TELEGRAM_ATOMIC_AUTHORIZED_PARTIES` must be a nonempty JSON array of unique exact public HTTPS origins already present in `UA_CLERK_PROVIDER_SETTINGS.authorizedParties`. These values identify Mini App clients through Clerk's verified signed `azp`, never through a request body flag or an untrusted Origin header.

- New `/api/v1/auth/telegram/entry` verifies only the configured atomic parties, fresh signed Clerk first-factor proof, explicit account-link confirmation and Telegram launch signature. `TelegramClerkEntryRows` commits Clerk provisioning, Telegram mapping and replay consumption together. Resource cleanup precedes token acknowledgment.
- Legacy `/api/v1/auth/telegram/link` returns404 entirely in atomic mode.
- Legacy `/api/v1/auth/clerk` verifies only authorized parties *outside* the atomic subset. If no web parties remain, it returns404. A signed mini token cannot pass by changing Origin or headers. Legitimate signed web tokens retain their existing path.
- `/api/v1/auth/telegram/resume` is unchanged and continues signature validation.
- The atomic endpoint uses existing `HYPERDRIVE` auth credentials, not either deletion role. Existing bot token and Clerk settings remain required. Request scope has15-second total operation deadline and2-second bounded parallel cleanup; late factory results are closed, aborted work cannot enter DB afterward, and unknown commit/close results yield503 rather than token acknowledgment.

Local tests verify default off, signed party separation, spoofed Origin rejection, valid web persistence path, no private initialization on preflight/denied origin, body timeout, late factory cleanup and no ACK on cleanup failure. These are composition fixtures. Real UI account selection/reverification, production role/RLS/helper compatibility, production Clerk config and controlled E2E remain required before the flag can be enabled. The separate new dashboard/UI plan is not implemented here.
