import { verifyTelegramLaunch } from '../supabase/functions/univeracademy-api/telegram-return.ts';
// Optional private notification, not an auth grant and not part of the DB commit.
// Bot rereads authoritative navigation. Failed notification cannot turn a
// committed login into an error response; durable bot reconciliation retries it.
export const telegramMenuEnvironmentKeys = ['UA_TELEGRAM_MENU_SYNC_ENABLED', 'TELEGRAM_MENU_SYNC'];
const paths = new Set(['/api/v1/auth/telegram/link', '/api/v1/auth/telegram/entry', '/api/v1/auth/telegram/resume']);
const eligible = request => request.method === 'POST' && paths.has(new URL(request.url).pathname.replace(/\/$/, ''));
async function readBounded(request) {
  const reader = request.body?.getReader(); if (!reader) throw Error('NO_BODY');
  const chunks = []; let size = 0, timer;
  try {
    return await Promise.race([(async () => {
      for (;;) { const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > 20000) throw Error('BODY_LIMIT'); chunks.push(value); }
      const bytes = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DEADLINE')), 5000); })]);
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
export function withTelegramMenuCompletion(api, { verify = verifyTelegramLaunch, now = Date.now } = {}) {
  return { async fetch(request, env, ctx) {
    if (env?.UA_TELEGRAM_MENU_SYNC_ENABLED !== 'true' || !eligible(request)) return api.fetch(request, env, ctx);
    // Buffer only this bounded request before fan-out; never tee unbounded bodies.
    let body, clone;
    try {
      body = await readBounded(request);
      clone = new Request(request.url, { method: request.method, headers: request.headers,
        body: JSON.stringify(body), signal: request.signal });
    } catch { return new Response(JSON.stringify({error:{code:'VALIDATION_ERROR'}}), {status:422,headers:{'content-type':'application/json','cache-control':'no-store'}}); }
    const response = await api.fetch(clone, env, ctx);
    if (response.status < 200 || response.status >= 300) return response;
    const notify = async () => {
      try {
        const launch = await verify(body.init_data, env.UA_TELEGRAM_BOT_TOKEN, JSON.parse(env.UA_SESSION_POLICY), now());
        const binding = env.TELEGRAM_MENU_SYNC;
        if (typeof binding?.reconcile !== 'function') throw Error('MISSING_BINDING');
        let timer;
        try {
          const work = Promise.resolve(binding.reconcile({ telegram_user_id: launch.telegramUserId })).then(result => { result?.[Symbol.dispose]?.(); });
          await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('NOTIFY_TIMEOUT')), 5000); })]);
        } finally { clearTimeout(timer); }
      } catch { /* No secrets/IDs emitted. Alarm reconciliation remains active. */ }
    };
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(notify());
    else await notify();
    return response;
  } };
}
