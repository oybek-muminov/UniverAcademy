import type {Receipt, ReceiptStore} from './controller.ts';
import {DeletionStatusMissing} from './controller.ts';

const KEY = 'ua:deletion:recovery:v1';
const valid = (x: unknown): x is Receipt => !!x && typeof x === 'object' && 'requestId' in x && typeof x.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x.requestId) && 'receipt' in x && typeof x.receipt === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(x.receipt);
/** Device-local status capabilities only. No identities, JWTs or app tokens. */
export function createRecoveryIndex(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>) {
  const prefix = KEY + ':';
  function read(): Receipt[] {
    const found: Receipt[] = [];
    for (let n=0;n<storage.length;n++) {
      const key=storage.key(n); if(!key?.startsWith(prefix))continue;
      const raw=storage.getItem(key);if(raw===null)continue;
      const value:unknown=JSON.parse(raw);
      if(!valid(value)||key!==prefix+value.requestId)throw new Error('Recovery storage unavailable');
      found.push({requestId:value.requestId,receipt:value.receipt});
    }
    return found.sort((a,b)=>a.requestId.localeCompare(b.requestId));
  }
  return {
    read,
    add(value: Receipt) {
      if(!valid(value))throw new Error('Invalid recovery receipt');
      const key=prefix+value.requestId,raw=storage.getItem(key);
      if(raw!==null){const old:unknown=JSON.parse(raw);if(!valid(old)||old.receipt!==value.receipt)throw new Error('Recovery receipt conflict');return}
      storage.setItem(key,JSON.stringify({requestId:value.requestId,receipt:value.receipt}));
    },
    remove(ticket:Receipt){
      if(!valid(ticket))throw new Error('Invalid request');
      const key=prefix+ticket.requestId,raw=storage.getItem(key);
      if(raw===null)return;
      const stored:unknown=JSON.parse(raw);
      if(!valid(stored)||stored.requestId!==ticket.requestId||stored.receipt!==ticket.receipt)throw new Error('Recovery receipt conflict');
      storage.removeItem(key);
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
    remove: (expected,outcome) => { scoped.remove(expected); if(outcome!=='completed')index.remove(expected); },
  };
}
export type RecoveryState = Readonly<{phase:'idle'|'checking'|'pending'|'completed'|'unavailable'; message:string}>;
/** No account/session input and no logout or delete callback by construction. */
export function createPublicRecovery(options: {
  ticket: Receipt;
  status(receipt:string): Promise<{status:'pending'|'completed'}>;
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
        if(result.status==='completed')set({phase:'completed',message:'Saqlangan o‘chirish so‘rovi yakunlangan.'});
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
