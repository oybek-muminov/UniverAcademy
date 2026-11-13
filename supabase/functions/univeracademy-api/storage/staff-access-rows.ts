import {fail} from "../fault.ts";
import type {StaffAccessRecord} from "../staff-state.ts";
import type {StaffJwtProof} from "../staff-jwt.ts";
import {own,query,StorageUnavailable} from "./postgres-transaction.ts";
import type {PgPool,LockedTransaction} from "./postgres-transaction.ts";

export class StaffAccessRows {
  async locate(pool:PgPool,proof:StaffJwtProof):Promise<string>{
    let client;try{client=await pool.connect();}catch{throw new StorageUnavailable("not_committed");}
    if(typeof client?.query!=="function"||typeof client.release!=="function"){
      if(typeof client?.release==="function")client.release(true);throw new StorageUnavailable("not_committed");
    }
    try{
      const r=await client.query({name:"ua_staff_identity_locate",text:"SELECT person_id::text FROM ua_private.staff_identities WHERE issuer=$1 AND provider_subject=$2 AND revoked_at_ms IS NULL",values:[proof.issuer,proof.subject]});
      if(r.rows.length!==1)fail("STAFF_TOKEN_INVALID",401);
      return r.rows[0].person_id as string;
    }finally{client.release();}
  }
  async load(tx:LockedTransaction,proof:Pick<StaffJwtProof,"issuer"|"subject">,personId:string,source:"staff"|"clerk"="staff"):Promise<StaffAccessRecord>{
    own(tx,personId);
    const result=await query(tx,source==="clerk"?"ua_clerk_staff_access":"ua_staff_access_current",source==="clerk"?`SELECT p.id::text,p.enabled,p.roles,a.approved,a.manage_roster,a.manage_content,a.all_groups,a.all_subjects
FROM ua_private.clerk_identities i JOIN ua_private.people p ON p.id=i.person_id JOIN ua_private.staff_access a ON a.person_id=p.id
WHERE i.issuer=$1 AND i.subject=$2 AND i.person_id=$3 AND i.enabled=true`:`SELECT p.id::text,p.enabled,p.roles,a.approved,a.manage_roster,a.manage_content,a.all_groups,a.all_subjects
FROM ua_private.staff_identities i JOIN ua_private.people p ON p.id=i.person_id JOIN ua_private.staff_access a ON a.person_id=p.id
WHERE i.issuer=$1 AND i.provider_subject=$2 AND i.person_id=$3 AND i.revoked_at_ms IS NULL`,[proof.issuer,proof.subject,personId]);
    if(result.rows.length!==1)fail("STAFF_TOKEN_INVALID",401);
    const r=result.rows[0];
    if(r.id!==personId||!Array.isArray(r.roles)||r.roles.some(v=>typeof v!=="string")||
      [r.enabled,r.approved,r.manage_roster,r.manage_content,r.all_groups,r.all_subjects].some(v=>typeof v!=="boolean"))fail("RESPONSE_INVARIANT_FAILED",500);
    const roles=r.roles.filter((v):v is "teacher"|"admin"|"owner"=>v==="teacher"||v==="admin"||v==="owner");
    const groups=await query(tx,"ua_staff_group_scope","SELECT group_id::text FROM ua_private.staff_group_scope WHERE person_id=$1 AND revoked_at_ms IS NULL ORDER BY group_id",[personId]);
    const subjects=await query(tx,"ua_staff_subject_scope","SELECT subject_id FROM ua_private.staff_subject_scope WHERE person_id=$1 AND revoked_at_ms IS NULL ORDER BY subject_id",[personId]);
    const approved=await query(tx,"ua_staff_teacher_subjects","SELECT subject_id FROM ua_private.teacher_subject_approvals WHERE person_id=$1 AND approved=true AND revoked_at_ms IS NULL ORDER BY subject_id",[personId]);
    const list=(rows:Record<string,unknown>[],key:string)=>{
      if(rows.some(v=>typeof v[key]!=="string"||!v[key]))fail("RESPONSE_INVARIANT_FAILED",500);
      return [...new Set(rows.map(v=>v[key] as string))];
    };
    return{personId,enabled:r.enabled as boolean,approved:r.approved as boolean,roles,
      approvedSubjectIds:list(approved.rows,"subject_id"),capabilities:{manage_roster:r.manage_roster as boolean,manage_content:r.manage_content as boolean},
      scope:{all_groups:r.all_groups as boolean,group_ids:list(groups.rows,"group_id"),all_subjects:r.all_subjects as boolean,subject_ids:list(subjects.rows,"subject_id")}};
  }
}
