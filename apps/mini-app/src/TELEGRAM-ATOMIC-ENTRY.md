# Default-off atomic Telegram entry candidate

Enabled only when VITE_TELEGRAM_ATOMIC_ENTRY is exactly 'true' and Telegram launch
context exists. Backend atomic mode must be coordinated; no production activation
has occurred. Browser generic auth remains unchanged. Atomic wrapper never constructs
the legacy exchange-then-link runtime. No fallback to that path exists after error.

Signed Telegram resume is attempted once. Only TELEGRAM_LINK_REQUIRED/conflict or
CLERK_SESSION_REVOKED/auth before session establishment enables the Clerk card.
Unknown failures block and request a fresh /start. Existing cabinet may resume with
signed Telegram proof without a current Clerk cookie. Server remains authoritative.

Card displays selected Clerk account, explicit continue, and a selected-session-only
change-account action. isSignedIn never triggers linking. Official useReverification
wraps only a proof-producing callback. session.checkAuthorization checks first factor
with afterMinutes4, requesting the official reverificationError hint when needed.
After real supported modal, skipCache JWT is fetched and captured Clerk user/session
rechecked. Final atomic POST is outside the auto-retrying SDK hook. Google sign-in
alone is not a reverification factor; supported email-code/etc eligibility must be
validated with actual production Clerk settings before enabling.

POST uses canonical owner-client extension /api/v1/auth/telegram/entry, Clerk bearer,
raw init_data and link-telegram-account-v1. App session is exposed only after matching
profile validation. Cancellation, changed raw launch, user/session switch and duplicate
clicks are guarded; an ambiguous mutation failure blocks replay. No proof is persisted.

Local unit tests are not real browser or Clerk E2E. Remaining gate: selected account,
email-code reverification, cancellation, bot resume, fresh registration and returning
cabinet on the supported Telegram/browser devices. Coordinated backend/client flag
activation and production review remain required.

Pending identity is tracked from confirmation through reverification/submission.
observe invalidates a changed user/session immediately: before POST it returns to
explicit selection; after POST it aborts transport and blocks as uncertain, never
claiming rollback or automatically retrying. Late successful login responses clear
the abandoned connection and cannot expose a cabinet. Race tests cover both stages.
