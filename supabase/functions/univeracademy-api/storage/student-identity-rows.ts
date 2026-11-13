import {fail} from "../fault.ts";
import {newQadamId} from "../student-state.ts";
import type {Person} from "../student-state.ts";
import {verifyTelegramInitData} from "../telegram.ts";
import type {SessionPolicy} from "../student-state.ts";
import {query} from "./postgres-transaction.ts";
import type {IdentityTransaction} from "./postgres-transaction.ts";

export class StudentIdentityRows {
  private readonly personId:()=>string;
  private readonly qadamId:()=>string;
  constructor(ids:{personId?:()=>string;qadamId?:()=>string}={}){
    this.personId=ids.personId??(()=>crypto.randomUUID());this.qadamId=ids.qadamId??newQadamId;
  }
  async ensure(gate:IdentityTransaction,raw:string,config:{botToken:string;sessionPolicy:SessionPolicy}):Promise<string>{
    const seconds=Math.floor(gate.now/1000),policy=config.sessionPolicy;
    const identity=await verifyTelegramInitData(raw,config.botToken,{notBeforeSeconds:Math.max(0,seconds-policy.initDataMaxAgeSeconds),notAfterSeconds:seconds+policy.futureSkewSeconds});
    if(identity.telegramUserId!==gate.telegramId||gate.personIds.length)fail("INIT_DATA_INVALID",401);
    if(!Number.isSafeInteger(policy.identityCollisionAttempts)||policy.identityCollisionAttempts<=0)fail("SERVICE_UNAVAILABLE",503);
    const existing=async()=>{
      const r=await query(gate,"ua_identity_person","SELECT id::text FROM ua_private.people WHERE telegram_id=$1",[identity.telegramUserId]);
      if(r.rows.length>1)fail("RESPONSE_INVARIANT_FAILED",500);
      return r.rows[0]?.id as string|undefined;
    };
    const found=await existing();if(found)return found;
    for(let n=0;n<policy.identityCollisionAttempts;n++){
      const id=this.personId(),qadam=this.qadamId();
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)||!/^\d{10}$/.test(qadam))fail("SERVICE_UNAVAILABLE",503);
      const profile:Person["profile"]={person_id:id,first_name:identity.firstName,last_name:identity.lastName??"",roles:["student"],registration_complete:false,active_group_id:null,qadam_id:qadam};
      const created=await query(gate,"ua_identity_insert","INSERT INTO ua_private.people(id,telegram_id,qadam_id,enabled,roles,profile) VALUES($1,$2,$3,true,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING id::text",[id,identity.telegramUserId,qadam,["student"],JSON.stringify(profile)]);
      if(created.rowCount===1){
        if(created.rows[0]?.id!==id)fail("RESPONSE_INVARIANT_FAILED",500);
        const membership=await query(gate,"ua_identity_membership","INSERT INTO ua_private.memberships(person_id,active,epoch,affinity_group_id,revision) VALUES($1,false,0,NULL,0) RETURNING person_id",[id]);
        if(membership.rowCount!==1)fail("RESPONSE_INVARIANT_FAILED",500);
        return id;
      }
      // A unique Telegram conflict from another compliant writer resolves to its
      // canonical person; Qadam/UUID collisions get a fresh candidate, never an overwrite.
      const canonical=await existing();if(canonical)return canonical;
    }
    fail("SERVICE_UNAVAILABLE",503);
  }
}
