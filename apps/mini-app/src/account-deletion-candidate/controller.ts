/** Review-only, unmounted client flow. Identity and freshness checks are UX guards;
 * the API must verify the Clerk JWT, recent fva and matching app session itself. */
export type Scope = Readonly<{personId: string; clerkUserId: string; clerkSessionId: string}>;
export type Receipt = Readonly<{requestId: string; receipt: string}>;
export type DeleteRequest = Receipt & {clerkToken: string; confirmation: 'delete-account-v1'};
export type Phase = 'disabled' | 'idle' | 'confirming' | 'verifying' | 'submitting' | 'pending' | 'completed' | 'rejected' | 'status_unavailable';
export type Snapshot = Readonly<{phase: Phase; message: string}>;
export type DeletionPort = {
  // Adapter binds existing app bearer in memory. Neither request nor status accepts a person ID.
  submit(request: DeleteRequest): Promise<{status: 'pending'}>;
  status(receipt: string): Promise<{status: 'pending' | 'completed'}>;
};
export class DefiniteDeletionRejection extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403) { super('Deletion was not accepted'); this.status = status; }
}
export class DeletionStatusMissing extends Error {}
export type ReceiptStore = {read(): Receipt | null; write(value: Receipt): void; remove(expected: Receipt, outcome?: 'completed' | 'rejected'): void};
export type DeletionController = ReturnType<typeof createDeletionController>;
const equal = (a: Scope | null, b: Scope) => !!a && a.personId === b.personId && a.clerkUserId === b.clerkUserId && a.clerkSessionId === b.clerkSessionId;
const validReceipt = (r: Receipt) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.requestId) && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(r.receipt);
export function newDeletionReceipt(): Receipt {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return {requestId: crypto.randomUUID(), receipt: btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')};
}
export function createDeletionController(options: {
  enabled?: boolean;
  scope: Scope;
  currentScope(): Scope | null;
  // Must invoke the real Clerk reverification UI and fetch a fresh non-cached token.
  // null means cancellation. Never substitute getToken alone for reverification.
  reverify(): Promise<{clerkUserId: string; clerkSessionId: string; token: string} | null>;
  store: ReceiptStore;
  port: DeletionPort;
  makeReceipt?: () => Receipt;
  onCompleted(): void; // Clear only this app's local session, not every Clerk account.
}) {
  const scope = {...options.scope};
  let state: Snapshot = Object.freeze({phase: options.enabled === true ? 'idle' : 'disabled', message: ''});
  let disposed = false, generation = 0, receipt: Receipt | null = null, polling = false;
  const listeners = new Set<() => void>();
  const set = (phase: Phase, message = '') => {
    if (disposed) return;
    state = Object.freeze({phase, message}); for (const fn of listeners) fn();
  };
  const matches = () => equal(options.currentScope(), scope);
  try {
    const saved = options.store.read();
    if (saved && validReceipt(saved)) { receipt = saved; set('pending', 'O‘chirish natijasi tekshirilishi kerak.'); }
    else if (saved) set('status_unavailable', 'Saqlangan tekshiruv ma’lumoti yaroqsiz. Hisob o‘chirildi deb hisoblamang.');
  } catch { set('status_unavailable', 'Saqlangan holatni o‘qib bo‘lmadi.'); }
  async function refresh() {
    if (disposed || polling || !receipt || ['completed', 'submitting'].includes(state.phase)) return;
    polling = true; const target = receipt;
    try {
      const result = await options.port.status(target.receipt);
      if (disposed || target !== receipt) return;
      if (result.status === 'completed') {
        // Keep completed receipt until removal succeeds; failures must not claim undo.
        try { options.store.remove(target, 'completed'); } catch { /* confirmed remote completion is authoritative */ }
        set('completed', 'Hisob o‘chirildi. Yangidan ro‘yxatdan o‘tishingiz mumkin.');
        if (matches()) { try { options.onCompleted(); } catch { /* local cleanup cannot negate confirmed deletion */ } }
      } else if (result.status === 'pending') set('pending', 'O‘chirish davom etmoqda.');
      else set('status_unavailable', 'Natija tasdiqlanmadi. Qayta tekshiring.');
    } catch (error) {
      if (!disposed) set(error instanceof DeletionStatusMissing ? 'status_unavailable' : 'pending',
        error instanceof DeletionStatusMissing ? 'Natija topilmadi yoki tekshirish muddati tugagan. Bu o‘chirilganini tasdiqlamaydi.' : 'Natija hali tasdiqlanmadi. Qayta tekshiring.');
    } finally { polling = false; }
  }
  return {
    snapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    request() {
      if (disposed || options.enabled !== true || receipt || !matches() || !['idle', 'rejected'].includes(state.phase)) return;
      set('confirming');
    },
    cancel() {
      if (disposed || !['confirming', 'verifying'].includes(state.phase)) return;
      generation++; set('idle');
    },
    async confirm(confirmation: 'delete-account-v1') {
      if (disposed || options.enabled !== true || receipt || state.phase !== 'confirming' || confirmation !== 'delete-account-v1' || !matches()) return;
      const current = ++generation; set('verifying');
      let proof;
      try { proof = await options.reverify(); }
      catch { if (!disposed && current === generation) set('rejected', 'Hisob egasini tasdiqlab bo‘lmadi.'); return; }
      if (disposed || current !== generation) return;
      if (!proof) { set('idle'); return; }
      if (!matches() || proof.clerkUserId !== scope.clerkUserId || proof.clerkSessionId !== scope.clerkSessionId || typeof proof.token !== 'string' || !proof.token) {
        set('rejected', 'Kabinet va tasdiqlangan hisob mos emas.'); return;
      }
      let next: Receipt;
      try { next = (options.makeReceipt ?? newDeletionReceipt)(); } catch { set('rejected', 'Tekshiruv ma’lumotini yaratib bo‘lmadi.'); return; }
      if (!validReceipt(next)) { set('rejected', 'Tekshiruv ma’lumotini yaratib bo‘lmadi.'); return; }
      try { options.store.write(next); } catch { set('rejected', 'Natijani saqlash imkoni yo‘q. O‘chirish yuborilmadi.'); return; }
      receipt = next; set('submitting');
      // Cancellation after this point cannot promise the request was undone.
      try {
        const result = await options.port.submit({...next, clerkToken: proof.token, confirmation});
        if (disposed) return;
        set('pending', result.status === 'pending' ? 'O‘chirish davom etmoqda.' : 'Natija tasdiqlanmadi. Qayta tekshiring.');
      } catch (error) {
        if (error instanceof DefiniteDeletionRejection) {
          try { options.store.remove(next, 'rejected'); receipt = null; }
          catch { set('status_unavailable', 'So‘rov rad etildi, saqlangan holatni tozalab bo‘lmadi.'); return; }
          set('rejected', 'O‘chirish so‘rovi qabul qilinmadi.');
        } else set('pending', 'So‘rov natijasi noaniq. Yangisini yubormasdan holatni tekshiring.');
      }
    },
    refresh,
    dispose() { generation++; disposed = true; listeners.clear(); },
  };
}

/** Key must belong to the captured cabinet/Clerk pairing; never use a global key.
 * Stores only a random status capability, never an app access token or Clerk JWT. */
export function browserDeletionReceiptStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>, scope: Pick<Scope, 'personId' | 'clerkUserId'>): ReceiptStore {
  const prefix = 'ua:deletion:v1:' + JSON.stringify([scope.personId, scope.clerkUserId]) + ':';
  function parse(raw:string):Receipt {
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=='object'||!('requestId'in value)||!('receipt'in value)||typeof value.requestId!=='string'||typeof value.receipt!=='string')throw new Error('Invalid receipt');
    const receipt={requestId:value.requestId,receipt:value.receipt};
    if(!validReceipt(receipt))throw new Error('Invalid receipt');
    return receipt;
  }
  return {
    read() {
      const keys:string[]=[];
      for(let n=0;n<storage.length;n++){const key=storage.key(n);if(key?.startsWith(prefix))keys.push(key)}
      for(const key of keys.sort()){
        const raw=storage.getItem(key);if(raw===null)continue;
        const receipt=parse(raw);if(key!==prefix+receipt.requestId)throw new Error('Invalid receipt');
        return receipt;
      }
      return null;
    },
    write(value) {
      if(!validReceipt(value))throw new Error('Invalid receipt');
      const key=prefix+value.requestId,raw=storage.getItem(key);
      if(raw!==null&&parse(raw).receipt!==value.receipt)throw new Error('Receipt changed');
      storage.setItem(key,JSON.stringify(value));
    },
    remove(expected) {
      if(!validReceipt(expected))throw new Error('Invalid receipt');
      const key=prefix+expected.requestId,raw=storage.getItem(key);if(raw===null)return;
      const saved=parse(raw);
      if(saved.requestId!==expected.requestId||saved.receipt!==expected.receipt)throw new Error('Receipt changed');
      // A different request has a different key, even if another tab writes now.
      storage.removeItem(key);
    },
  };
}
