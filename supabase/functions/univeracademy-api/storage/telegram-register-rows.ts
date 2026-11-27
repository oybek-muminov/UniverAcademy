import type {PgClient,PgPool} from './postgres-transaction.ts';
import {StorageUnavailable} from './postgres-transaction.ts';
import {canonicalPersonId,resetTrustedServerContext,setTrustedPhase,setTrustedClerk,closeTrustedServerContext} from './trusted-server-context.ts';

const q=(c:PgClient,name:string,text:string,values:readonly unknown[]=[])=>c.query({name,text,values});
const unavailable=():never=>{throw new StorageUnavailable('not_committed');};

/** Quick-registration pre-checks. Each check runs in its own short
 * transaction that is always ROLLED BACK: nothing is written here. It uses the
 * same trusted-context functions, in the same order, as the atomic entry
 * (TelegramClerkEntryRows), which remains the authoritative, locking guard. */
export class TelegramRegisterRows{
  private readonly o:{pool:PgPool;issuer:string;signal?:AbortSignal};
  constructor(o:{pool:PgPool;issuer:string;signal?:AbortSignal}){this.o=o;}
  private async inspect<T>(work:(c:PgClient)=>Promise<T>):Promise<T>{
    if(this.o.signal?.aborted)unavailable();
    let c:PgClient;try{c=await this.o.pool.connect();}catch{return unavailable();}
    let began=false,discard=false;
    try{
      await q(c,'ua_register_begin','BEGIN');began=true;
      await resetTrustedServerContext(c);await setTrustedPhase(c,'auth');
      const result=await work(c);
      began=false;await q(c,'ua_register_rollback','ROLLBACK');
      return result;
    }catch{
      if(began){try{await q(c,'ua_register_rollback','ROLLBACK');}catch{discard=true;}}else discard=true;
      return unavailable();
    }finally{closeTrustedServerContext(c);try{c.release(discard);}catch{}}
  }
  /** Any row means a cabinet already owns this Telegram ID (enabled or not). */
  telegramLinked(telegramUserId:number):Promise<boolean>{
    return this.inspect(async c=>{
      const r=await q(c,'ua_register_telegram','SELECT person_id::text FROM ua_private.locate_telegram_return($1::bigint,$2::text)',[telegramUserId,this.o.issuer]);
      if(r.rows.length>2||r.rows.some(row=>!canonicalPersonId(row.person_id)))unavailable();
      return r.rows.length>0;
    });
  }
  /** true when the Clerk user already maps to a cabinet. */
  clerkMapped(userId:string):Promise<boolean>{
    return this.inspect(async c=>{
      await setTrustedClerk(c,this.o.issuer,userId);
      const r=await q(c,'ua_register_mapping','SELECT person_id::text FROM ua_private.lock_clerk_identity($1::text,$2::text)',[this.o.issuer,userId]);
      if(r.rows.length>1||r.rows.some(row=>!canonicalPersonId(row.person_id)))unavailable();
      return r.rows.length===1;
    });
  }
}
