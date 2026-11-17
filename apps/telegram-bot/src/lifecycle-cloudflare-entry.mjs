import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import returningWorker from './returning-worker.mjs';
import { LoginMessageLifecycle } from './login-message-lifecycle.mjs';
import { createTelegramDelivery } from './telegram-delivery.mjs';

export class LoginMessageLifecycleObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.engine = new LoginMessageLifecycle(ctx.storage, env, createTelegramDelivery(env.TELEGRAM_BOT_TOKEN));
    this.tail = Promise.resolve();
  }
  // Serialize across network awaits, without holding blockConcurrencyWhile I/O.
  // Persistent receipts/alarms, not this ephemeral queue, provide crash recovery.
  run(task) { const next = this.tail.then(task); this.tail = next.catch(() => {}); return next; }
  start(context) { return this.run(() => this.engine.start(context)); }
  reconcile() { return this.run(() => this.engine.reconcile()); }
  alarm() { return this.run(() => this.engine.drain()); }
}
// Private capability only. No public URL/header can invoke reconciliation.
export class TelegramMenuSync extends WorkerEntrypoint {
  async reconcile(input) {
    if (!input || Object.keys(input).join(',') !== 'telegram_user_id'
        || !Number.isSafeInteger(input.telegram_user_id) || input.telegram_user_id <= 0
        || this.env.TELEGRAM_MESSAGE_LIFECYCLE_ENABLED !== 'true') throw Error('INVALID_MENU_SYNC');
    return this.env.LOGIN_MESSAGE_LIFECYCLE.getByName(String(input.telegram_user_id)).reconcile();
  }
  async fetch() { return new Response(null, { status: 404 }); }
}
export default returningWorker;
