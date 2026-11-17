# Menu lifecycle integration (feature off)

User correction: remove old login messages even if no cabinet was created; a
fresh /start issues a fresh button. Message cleanup is not account deletion.
The optional code is on main; the lifecycle feature is not enabled. The existing
bot automatic build ran successfully with its original stateless entrypoint.

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
the owner has now supplied TELEGRAM_BOT_TOKEN as a secret binding, verified by
name/type only. Lifecycle storage is still absent live. API has its Telegram
verification secret already; secret values were not read/exported. No settings
were changed.

Reproducible isolated runtime test:
```
npm ci --prefix apps/telegram-bot/tests/runtime
node apps/telegram-bot/tests/runtime/run.mjs
```
Runtime parity check passed at production compatibility_date=2026-11-11 using
official workerd 1.20261117.1. Stable Miniflare bundles an older binary, so the test
pins workerd separately and selects it through its supported
MINIFLARE_WORKERD_PATH. Local workerd exercises SQLite receipts, private RPC,
alarms, completion hooks, no-extra-message and 429 retry behavior. This is not
live Telegram acceptance; no deployment or provider configuration is involved.
The earlier lower-date smoke caught/fixed Workers' unsupported redirect:error;
transport uses manual redirect and refuses 3xx.
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
markers and live acceptance verification remain required.

Cooldowns survive new events: delete receipts carry a separate notBefore,
menu updates carry menuNotBefore, and send attempts carry sendNotBefore.
Reconciliation and fresh /start may mark work due/superseded but cannot erase
these provider cooldowns. A fresh login button queued during a send cooldown
replaces the old unsent intent and waits for the same allowed send time.
Regression tests cover repeated reconcile/start before and exactly at retry time.

## Prepared safe-off configuration (not pushed or applied)

The local bot configuration selects lifecycle-cloudflare-entry.mjs, binds
LOGIN_MESSAGE_LIFECYCLE to LoginMessageLifecycleObject, adds the SQLite migration
menu-lifecycle-v1, and explicitly sets TELEGRAM_MESSAGE_LIFECYCLE_ENABLED=false.
Existing URLs, lookup service and separately stored secrets are preserved. The reviewed
TTL is 86400 seconds (24 hours), leaving a further 23-hour retry window before
the 47-hour cleanup cutoff.
The disabled path performs no direct Telegram calls or lifecycle storage writes.

Deployment order for review:
1. Publish the safe-off bot configuration and verify its build, exports, binding,
   migration and unchanged secret names. Do not enable yet.
2. Add the API private service TELEGRAM_MENU_SYNC -> univeracademy-bot, entrypoint
   TelegramMenuSync, with UA_TELEGRAM_MENU_SYNC_ENABLED=false. Preserve Hyperdrive,
   routes, Clerk vars/secrets, lookup entrypoint and all deletion settings. This
   adds an internal RPC capability and must be reviewed before applying.
3. Confirm operational diagnostics and an owner-only acceptance test window.
4. Enable bot lifecycle, then API completion notification. Never use arbitrary
   real user accounts as fixtures. Verify both a new and existing owner-scoped
   account, successful and abandoned login, duplicate webhook, and menu behavior.
5. Rollback disables API notification and bot lifecycle flags; do not delete the
   DO namespace or stored receipts. Outstanding alarms still need to finish
   cleanup, so disabling new work is not cancellation of already scheduled work.

This change does not wire account-deletion events; that integration remains
with the deletion work owner. No credentials, production bindings, migration,
flags, network/security settings, or real Telegram messages were changed here.

### Production effect / rollback record (pre-change, 2026-11-17)

Observed bot version: 9d0f03c0-32c9-46bd-a039-6026ccfcd685.
Observed API version: 82ba88c1-1bd2-44b0-bfbb-99501f54b7c9.
These are observations, not instructions to restore old secrets or overwrite
later work. Re-read active versions/settings immediately before any change.

Safe-off bot provisioning adds a namespace and exports but retains stateless
/start behavior. API service binding must be deployed only AFTER the bot export
exists. It grants only the named private reconciliation entrypoint; there is no
new public route, database privilege, credential rotation or network policy.

Diagnostics emit fixed event/send/menu/cleanup enums after durable persistence;
no chat/message/user IDs, request bodies, provider descriptions, tokens or URLs.
Observer failure cannot block the operation. Worker logs enabled, invocation
logs disabled, traces disabled. Diagnostic markers may reappear after a cold
start and are not exactly-once metrics. Pending indicates an attempt, not proven
delivery; confirmed/rejected/unconfirmed and exhausted retry markers distinguish
outcomes. Existing webhook-response messages cannot be retroactively tracked.

For rollback, keep the new module/namespace and disable feature flags first.
Blind rollback to an older module without the Durable Object class could strand
stored alarms; do not delete a namespace or migration to undo enablement. Existing
cleanup alarms continue after feature-off. If ALL side effects need to stop,
that is a separate reviewed cancellation change, not the feature-off procedure.
