// One mounted staff session. Token lookup happens inside every request, including private image reads.
const limits = { json: 1024 * 1024, media: 2 * 1024 * 1024 };
const permitted = {
  teacher: new Set(['createGroup','addMember','createInvite','sendInvite','importTest','previewTest','publishTest','assignTest']),
  admin: new Set(['approveGroup']),
};
const messages = {
  GROUP_PENDING: 'Guruh uchun Admin tasdig‘i kerak.',
  GROUP_MEMBERSHIP_CONFLICT: 'O‘quvchining boshqa faol guruhi bor. Guruhini almashtirish uchun Adminga murojaat qiling.',
  ADMIN_TRANSFER_REQUIRED: 'Guruhni almashtirish uchun Adminga murojaat qiling.',
  CHAT_UNAVAILABLE: 'O‘quvchi bot bilan hali suhbat boshlamagan. Guruh taklif havolasini ulashing.',
  EMPTY_GROUP: 'Avval guruhga kamida bitta o‘quvchi qo‘shing.',
  NOT_FOUND: 'Guruh, test yoki o‘quvchining 10 xonali ID raqamini tekshiring.',
  FILE_TOO_LARGE: 'Fayl hajmi ruxsat etilgan chegaradan oshdi.',
};
const fail = (message = 'Kabinetdan ma’lumot olib bo‘lmadi.', info = {}) => Object.assign(new Error(message), info);
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

async function boundedBytes(response, limit) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) throw fail();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0, done = false;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) { done = true; break; }
      size += read.value.byteLength;
      if (size > limit) throw fail();
      chunks.push(read.value);
    }
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function createStaffTransport({origin, role, expected, identity, getCurrentClerkToken, fetch: send, signal, onDenied}) {
  if (!permitted[role] || typeof getCurrentClerkToken !== 'function' || !expected?.generation || !expected.userId ||
      new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin || location.origin !== origin) throw fail();
  async function perform(path, options, binary) {
    const bound = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const check = () => {
      bound.throwIfAborted();
      const current = identity.current();
      if (!current || current.userId !== expected.userId || current.generation !== expected.generation) throw fail();
    };
    check();
    let token, onAbort;
    const aborted = new Promise((_, reject) => { onAbort = () => reject(bound.reason); });
    bound.addEventListener('abort', onAbort, {once:true});
    try { token = await Promise.race([getCurrentClerkToken({expected,signal:bound}), aborted]); }
    finally { bound.removeEventListener('abort', onAbort); }
    check();
    if (typeof token !== 'string' || !token.length || token.length > 8185 || /[^\x21-\x7e]/u.test(token)) throw fail();
    const endpoint = origin + '/api/v1/' + role + '/pilot/' + path;
    const headers = new Headers(options.headers);
    headers.set('Authorization', 'Bearer ' + token);
    headers.set('Accept', binary ? 'image/png' : 'application/json');
    let response;
    try {
      response = await send(endpoint, {...options, headers, signal:bound, credentials:'omit', cache:'no-store', redirect:'error', referrerPolicy:'no-referrer'});
    } catch { throw fail('Server javobi olinmadi. Ulanishni tekshirib, qayta urinib ko‘ring.', { uncertain:true }); }
    check();
    if (response.redirected || response.url !== endpoint || !/(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '')) throw fail();
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => {});
      onDenied(response.status);
      throw fail('Bu kabinetga kirish uchun ruxsat kerak.', { status:response.status });
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (binary && response.ok) {
      if (type !== 'image/png') throw fail();
      const bytes = await boundedBytes(response, limits.media);
      check();
      return new Blob([bytes], {type:'image/png'});
    }
    if (type !== 'application/json') throw fail(undefined, {uncertain:true});
    let packet;
    try { packet = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await boundedBytes(response, limits.json))); }
    catch { throw fail(undefined, {uncertain:true}); }
    check();
    if (!response.ok || !Object.hasOwn(packet, 'data')) {
      const {code, message} = packet.error ?? {};
      const detail = response.status === 422 && typeof message === 'string' && message !== code ? message.slice(0,300) : messages[code];
      throw fail(detail, {status: response.status, uncertain: response.status >= 500 || response.ok});
    }
    return packet.data;
  }
  return {
    request(path, input, key) {
      if (path === 'dashboard' && input === undefined) return perform(path, {method:'GET'}, false);
      if (path !== 'import-preview' && !(path.startsWith('commands/') && permitted[role].has(path.slice(9)))) throw fail();
      if (path === 'import-preview' && role !== 'teacher') throw fail();
      const body = JSON.stringify(input);
      if (new TextEncoder().encode(body).length > 512 * 1024) throw fail(messages.FILE_TOO_LARGE);
      const headers = {'Content-Type':'application/json'};
      if (key) headers['Idempotency-Key'] = key;
      return perform(path, {method:'POST', headers, body}, false);
    },
    async upload(file) {
      if (role !== 'teacher') throw fail();
      const type = file.type || (/\.svg$/i.test(file.name) ? 'image/svg+xml' : /\.png$/i.test(file.name) ? 'image/png' : '');
      if (!['image/png','image/svg+xml'].includes(type)) throw fail('PNG yoki SVG faylni tanlang.');
      if (file.size > (type === 'image/png' ? limits.media : 256 * 1024)) throw fail(messages.FILE_TOO_LARGE);
      const result = await perform('media', {method:'POST', body:file, headers:{'Content-Type':type,'Idempotency-Key':crypto.randomUUID()}}, false);
      if (!uuid(result?.id)) throw fail();
      return result.id;
    },
    image(id) {
      if (role !== 'teacher' || !uuid(id)) throw fail();
      return perform('media/' + id, {method:'GET'}, true);
    },
  };
}
