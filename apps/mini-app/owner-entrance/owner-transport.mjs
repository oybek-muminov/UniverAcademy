// One read of the Owner dashboard, bound to one signed-in session. The token is fetched inside each request
// and is only ever sent to the Owner origin; nothing is stored.
const limit = 64 * 1024;
const fail = (message = 'Kabinetdan ma’lumot olib bo‘lmadi.', info = {}) => Object.assign(new Error(message), info);
export const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function createOwnerTransport({ origin, expected, identity, getCurrentClerkToken, fetch: send, signal, onDenied }) {
  if (typeof getCurrentClerkToken !== 'function' || !expected?.generation || !expected.userId ||
      new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin || location.origin !== origin) throw fail();
  return {
    async dashboard() {
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
      const endpoint = origin + '/api/v1/owner/pilot/dashboard';
      let response;
      try {
        response = await send(endpoint, { method: 'GET', signal: bound, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      } catch { throw fail('Server javobi olinmadi. Ulanishni tekshirib, qayta urinib ko‘ring.', { uncertain: true }); }
      check();
      if (response.redirected || response.url !== endpoint || !/(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '')) throw fail();
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        onDenied(response.status);
        throw fail('Bu kabinetga kirish uchun ruxsat kerak.', { status: response.status });
      }
      if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw fail(undefined, { status: response.status });
      if (Number(response.headers.get('content-length')) > limit) throw fail();
      const text = await response.text();
      check();
      if (text.length > limit) throw fail();
      let packet; try { packet = JSON.parse(text); } catch { throw fail(); }
      if (!packet || typeof packet !== 'object' || !Object.hasOwn(packet, 'data')) throw fail();
      return packet.data;
    },
  };
}
