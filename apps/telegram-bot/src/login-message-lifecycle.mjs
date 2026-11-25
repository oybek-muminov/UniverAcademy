import { lookupValidatedStart } from './private-start-lookup.mjs';
import { readMiniDestinations } from './returning-worker.mjs';
import { staffCabinetNavigation } from './staff-cabinet-navigation.mjs';
const RETRY = 60000, POLL = 30000, DAY = 86400000;
const positive = n => Number.isSafeInteger(n) && n > 0;
// Injectable durable engine; all public operations are serialized by the DO wrapper.
export class LoginMessageLifecycle {
  constructor(storage, env, deliver, now = Date.now, observe = () => {}) { Object.assign(this, { storage, env, deliver, now, observe }); }
  async load() { return await this.storage.get('state') || { receipts: [], seen: [] }; }
  async save(s) {
    const times = [...s.receipts.map(r => r.next), ...(s.menuDue ? [s.menuDue] : []), ...(s.sendRetry ? [s.sendRetry.next] : [])];
    await this.storage.transaction(async tx => {
      await tx.put('state', s);
      if (times.length) await tx.setAlarm(Math.max(this.now() + 1000, Math.min(...times)));
      else await tx.deleteAlarm();
    });
    // Only fixed diagnostic enums, never identity, URLs, provider descriptions or secrets.
    const diagnostic = { event: 'telegram_menu_lifecycle',
      send: ['pending','not_needed','confirmed','rate_limited','rejected','unconfirmed','retry_window_exhausted'].includes(s.lastSend) ? s.lastSend : 'none',
      menu: s.menuFailure === 'retry_window_exhausted' ? 'retry_window_exhausted' : 'none',
      cleanup: s.cleanupFailure === 'retry_window_exhausted' ? 'retry_window_exhausted' : 'none' };
    const signature = JSON.stringify(diagnostic);
    if (signature !== this.lastDiagnostic) {
      this.lastDiagnostic = signature;
      try { this.observe(diagnostic); } catch { /* Diagnostics cannot block durable work. */ }
    }
  }
  async start(context) {
    const { telegram_user_id: chatId, update_id: updateId } = context;
    if (!positive(chatId) || !Number.isSafeInteger(updateId) || updateId < 0) throw new Error('INVALID_START');
    const ttl = Number(this.env.LOGIN_MESSAGE_TTL_SECONDS);
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error('BOT_NOT_CONFIGURED');
    readMiniDestinations(this.env.MINI_CABINET_URL, this.env.MINI_SIGN_IN_URL);
    const s = await this.load(), now = this.now();
    if (s.chatId && s.chatId !== chatId) throw new Error('CHAT_MISMATCH');
    s.seen = s.seen.filter(e => e.at > now - 2 * DAY);
    if (s.seen.some(e => e.id === updateId)) return { status: 'duplicate' };
    if (s.seen.length >= 256 || s.receipts.length >= 64) throw new Error('BOT_BUSY');
    // Lookup before marking delivery, so transient DB failure can be retried.
    const nav = await lookupValidatedStart(context, this.env.TELEGRAM_START_LOOKUP);
    // A linked teacher/admin/owner gets a direct browser button; students keep the existing quiet menu.
    const staff = nav.status === 'linked' ? await staffCabinetNavigation(this.env, chatId) : null;
    s.chatId = chatId; s.updateId = updateId;
    s.seen.push({ id: updateId, at: now });
    for (const receipt of s.receipts) { receipt.expires = now; receipt.next = Math.max(now, receipt.notBefore || 0); }
    s.menuDue = Math.max(now, s.menuNotBefore || 0); s.menuDeadline = now + 47 * 3600000;
    // Persist before external send. Crash/unknown send must NOT blindly resend.
    s.sendRetry = null; // A fresh /start supersedes any unsent older button.
    s.lastSend = nav.status === 'needs_clerk' || staff ? 'pending' : 'not_needed';
    await this.save(s);
    if (nav.status === 'needs_clerk') await this.sendLogin(s, ttl, now + 47 * 3600000);
    else if (staff) await this.sendLogin(s, ttl, now + 47 * 3600000, staff);
    await this.drain();
    return { status: s.lastSend };
  }
  async sendLogin(s, ttl, retryDeadline, staff) {
    if (s.sendNotBefore > this.now()) {
      s.sendRetry = s.sendNotBefore < retryDeadline ? { next: s.sendNotBefore, deadline: retryDeadline, ttl } : null;
      s.lastSend = s.sendRetry ? 'rate_limited' : 'retry_window_exhausted';
      await this.save(s); return;
    }
    const urls = readMiniDestinations(this.env.MINI_CABINET_URL, this.env.MINI_SIGN_IN_URL);
    // Clear scheduled retry BEFORE the external call. A crash/unknown result
    // must not replay a send Telegram might already have accepted.
    s.sendRetry = null; s.lastSend = 'pending'; await this.save(s);
    const sent = await this.deliver('sendMessage', staff ? { chat_id: s.chatId,
      text: 'Ustoz kabinetini ochish uchun tugmani bosing. Tugma yo‘qolsa, /start yuboring.',
      reply_markup: { inline_keyboard: [[{ text: 'Ustoz kabinetini ochish', url: staff.browser }]] } } : { chat_id: s.chatId,
      text: 'Kirish yoki ro‘yxatdan o‘tish uchun tugmani bosing. Tugma yo‘qolsa, /start yuboring.',
      reply_markup: { inline_keyboard: [[{ text: 'Kirish / Ro‘yxatdan o‘tish', web_app: { url: urls.signIn } }]] } });
    const now = this.now();
    if (sent.kind === 'ok' && positive(sent.result?.message_id) && sent.result?.chat?.id === s.chatId) {
      s.lastSend = 'confirmed';
      s.receipts.push({ id: sent.result.message_id, expires: now + ttl * 1000,
        next: now + POLL, deadline: now + 47 * 3600000, mode: 'delete' });
    } else if (sent.kind === 'retry') {
      const next = now + Math.max(1000, sent.delay || RETRY); s.sendNotBefore = next;
      if (next < retryDeadline) {
        s.lastSend = 'rate_limited'; s.sendRetry = { next, deadline: retryDeadline, ttl };
      } else s.lastSend = 'retry_window_exhausted';
    } else s.lastSend = ['rejected', 'blocked'].includes(sent.kind) ? 'rejected' : 'unconfirmed';
    if (sent.kind !== 'retry') s.sendNotBefore = null;
    await this.save(s);
  }
  async reconcile() {
    const s = await this.load(); if (!s.chatId) return { status: 'no_receipt' };
    const now = this.now(); s.menuDue = Math.max(now, s.menuNotBefore || 0); s.menuDeadline = now + 47 * 3600000;
    for (const r of s.receipts) r.next = Math.max(now, r.notBefore || 0);
    await this.save(s); await this.drain(); return { status: 'reconciled' };
  }
  async drain() {
    const s = await this.load(), now = this.now();
    if (!s.chatId) return;
    let nav;
    try { nav = await lookupValidatedStart({ telegram_user_id: s.chatId, update_id: s.updateId }, this.env.TELEGRAM_START_LOOKUP); }
    catch { /* Cleanup at expiry remains independent of DB availability. */ }
    if (s.sendRetry) {
      const retry = s.sendRetry;
      if (nav?.status === 'linked' || nav?.status === 'disabled') {
        s.sendRetry = null; s.lastSend = 'not_needed';
      } else if (now >= retry.deadline) {
        s.sendRetry = null; s.lastSend = 'retry_window_exhausted';
      } else if (retry.next <= now) {
        if (nav?.status === 'needs_clerk') await this.sendLogin(s, retry.ttl, retry.deadline);
        else retry.next = Math.min(retry.deadline, now + RETRY);
      }
    }
    if (s.menuDue && s.menuNotBefore > s.menuDue) s.menuDue = s.menuNotBefore;
    if (s.menuDue && now >= s.menuDeadline) { s.menuDue = null; s.menuFailure = 'retry_window_exhausted'; }
    if (s.menuDue && s.menuDue <= now) {
      if (nav) {
        const urls = readMiniDestinations(this.env.MINI_CABINET_URL, this.env.MINI_SIGN_IN_URL);
        const staff = nav.status === 'linked' ? await staffCabinetNavigation(this.env, s.chatId) : null;
        const cabinetUrl = staff ? urls.cabinet + staff.handoff : urls.cabinet;
        const result = await this.deliver('setChatMenuButton', { chat_id: s.chatId,
          menu_button: nav.status === 'linked' ? { type: 'web_app', text: 'Kabinet', web_app: { url: cabinetUrl } } : { type: 'commands' } });
        s.menuNotBefore = result.kind === 'retry' ? now + result.delay : null;
        s.menuDue = result.kind === 'ok' ? null : now + (result.delay || RETRY);
      } else s.menuDue = now + RETRY;
    }
    const remaining = [];
    for (const r of s.receipts) {
      if (r.notBefore > r.next) r.next = r.notBefore;
      if (r.next > now) { remaining.push(r); continue; }
      if (r.expires > now && nav?.status !== 'linked' && nav?.status !== 'disabled') {
        r.next = Math.min(r.expires, now + POLL); remaining.push(r); continue;
      }
      if (now >= r.deadline) { s.cleanupFailure = 'retry_window_exhausted'; continue; }
      const method = r.mode === 'delete' ? 'deleteMessage' : 'editMessageReplyMarkup';
      const result = await this.deliver(method, { chat_id: s.chatId, message_id: r.id,
        ...(r.mode === 'markup' ? { reply_markup: { inline_keyboard: [] } } : {}) });
      if (result.kind === 'ok' || result.kind === 'missing' || result.kind === 'unchanged') continue;
      if (result.kind === 'not_deletable') r.mode = 'markup';
      r.notBefore = result.kind === 'retry' ? now + result.delay : null;
      r.next = now + (result.delay || RETRY);
      if (r.next >= r.deadline) { s.cleanupFailure = 'retry_window_exhausted'; continue; }
      remaining.push(r);
    }
    if (s.menuDue && now >= s.menuDeadline) {
      s.menuDue = null; s.menuFailure = 'retry_window_exhausted';
    }
    s.receipts = remaining;
    // Poll only while login messages exist; no forever polling per registered user.
    if (remaining.length && !s.menuDue && now < s.menuDeadline) s.menuDue = now + POLL;
    await this.save(s);
  }
}
