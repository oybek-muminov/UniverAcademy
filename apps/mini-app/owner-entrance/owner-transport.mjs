// Reads and commands for the Owner cabinet, each bound to one signed-in session. The token is fetched inside each
// request and is only ever sent to the Owner origin; nothing is stored.
const limit = 64 * 1024;
const fail = (message = 'Kabinetdan ma’lumot olib bo‘lmadi.', info = {}) => Object.assign(new Error(message), info);
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const commandNames = new Set(['findStudent', 'assignTeacher']);

export function createOwnerTransport({ origin, expected, identity, getCurrentClerkToken, fetch: send, signal, onDenied }) {
  if (typeof getCurrentClerkToken !== 'function' || !expected?.generation || !expected.userId ||
      new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin || location.origin !== origin) throw fail();
  async function request(tail, { method, body, key }) {
    const bound = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const check = () => {
      bound.throwIfAborted();
      const current = identity.current();
      if (!current || current.userId !== expected.userId || current.generation !== expected.generation) throw fail();
    };
    check();
    const token = await getCurrentClerkToken({ expected, signal: bound });
    check();
    if (typeof token !== 'string' || !token.length || token.length > 8185 || /[^\x21-\x7e]/u.test(token)) throw fail();
    const endpoint = origin + '/api/v1/owner/pilot/' + tail;
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
    if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = key; }
    let response;
    try {
      response = await send(endpoint, { method, signal: bound, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    } catch { throw fail('Server javobi olinmadi. Ulanishni tekshirib, qayta urinib ko‘ring.', { uncertain: true }); }
    check();
    if (response.redirected || response.url !== endpoint || !/(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '')) throw fail();
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => {});
      onDenied(response.status);
      throw fail('Bu kabinetga kirish uchun ruxsat kerak.', { status: response.status });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw fail(undefined, { status: response.status });
    if (Number(response.headers.get('content-length')) > limit) throw fail();
    const text = await response.text();
    check();
    if (text.length > limit) throw fail();
    let packet; try { packet = JSON.parse(text); } catch { throw fail(); }
    if (!response.ok) throw fail(undefined, { status: response.status, code: typeof packet?.error?.code === 'string' ? packet.error.code : undefined });
    if (!packet || typeof packet !== 'object' || !Object.hasOwn(packet, 'data')) throw fail();
    return packet.data;
  }
  const command = (name, body, key) => {
    if (!commandNames.has(name) || typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw fail();
    return request('commands/' + name, { method: 'POST', body, key });
  };
  return {
    dashboard: () => request('dashboard', { method: 'GET' }),
    findStudent: cabinetId => command('findStudent', { univeracademy_id: cabinetId }, crypto.randomUUID()),
    assignTeacher: (cabinetId, key) => command('assignTeacher', { univeracademy_id: cabinetId }, key),
  };
}
