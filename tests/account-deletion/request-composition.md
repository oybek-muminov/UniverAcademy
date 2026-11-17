# Deletion request composition (local review candidate)

The API entry recognizes only `/api/v1/me/deletion` and `/api/v1/me/deletion/status`, before legacy CORS so the deletion-specific Clerk/receipt headers work. No deployment/environment change is included.

- `UA_DELETION_REQUEST_ENABLED` is an own string value: absent means no endpoint acceptance/status; `false` disables submissions but preserves receipt lookup; `true` permits validated requests.
- `HYPERDRIVE_DELETION_REQUEST` is a separate platform binding whose actual login must be `ua_deletion_request_login`. No recovery pool or provider delete is used here.
- Submit uses existing `UA_CLERK_PROVIDER_SETTINGS` and `UA_CLERK_SECRET_KEY` through the existing authenticated Clerk adapter. It then verifies the identical signed token's fresh first-factor `fva`, and current liveness, before same-identity locked prepare.
- Status needs no Clerk secret/session; it uses only a random256-bit receipt hashed server-side. Unknown or expired status is not completion.
- Origin rejection, OPTIONS, invalid body and disabled submission do not initialize private resources. Request status when disabled is deliberate recovery access, not new deletion authority.
- Each operation has a15-second deadline plus at most2 seconds for owned cleanup. Late factory resolution is closed; after abort, no delayed verification/liveness continuation can call prepare. Both DB and Clerk close are attempted before any ACK. Failed/unknown cleanup returns sanitized503, not completion.

Actual request-role ACL, Hyperdrive caching/TLS, migration, production Clerk shape and end-to-end checks remain activation gates. Existing Cloudflare PostgreSQL adapter sanitizes driver errors: even a narrow SQL rejection may become503. This preserves uncertainty safely but may require operator diagnosis rather than presenting a definite UI rejection. No unsafe broad SQL-error exposure was added.
