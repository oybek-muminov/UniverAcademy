# Telegram cabinet activation

## Source PASS; production HOLD

Reviewed runtime/integrity correction R2 is published on main at
192d4a1fe0c7857d9fa5c6f6228356266c17668e. Source acceptance does not establish
production authentication, database readiness or deployment acceptance. This
hosting/documentation addition requires its own review. API/Bot automatic release
holds remain controlled by the integration owner; this document does not lift them.

The current product direction is Clerk-first registration and login. Retain the
reviewed Telegram-only work as historical material; do not deploy its entry,
ensure/provisioning flow, SQL/configuration or temporary registration_only mode.
Any new Clerk-first source delta must be reviewed against the current main.

## Existing flow to reuse

1. The bot validates webhook/private-human ingress and uses its private directory
   for navigation only. A recognized Telegram ID or lookup result is not a login
   and does not authorize cabinet data.
2. The button opens our Mini frontend /sign-in. Existing Clerk prebuilt SignIn
   with SignUp handles credentials. An active, task-free Clerk session enables
   explicit Continue, which obtains a fresh default SDK JWT for Backend exchange.
3. Backend verifies the configured issuer, authorized party, audience policy and
   current provider session/user liveness. It maps the verified issuer+subject to
   the canonical platform person or safely provisions a new person. Never match
   accounts by email/name, fabricate identities or expand student/staff access.
4. Keep the issued opaque project session and read /me. Existing server-derived
   names, registration_complete gate and authorized PATCH /me drive the existing
   profile form/cabinet. Preserve edited names, same-person/session checks and
   pending-call deduplication. An authorized empty exam list is valid.
5. Telegram linking requires a fresh Clerk JWT AND exact fresh signed initData;
   Backend verifies both. Same verified pair is idempotent; conflicts never
   rebind/merge identities. Link does not mint a session. Keep the exchange-issued
   session; do not immediately resume with the proof consumed by linking.
6. Returning Telegram entry may use only the separately reviewed valid-session or
   fresh-proof resume path, retaining provider liveness/expiry/replay checks. Lost
   launch proof requires a fresh Telegram launch. Never bridge through a raw ID,
   initDataUnsafe, URL token or copied cookie. Keep proof in RAM only.

A standalone Clerk-hosted portal does not establish that our Mini receives signed
Telegram launch proof. Reuse the existing Mini UI; no new credential form or screen
is proposed. Failed/503/unknown outcomes must not trigger automatic proof retries
or a late/wrong-person cabinet.

## Hosting and public build inputs

Use apps/mini-app as build root, Node 24.x and its unchanged package lock.
The existing npm run build command is tsc --noEmit && vite build; output is dist.
The assets-only wrangler.jsonc proposal names univeracademy-mini, serves ./dist,
uses single-page-application fallback, workers_dev=true and preview_urls=false.
It contains no Worker script, account/route, API binding, credential or auth rule.
SPA navigation must serve /, /sign-in and /auth/callback; it does not authenticate.

Clerk entry requires VITE_AUTH_ENTRY=common and VITE_CLERK_SDK_ENABLED=true.
For the Telegram launch/link path use VITE_TELEGRAM_SDK_ENABLED=true. /telegram is
the existing legacy Telegram-only entry, not the Clerk-first launch destination.
Set VITE_STUDENT_CONTRACT_SHA256 to the reviewed canonical client contract pin.
VITE_MINI_APP_ORIGIN, VITE_API_ORIGIN, VITE_CLERK_PUBLISHABLE_KEY and
VITE_CLERK_FRONTEND_ORIGIN must come from the final verified deployment/instance.
These Vite values are public build-time inputs, not Worker runtime secrets.

https://app.univeracademy.uz and https://api.univeracademy.uz remain proposed
origins, not verified serving endpoints. No Production Clerk instance is ready.
Do not infer a valid key, Frontend API origin or JWT issuer from a domain name;
retired quick-zebra values must not be reused. Pin key/host/issuer, callback,
CORS/authorizedParties and explicit audience policy to one real instance.

## Gates before activation

- Verify domain delegation, DNS/TLS and the actual Mini/API HTTPS origins first;
  then configure the intended Clerk instance, /sign-in return and /auth/callback.
  Frontend origin must match the page origin and Backend exact CORS policy.
- Backend/Architect/QA must verify actual database grants/policies/context and the
  accepted Clerk/session/linking behavior. Historical SQL and offline/mock passes
  are insufficient; uncertain prior connection state is not authentication proof.
- Freeze the accepted main commit/tree, public build values and build/deployment
  receipts. The integration owner controls release order and rollback; do not
  independently remove CI holds, push main or deploy from this document.
- Configure MINI_CABINET_URL to the actual Mini root with trailing slash and
  MINI_SIGN_IN_URL to its same-origin /sign-in. The persistent Menu Button uses
  the same Mini root. Preserve webhook authentication and the named binding
  TELEGRAM_START_LOOKUP -> univeracademy-api / TelegramAccountDirectory.
- After all gates, verify the approved real owner's Clerk login, profile/cabinet,
  secure Telegram linking and return to the same person. Retain disable/revoke,
  logout/refresh, replay/conflict and unknown-commit denials. Do not create a
  synthetic account/environment or publish credentials, raw proof, operator
  metadata, personal paths or real student data.
