import type {Receipt, ReceiptStore} from './controller.ts';
import {DeletionStatusMissing} from './controller.ts';

export const RECOVERY_INDEX_CHANGED = 'ua-deletion-recovery-index-changed';
function announceChange() { if(typeof window !== 'undefined') window.dispatchEvent(new Event(RECOVERY_INDEX_CHANGED)); }
const KEY = 'ua:deletion:recovery:v1';
const valid = (x: unknown): x is Receipt => !!x && typeof x === 'object' && 'requestId' in x && typeof x.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.requestId) && 'receipt' in x && typeof x.receipt === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(x.receipt);
/** Device-local status capabilities only. No identities, JWTs or app tokens. */
export function createRecoveryIndex(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>) {
  const prefix = KEY + ':';
  function scan(pendingOnly = false, tolerant = false): {tickets:Receipt[]; unreadableCount:number} {
    const found: Receipt[] = [];
    let unreadableCount=0;
    for (let n=0;n<storage.length;n++) {
      const key=storage.key(n); if(!key?.startsWith(prefix))continue;
      try {
        const raw=storage.getItem(key);if(raw===null)continue;
        const value:unknown=JSON.parse(raw);
        if(!valid(value)||key!==prefix+value.requestId)throw new Error('Recovery storage unavailable');
        // This marker only controls a device-local shortcut, never account state.
        if(pendingOnly && 'completed' in value && value.completed === true)continue;
        found.push({requestId:value.requestId,receipt:value.receipt});
      } catch(error) {
        if(!tolerant)throw error;
        // Keep corrupt bytes untouched. One damaged record must not hide others.
        unreadableCount++;
      }
    }
    return {tickets:found.sort((a,b)=>a.requestId.localeCompare(b.requestId)),unreadableCount};
  }
  return {
    read: () => scan().tickets,
    readAvailable: () => scan(false,true),
    readPending: () => scan(true,true).tickets,
    markCompleted(ticket:Receipt) {
      if(!valid(ticket))throw new Error('Invalid request');
      const key=prefix+ticket.requestId,raw=storage.getItem(key);
      if(raw===null)return;
      const stored:unknown=JSON.parse(raw);
      if(!valid(stored)||stored.requestId!==ticket.requestId||stored.receipt!==ticket.receipt)throw new Error('Recovery receipt conflict');
      storage.setItem(key,JSON.stringify({...ticket,completed:true}));
      announceChange();
    },
    add(value: Receipt) {
      if(!valid(value))throw new Error('Invalid recovery receipt');
      const key=prefix+value.requestId,raw=storage.getItem(key);
      if(raw!==null){const old:unknown=JSON.parse(raw);if(!valid(old)||old.receipt!==value.receipt)throw new Error('Recovery receipt conflict');return}
      storage.setItem(key,JSON.stringify({requestId:value.requestId,receipt:value.receipt}));
      announceChange();
    },
    remove(ticket:Receipt){
      if(!valid(ticket))throw new Error('Invalid request');
      const key=prefix+ticket.requestId,raw=storage.getItem(key);
      if(raw===null)return;
      const stored:unknown=JSON.parse(raw);
      if(!valid(stored)||stored.requestId!==ticket.requestId||stored.receipt!==ticket.receipt)throw new Error('Recovery receipt conflict');
      storage.removeItem(key);
      announceChange();
    },
  };
}
export type RecoveryIndex = ReturnType<typeof createRecoveryIndex>;
/** Compose with the scoped controller store BEFORE submitting. Failure blocks submit.
 * Index first: partial storage failure can leave an unsubmitted ticket (404 stays
 * unavailable), but cannot leave an accepted job without a recoverable ticket. */
export function withRecoveryIndex(scoped: ReceiptStore, index: RecoveryIndex): ReceiptStore {
  return {
    read: () => scoped.read(),
    write(value) {
      index.add(value);
      try{scoped.write(value)}catch(error){
        // No submit occurs after a failed durable write. Roll back only this ticket.
        try{index.remove(value)}catch{/* preserve if exact rollback cannot be proven */}
        throw error;
      }
    },
    // Only authoritative completion or definite pre-acceptance rejection calls remove.
    remove: (expected,outcome) => { scoped.remove(expected); if(outcome==='completed')index.markCompleted(expected);else index.remove(expected); },
  };
}
export type RecoveryState = Readonly<{phase:'idle'|'checking'|'pending'|'completed'|'unavailable'; message:string}>;
/** No account/session input and no logout or delete callback by construction. */
export function createPublicRecovery(options: {
  ticket: Receipt;
  status(receipt:string): Promise<{status:'pending'|'completed'}>;
  onCompleted?: (ticket: Receipt) => void;
}) {
  if (!valid(options.ticket)) throw new Error('Invalid recovery receipt');
  const ticket = {...options.ticket};
  let state: RecoveryState = {phase:'idle',message:''}, busy=false, disposed=false;
  const listeners=new Set<()=>void>();
  const set=(next:RecoveryState)=>{if(!disposed){state=Object.freeze(next);for(const fn of listeners)fn()}};
  return {
    snapshot:()=>state,
    subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn)}},
    async refresh(){
      if(disposed||busy||state.phase==='completed')return;
      busy=true;set({phase:'checking',message:'Natija tekshirilmoqda.'});
      try {
        const result=await options.status(ticket.receipt);
        if(result.status==='completed'){
          if(disposed)return;
          // A failed optional visibility marker must not hide the real server result.
          try{options.onCompleted?.(ticket)}catch{/* retain the unknown shortcut for a later read */}
          set({phase:'completed',message:'Saqlangan o‘chirish so‘rovi yakunlangan.'});
        }
        else if(result.status==='pending')set({phase:'pending',message:'O‘chirish davom etmoqda.'});
        else set({phase:'unavailable',message:'Natija tasdiqlanmadi.'});
      }catch(error){
        set({phase:error instanceof DeletionStatusMissing?'unavailable':'pending',message:error instanceof DeletionStatusMissing?'Natija topilmadi yoki tekshirish muddati tugagan. O‘chirilgani tasdiqlanmagan.':'Natija hozircha noma’lum. Qayta tekshiring.'});
      }finally{busy=false}
    },
    dispose(){disposed=true;listeners.clear()},
  };
}

/** Local-only two-step action. Does not cancel jobs or touch any account. */
export function createForgetRecovery(ticket:Receipt,index:RecoveryIndex,isCompleted:()=>boolean) {
  let confirming=false;
  return {
    request(){if(isCompleted())confirming=true},
    cancel(){confirming=false},
    confirm(){if(!confirming||!isCompleted())return false;index.remove(ticket);confirming=false;return true},
  };
}
