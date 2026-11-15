# Telegram cabinet activation

This change prepares the existing production flow. It does not activate registration,
change credentials, create users, or prove an end-to-end login.

## Review branch status: incomplete, do not merge

Production source changes are preserved here, but five existing fixture-based test
source updates were not published under the owner's no-synthetic-data restriction:
apps/telegram-bot/tests/returning-worker.test.mjs and tests/cloudflare/{api-postgres,
clerk-worker-bindings,entry,telegram-wiring}.test.mjs. The candidate integrity overlay
references the prepared versions of the four Cloudflare test files, so the remote
branch's integrity verifier is expected to fail until this discrepancy is resolved
within the owner's restrictions. Do not treat the local candidate's successful static
checks as validation of this partial remote branch. No deployment or merge is approved
by this document. Live provider prerequisites below remain unresolved.

## Intended flow

1. Telegram sends `/start` to the bot's verified webhook.
2. Bot asks the private API directory for the Telegram ID's navigation status.
3. Unlinked users open the existing Mini App sign-in route, complete Clerk sign-in,
   and enter the server-owned exchange, Telegram linking and profile flow.
4. The existing cabinet appears only after the server accepts the application session.
5. Linked users open the same Mini App through Telegram's persistent Menu Button.
   Repeated `/start` does not send another inline cabinet button.

## Production prerequisites before activation

- Identify the existing Clerk application in its correct workspace. Configure its
  actual issuer, publishable key, approved origins and redirect URLs; do not infer
  app deletion from an empty list in a different workspace.
- Restore Supabase connector access, then inspect the live runtime role and exact
  function/grant/RLS state. The existing proposal ending in ROLLBACK is not an
  executable migration. In particular verify lookup_telegram_start(bigint),
  locate_telegram_return(bigint,text), link_telegram_identity(uuid,bigint), replay
  policies, and the ua_api_login to ua_runtime role/context relationship.
- Review and activate only the necessary database changes, preserving all real
  users and data. Authentication must not fall back to fabricated success.
- Configure the existing API's actual Hyperdrive and auth bindings. Keep private
  credentials out of GitHub. The full public API's strict environment whitelist
  does not accept UA_TELEGRAM_START_MODE; remove the interim registration_only
  configuration as part of the reviewed full-API transition, not in isolation.
- Configure the Mini App production build using actual public provider values.
  Deploy code only through GitHub and Cloudflare Builds.
- Set bot MINI_CABINET_URL to the real Mini App root and MINI_SIGN_IN_URL to its
  same-origin /sign-in route. Configure Telegram's Menu Button to that cabinet URL
  before enabling linked-user routing. Preserve webhook secret and service binding.
- Verify a real owner's sign-in in Telegram, real Telegram identity link, database
  persistence, cabinet entry and subsequent Menu Button resume. No fake accounts,
  synthetic data or temporary test environment are required or authorized here.

## Validation boundary

Type checking, source syntax and static builds do not establish provider login,
database integration, Menu Button setup or end-to-end registration success.
