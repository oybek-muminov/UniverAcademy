// No caller-controlled host or method. Errors never include the token or URL.
const methods = new Set(['sendMessage', 'deleteMessage', 'editMessageReplyMarkup', 'setChatMenuButton']);
export function createTelegramDelivery(token, fetcher = fetch) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('BOT_NOT_CONFIGURED');
  return async (method, body) => {
    if (!methods.has(method)) throw new Error('INVALID_BOT_METHOD');
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => {}); return { kind: 'unknown' }; }
      // Telegram response, cap before parsing; never copy description to logs.
      const reader = response.body?.getReader(); let size = 0; const chunks = [];
      if (!reader) return { kind: 'unknown' };
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break;
          size += value.length; if (size > 65536) return { kind: 'unknown' }; chunks.push(value); }
      } finally { void reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (response.ok && value.ok === true) return { kind: 'ok', result: value.result };
      if (value.error_code === 429 && Number.isSafeInteger(value.parameters?.retry_after)
          && value.parameters.retry_after >= 0 && Number.isSafeInteger(value.parameters.retry_after * 1000))
        return { kind: 'retry', delay: Math.max(1000, value.parameters.retry_after * 1000) };
      if (value.error_code === 400 && /message to delete not found/i.test(value.description || '')) return { kind: 'missing' };
      if (value.error_code === 400 && /message can.t be deleted/i.test(value.description || '')) return { kind: 'not_deletable' };
      if (value.error_code === 400 && /message is not modified/i.test(value.description || '')) return { kind: 'unchanged' };
      if (value.error_code === 403) return { kind: 'blocked' };
      return { kind: response.status >= 500 ? 'unknown' : 'rejected' };
    } catch { return { kind: 'unknown' }; }
  };
}
