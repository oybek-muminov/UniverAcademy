// No routes, wire DTOs, live fetch or Backend implementation imports live here.
// Supply the reviewed client's session hooks/fetch after owner acceptance.
export type FailureKind = 'auth' | 'forbidden' | 'missing' | 'conflict' | 'validation' | 'limited' | 'temporary' | 'offline' | 'protocol';
export class StudentFailure extends Error {
  kind: FailureKind;
  code: string;
  retryAfterMs: number | null;
  uncertain: boolean;
  constructor(kind: FailureKind, code: string, retryAfterMs: number | null = null, uncertain = false) {
    super(code); this.kind = kind; this.code = code; this.retryAfterMs = retryAfterMs; this.uncertain = uncertain;
  }
}
export function asFailure(error: unknown): StudentFailure {
  return error instanceof StudentFailure ? error : new StudentFailure('offline', 'UNCONFIRMED', null, true);
}
export type SignInMethod = 'telegram' | 'clerk';
export function failureMessage(error: StudentFailure, signInMethod: SignInMethod = 'telegram'): string {
  if (error.kind === 'auth') return signInMethod === 'clerk'
    ? 'Sessiyani qayta oching. Google yoki email orqali yangidan kiring; test vaqti davom etadi.'
    : 'Sessiyani qayta oching. Telegramdan yangidan kiring; test vaqti davom etadi.';
  if (error.kind === 'forbidden') return 'Bu amal uchun ruxsat yo‘q. Testlar ro‘yxatini yangilang.';
  if (error.kind === 'missing') return 'Test yoki urinish ochilmadi. Testlar ro‘yxatini yangilang.';
  if (error.kind === 'limited') return 'So‘rovlar vaqtincha cheklangan. Biroz kutib qayta tekshiring.';
  if (error.kind === 'validation') return 'Ma’lumot qabul qilinmadi. Tanlovni tekshiring yoki saqlangan holatni yangilang.';
  if (error.kind === 'conflict') return 'Urinish yoki javob holati o‘zgargan. Avval saqlangan holatni tekshiring.';
  if (error.kind === 'protocol') return 'Xizmat javobi mos kelmadi. Hech qanday muvaffaqiyat tasdiqlanmadi.';
  if (error.kind === 'temporary') return 'Xizmat vaqtincha javob bermayapti. Amalni qayta tekshiring.';
  return 'Aloqa uzilgan yoki tasdiq kelmagan. Avval saqlangan holatni tekshiring.';
}

// Internal session projection, supplied by the future reviewed client adapter.
// Proofs remain in memory; reload requires a fresh authenticated launch.
export type StudentProof = { access: string; refresh: string; expiresAt: number; person: string };
function validProof(value: StudentProof) {
  if (!value || typeof value.access !== 'string' || !value.access || typeof value.refresh !== 'string' || !value.refresh ||
    typeof value.person !== 'string' || !value.person || !Number.isFinite(value.expiresAt)) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
  return value;
}
type SessionHooks = {
  login(rawInitData: string): Promise<StudentProof>;
  rotate(refreshProof: string): Promise<StudentProof>;
  // Owner client: body-only refresh proof, Authorization absent, no refresh/replay.
  // Resolve only after validating HTTP 200 + SuccessAck; never expose raw proof.
  logout(refreshProof: string, signal: AbortSignal): Promise<void>;
};
type RequestSpec = { method: 'GET' | 'POST' | 'PATCH' | 'PUT'; path: string; body?: unknown; key?: string };
type LogoutReceipt = {
  id: string; epoch: number; refresh: string | null; deadline: number | null;
  retryAt: number;
  state: 'pending' | 'uncertain' | 'confirmed' | 'expired' | 'cancelled' | 'unavailable';
  abort: AbortController; timer?: ReturnType<typeof setTimeout>; task?: Promise<void>;
};

