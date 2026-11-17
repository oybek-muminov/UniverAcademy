# Menu lifecycle candidate (not deployed)

User correction: remove old login messages even if no cabinet was created; a
fresh /start issues a fresh button. Message cleanup is not account deletion.
The optional integration is implemented locally but is not enabled or deployed.

Integration requirements:
- Direct sendMessage with a stored returned message_id; current webhook reply
  mode does not return the ID and cannot support reliable cleanup.
- Server-authenticated entry-open/terminal/expiry events. A WebApp button click
  alone is not a callback_query. Do not assume Telegram reports a close/failure.
- Persist the individual receipt and cleanup event. On abandonment, a durable
  expiration job removes the old message regardless of registration outcome;
  bind this to the reviewed entry expiry rather than invent a separate timeout.
- /start supersedes prior entry messages and sends a fresh one when unregistered.
- Created cabinet enables per-chat Kabinet menu; absent/deleted cabinet explicitly
  sets commands menu (there is no disabled WebApp menu variant).
- Worker serializes updates per chat and rereads current navigation at delivery;
  stale created events must not re-enable a deleted account's menu. Message cleanup
  retries always target the event receipt, never latest_message_id.
- A successful delete acknowledges the cleanup job; 429 respects retry_after,
  transient failure retries, unknown outcome is reconciled. Telegram normally
  limits deleteMessage to 48 hours: process before that deadline, and use a
  separately reviewed edit-reply-markup fallback for non-deletable old messages.
- Keep menu sync and message cleanup independent so failure of either cannot
  block login or lose the other pending job. Never put tokens into the outbox/log.
- Menu state does not confer account access: Mini/API still authenticate Telegram
  initData and the server-side cabinet binding on every new session.

No production schema, bot token, flags or Cloudflare settings were changed.
Reference: https://core.telegram.org/bots/api#deletemessage
Reference: https://core.telegram.org/bots/api#menubutton

## Implemented optional integration

`returning-worker.mjs` dispatches only validated private /start updates to the
per-chat Durable Object when TELEGRAM_MESSAGE_LIFECYCLE_ENABLED is exactly true.
Default behavior remains unchanged. The engine stores confirmed bot message IDs,
supersedes old messages on /start, polls current cabinet navigation while a login
message remains, and deletes at TTL even if no cabinet exists or DB lookup fails.
Rate-limit retry_after is honored. Cleanup retries survive process restarts.
Retries end after 47 hours with a diagnostic marker; no endless scheduler.

Enablement (not applied): select `src/lifecycle-cloudflare-entry.mjs` as main;
add SQLite Durable Object binding LOGIN_MESSAGE_LIFECYCLE/class
LoginMessageLifecycleObject and a new_sqlite_classes migration; provide secret
TELEGRAM_BOT_TOKEN; set LOGIN_MESSAGE_TTL_SECONDS (60..86400) and the feature flag.
Keep the existing API Service Binding and Mini URLs. Review TTL before enablement.
No production configuration changes accompany this candidate.

Limitations requiring follow-up before declaring full requested lifecycle done:
- Completion notification is implemented below; 30-second reconciliation while
  a receipt remains is its fallback. Account-deletion notifications are not yet
  connected. Lost completion notification after message expiry needs /start.
- URL/WebApp button openings are not observed; current integrated cleanup is at
  expiry, superseding /start or observed completed/disabled cabinet, not click.
- sendMessage has no idempotency key. If Telegram accepts a send but its response
  or durable receipt commit is lost, its message_id cannot safely be recovered.
  Persisted pending/unconfirmed marker suppresses duplicate sending for that
  update; fresh /start works, but the uncertain message cannot be auto-deleted.
- Prior webhook-response messages have no saved message IDs and are not guessed.
- Unit tests use storage/provider doubles; local workerd smoke evidence is below.
  Live Telegram verification remains NOT RUN; no users were contacted.

## Completion hook and runtime evidence (follow-up)

Implemented API response wrapper for successful Telegram link/entry/resume only.
It re-verifies signed Telegram initData and invokes the private TelegramMenuSync
entrypoint. Bot rereads the database rather than trusting a client or event
status. This triggers menu activation and message cleanup without waiting for
polling. Failed notification never changes a committed login response.
Feature off is pass-through. No new public notification endpoint exists.

API bindings (not applied): UA_TELEGRAM_MENU_SYNC_ENABLED=true and service
TELEGRAM_MENU_SYNC -> univeracademy-bot / TelegramMenuSync. Both sides must be
ready before enabling. The API environment allowlist and generated source pins
were updated; account deletion implementation was not modified. Account-deleted
notification is still to be integrated by its owner; /start always reconciles.

Read-only Cloudflare check: bot has lookup service, webhook secret and Mini URLs;
it lacks the Telegram send token and lifecycle storage. API has its Telegram
verification secret already; secret values were not read/exported. No settings
were changed.

Reproducible isolated runtime test:
```
npm ci --prefix apps/telegram-bot/tests/runtime
node apps/telegram-bot/tests/runtime/run.mjs
```
The available pinned Miniflare/workerd only supports up to 2026-08-06; production
uses 2026-11-11. Exact-date runtime startup was blocked. A lower-date smoke run
with `UA_BOT_TEST_COMPATIBILITY_DATE=2026-08-06` passed real local workerd SQLite,
RPC, alarms, completion hook and no-extra-chat-message behavior. This is NOT full
production-compatibility validation. It caught/fixed Workers' unsupported
redirect:error; transport now uses manual redirect and refuses 3xx.
All Telegram traffic was intercepted by a fixture; no real users contacted.

## Delivery guarantees and rate-limit correction

A definitive sendMessage 429 now persists a sendRetry job and retries from the
alarm after the exact retry_after (never shortened). A duplicate webhook cannot
create another job/send. Restarts preserve that job; a newer /start supersedes
it, and a current linked/disabled lookup cancels it. Before each network send,
the job is cleared and pending intent is committed. Therefore ambiguous sends
are never blindly repeated. Permanent 400/403 rejections are marked rejected;
retry windows cap automatic work, they do not guarantee successful delivery.

Remaining unavoidable uncertainty: if an accepted send response or its durable
receipt write is lost, Telegram offers no idempotency key or message-history API
to reconstruct its message_id. That message may remain. We neither guess IDs nor
claim exactly-once delivery/unconditional cleanup. If Telegram denies deletion,
we try removing its inline button; sustained outage or rejection can still leave
a message/button and is recorded as exhausted cleanup. No expired-deadline retry
is attempted early to bypass Telegram's retry_after. Fresh /start remains the
recovery path. Before release, operational visibility for these diagnostic
markers and production-compatibility validation remain required.

Cooldowns survive new events: delete receipts carry a separate notBefore,
menu updates carry menuNotBefore, and send attempts carry sendNotBefore.
Reconciliation and fresh /start may mark work due/superseded but cannot erase
these provider cooldowns. A fresh login button queued during a send cooldown
replaces the old unsent intent and waits for the same allowed send time.
Regression tests cover repeated reconcile/start before and exactly at retry time.