export function createStudentTransport(options: {
  origin: string; fetcher: typeof fetch; sessions: SessionHooks; now?: () => number;
  // Explicit local candidate policy only. Omitted => no retained-proof retry.
  logoutReceiptPolicy?: { retentionMs: number; monotonicNow?: () => number };
}) {
  const base = new URL(options.origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Explicit HTTPS API origin required');
  const now = options.now ?? Date.now;
  let proof: StudentProof | null = null;
  let rotating: Promise<StudentProof> | null = null;
  let authEpoch = 0;
  let receipt: LogoutReceipt | null = null;
  const receiptNow = options.logoutReceiptPolicy?.monotonicNow ?? (() => performance.now());
  const retentionMs = options.logoutReceiptPolicy?.retentionMs;
  if (retentionMs !== undefined && (!Number.isFinite(retentionMs) || retentionMs <= 0)) throw new Error('Explicit positive logout receipt retention required');

  function endReceipt(op: LogoutReceipt, state: LogoutReceipt['state']) {
    op.state = state; op.refresh = null; clearTimeout(op.timer);
    op.abort.abort(new StudentFailure('protocol', state === 'expired' ? 'LOGOUT_RECEIPT_EXPIRED' : 'LOGOUT_RECEIPT_SUPERSEDED', null, true));
  }
  function checkReceipt(op: LogoutReceipt) {
    if (receipt !== op || op.epoch !== authEpoch || op.state === 'cancelled') throw new StudentFailure('protocol', 'LOGOUT_RECEIPT_SUPERSEDED', null, true);
    if (op.deadline !== null && receiptNow() >= op.deadline && op.state !== 'confirmed') endReceipt(op, 'expired');
    if (op.state === 'expired') throw new StudentFailure('protocol', 'LOGOUT_RECEIPT_EXPIRED', null, true);
  }
  function sendReceipt(op: LogoutReceipt): Promise<void> {
    checkReceipt(op);
    if (op.state === 'confirmed') return Promise.resolve();
    if (op.task) return op.task; // Only this logout operation is single-flight.
    if (!op.refresh) throw new StudentFailure('protocol', 'LOGOUT_RECEIPT_UNAVAILABLE', null, true);
    if (receiptNow() < op.retryAt) throw new StudentFailure('limited', 'RATE_LIMITED', op.retryAt - receiptNow(), true);
    op.state = 'pending';
    const task = (async () => {
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(op.abort.signal.reason);
        op.abort.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        // Hook receives only this operation's captured proof, never current access.
        // Keep eager invocation; a synchronous throw must enter the observed race.
        const sent = new Promise<void>(resolve => resolve(options.sessions.logout(op.refresh!, op.abort.signal)));
        await Promise.race([sent, aborted]);
        checkReceipt(op); // post-clear epoch: our own clear must not reject its ACK.
        op.state = 'confirmed'; op.refresh = null; clearTimeout(op.timer);
      } catch (error) {
        checkReceipt(op); // A late error must not affect a fresh login/operation.
        const failure = asFailure(error);
        op.state = 'uncertain';
        if (failure.kind === 'limited' && failure.retryAfterMs !== null) op.retryAt = receiptNow() + Math.max(0, failure.retryAfterMs);
        if (op.deadline === null || ['auth', 'forbidden', 'missing', 'validation'].includes(failure.kind) || failure.code === 'MALFORMED_JSON') endReceipt(op, 'unavailable');
        throw new StudentFailure(failure.kind, failure.code, failure.retryAfterMs, true);
      } finally {
        op.abort.signal.removeEventListener('abort', onAbort);
      }
    })();
    op.task = task;
    void task.finally(() => { if (op.task === task) op.task = undefined; }).catch(() => {});
    return task;
  }

  async function rotate() {
    if (rotating) return rotating;
    if (!proof) throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED');
    const old = proof; const epoch = authEpoch;
    let task: Promise<StudentProof>;
    task = Promise.resolve().then(async () => {
      try {
        const next = validProof(await options.sessions.rotate(old.refresh));
        if (epoch !== authEpoch || next.person !== old.person) throw new Error('Session changed');
        proof = next; return next;
      } catch {
        // A lost rotation reply must never replay the consumed refresh proof.
        if (epoch === authEpoch) { proof = null; authEpoch++; }
        throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED', null, true);
      }
    }).finally(() => { if (rotating === task) rotating = null; });
    rotating = task;
    return task;
  }
  // Execute a Backend-owned client operation using this session's proof/epoch.
  // No endpoint, wire DTO or response parser is duplicated here.
  async function withAccess<T>(action: (access: string) => Promise<T>, mutation = false, retried = false): Promise<T> {
    if (!proof) throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED');
    const epoch = authEpoch;
    if (proof.expiresAt <= now()) await rotate();
    if (epoch !== authEpoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED', null, mutation);
    if (!proof) throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED');
    const sentAccess = proof.access;
    try {
      const value = await action(sentAccess);
      if (epoch !== authEpoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED', null, mutation);
      return value;
    } catch (error) {
      if (epoch !== authEpoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED', null, mutation);
      const failure = asFailure(error);
      if (failure.kind === 'auth') {
        if (failure.code === 'APP_SESSION_EXPIRED' && !mutation && !retried) {
          if (proof?.access === sentAccess) await rotate();
          return withAccess(action, false, true);
        }
        proof = null; authEpoch++;
      }
      throw failure;
    }
  }
  async function request(spec: RequestSpec, retried = false): Promise<unknown> {
    if (!spec.path.startsWith('/') || spec.path.startsWith('//') || /[\\?#]|(?:^|\/)\.\.(?:\/|$)/.test(spec.path)) throw new StudentFailure('protocol', 'INVALID_CLIENT_PATH');
    if (!proof) throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED');
    if (proof.expiresAt <= now()) await rotate();
    if (!proof) throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED');
    const epoch = authEpoch;
    const sentAccess = proof.access;
    const mutation = spec.method !== 'GET';
    let response: Response;
    try {
      response = await options.fetcher(base.href.replace(/\/$/, '') + spec.path, {
        method: spec.method, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Authorization: `Bearer ${sentAccess}`, Accept: 'application/json',
          ...(spec.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(spec.key ? { 'Idempotency-Key': spec.key } : {}) },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
      });
    } catch { throw new StudentFailure('offline', 'UNCONFIRMED', null, mutation); }
    if (epoch !== authEpoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED', null, mutation);
    let body: unknown;
    try { body = await response.json(); }
    catch {
      if (epoch !== authEpoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED', null, mutation);
      throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED', null, mutation);
    }
    if (epoch !== authEpoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED', null, mutation);
    if (response.ok) {
      if (!body || typeof body !== 'object' || !('data' in body)) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED', null, mutation);
      return body.data; // The reviewed client validates its actual operation schema.
    }
    const code = body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'code' in body.error && typeof body.error.code === 'string' ? body.error.code : 'UNEXPECTED_RESPONSE';
    if (response.status === 401) {
      if (code === 'APP_SESSION_EXPIRED' && !mutation && !retried) {
        if (proof?.access === sentAccess) await rotate();
        return request(spec, true);
      }
      proof = null; authEpoch++;
      throw new StudentFailure('auth', code, null, mutation);
    }
    const kind: FailureKind = response.status === 403 ? 'forbidden' : response.status === 404 ? 'missing' : response.status === 409 ? 'conflict' : response.status === 422 ? 'validation' : response.status === 429 ? 'limited' : response.status >= 500 ? 'temporary' : 'protocol';
    const retry = response.headers.get('Retry-After');
    const retryAfterMs = response.status === 429 && retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now())) : null;
    throw new StudentFailure(kind, code, retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : null, mutation && response.status >= 500);
  }
  return {
    withAccess,
    request,
    // Local cancellation only. Retire pending login/read callbacks immediately;
    // this is never a server logout ACK or an automatic exchange/refresh replay.
    clear() {
      if (receipt) endReceipt(receipt, 'cancelled');
      proof = null; rotating = null; authEpoch++;
    },
    async login(rawInitData: string) {
      if (receipt) endReceipt(receipt, 'cancelled');
      const epoch = ++authEpoch; proof = null; rotating = null;
      // Caller must obtain a new launch after ambiguity; no stored initData replay.
      try {
        const next = validProof(await options.sessions.login(rawInitData));
        if (epoch !== authEpoch) throw new Error('Session changed');
        proof = next; return next.person;
      } catch { throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED', null, true); }
    },
    async logout() {
      if (!proof) {
        if (receipt?.task) { await sendReceipt(receipt); return; }
        throw new StudentFailure('auth', 'LOGOUT_PROOF_REQUIRED');
      }
      if (receipt) endReceipt(receipt, 'cancelled');
      const current = proof; proof = null; rotating = null; authEpoch++;
      const op: LogoutReceipt = { id: crypto.randomUUID(), epoch: authEpoch, refresh: current.refresh,
        deadline: retentionMs === undefined ? null : receiptNow() + retentionMs, retryAt: 0, state: 'pending', abort: new AbortController() };
      receipt = op;
      if (retentionMs !== undefined) op.timer = setTimeout(() => endReceipt(op, 'expired'), retentionMs);
      await sendReceipt(op);
    },
    logoutReceipt() {
      if (!receipt) return null;
      try { checkReceipt(receipt); } catch { /* Return only non-secret operation status. */ }
      return { operationId: receipt.id, state: receipt.state };
    },
    async retryLogoutReceipt(operationId: string) {
      if (!receipt || receipt.id !== operationId) throw new StudentFailure('protocol', 'LOGOUT_RECEIPT_UNAVAILABLE', null, true);
      await sendReceipt(receipt);
    },
    cancelLogoutReceipt(operationId: string) {
      if (receipt?.id === operationId) endReceipt(receipt, 'cancelled');
    },
    person() { return proof?.person ?? null; },
  };
}

// Only operation keys/opaque resource references, never tokens, initData or answers.
// Inject sessionStorage in a reviewed bootstrap; tests use an in-memory store.
export function createOperationJournal(store?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const memory = new Map<string, string>();
  function name(scope: string) { return `ua.operation.v1:${scope}`; }
  return {
    peek(scope: string) {
      const slot = name(scope);
      let value = memory.get(slot);
      try { value ??= store?.getItem(slot) ?? undefined; } catch { /* Memory fallback. */ }
      return value && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value : null;
    },
    key(scope: string) {
      const slot = name(scope);
      const value = this.peek(scope) ?? crypto.randomUUID();
      memory.set(slot, value);
      try { store?.setItem(slot, value); } catch { /* Memory-only ceiling, documented. */ }
      return value;
    },
    clear(scope: string) { const slot = name(scope); memory.delete(slot); try { store?.removeItem(slot); } catch { /* No token is retained. */ } },
  };
}
