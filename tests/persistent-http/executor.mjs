import {DiskExecutor,durableWrite} from "../storage-auth/disk-executor.mjs";
import {encodePublished} from "../../supabase/functions/univeracademy-api/storage/attempt-rows.ts";

export function seedStudent(path,s){
  const people=Object.fromEntries(Object.entries(s.people).map(([id,p])=>[id,{telegram_id:p.telegramId,enabled:p.enabled,roles:p.profile.roles,profile:p.profile}]));
  const assignments=Object.fromEntries(Object.entries(s.assignments).map(([id,a])=>[id,{...a,published:encodePublished(a.published)}]));
  const memberships=Object.fromEntries(Object.entries(s.people).map(([id,p])=>[id,{active:p.profile.active_group_id!==null,epoch:Object.values(s.grants[id]??{})[0]?.membershipEpoch??0}]));
  durableWrite(path,{people,assignments,grants:s.grants,memberships,families:{},access:{},refresh:{},replays:{},series:{},attempts:{},answers:{},results:{},receipts:{},bonuses:{},cancellations:{}});
}
export function httpExecutor(path){
  const pool=new DiskExecutor(path);const result=(rows=[])=>({rows,rowCount:rows.length});const ack=()=>result([{}]);
  pool.extension=async({name,values:v},d)=>{
    const familyRows=()=>Object.entries(d.families).filter(([,f])=>f.person_id===v[0]);
    if(name==="ua_telegram_identity_lock")return result();
    if(name==="ua_identity_person")return result(Object.entries(d.people).filter(([,p])=>p.telegram_id===v[0]).map(([id])=>({id})));
    if(name==="ua_identity_insert"){
      if(d.people[v[0]]||Object.values(d.people).some(p=>p.telegram_id===v[1]||p.profile?.qadam_id===v[2]))return result();
      d.people[v[0]]={telegram_id:v[1],qadam_id:v[2],enabled:true,roles:v[3],profile:JSON.parse(v[4])};return result([{id:v[0]}]);
    }
    if(name==="ua_identity_membership"){
      if(d.memberships[v[0]])throw Error("SYNTHETIC_MEMBERSHIP_UNIQUE");
      d.memberships[v[0]]={active:false,epoch:0,affinity_group_id:null,revision:0};return result([{person_id:v[0]}]);
    }
    if(name==="ua_staff_identity_locate"){
      const i=d.staffIdentities?.[v[0]+"|"+v[1]];return result(i&&i.revoked_at_ms===null?[{person_id:i.person_id}]:[]);
    }
    if(name==="ua_staff_access_current"){
      const i=d.staffIdentities?.[v[0]+"|"+v[1]],p=d.people[v[2]],a=d.staffAccess?.[v[2]];
      return result(i&&i.person_id===v[2]&&i.revoked_at_ms===null&&p&&a?[{id:v[2],enabled:p.enabled,roles:p.roles,...a}]:[]);
    }
    if(name==="ua_staff_group_scope"||name==="ua_staff_subject_scope"||name==="ua_staff_teacher_subjects"){
      const table=name==="ua_staff_group_scope"?d.staffGroups:name==="ua_staff_subject_scope"?d.staffSubjects:d.teacherSubjects;
      return result((table?.[v[0]]??[]).filter(r=>r.revoked_at_ms===null&&(name!=="ua_staff_teacher_subjects"||r.approved===true)));
    }
    if(name==="ua_locate_telegram")return result(Object.entries(d.people).filter(([,p])=>p.telegram_id===v[0]).map(([id])=>({person_id:id})));
    if(name==="ua_locate_access"||name==="ua_locate_refresh"){
      const p=(name==="ua_locate_access"?d.access:d.refresh)[v[0]],f=p&&d.families[p.family_id];return result(f?[{person_id:f.person_id}]:[]);
    }
    if(name==="ua_http_person"){const p=d.people[v[0]];return result(p?[{...p,telegram_id:p.telegram_id===null?null:String(p.telegram_id)}]:[]);}
    if(name==="ua_http_families")return result(familyRows().map(([id,f])=>({id,...f,expires_at_ms:String(f.expires_at_ms),
      revoked_at_ms:f.revoked_at_ms===null?null:String(f.revoked_at_ms),logout_retain_until_ms:f.logout_retain_until_ms===null?null:String(f.logout_retain_until_ms)})));
    if(name==="ua_http_access"||name==="ua_http_refresh")return result(Object.entries(name==="ua_http_access"?d.access:d.refresh)
      .filter(([,p])=>d.families[p.family_id]?.person_id===v[0]).map(([digest,p])=>({digest,...p,...(name==="ua_http_access"?{expires_at_ms:String(p.expires_at_ms)}:{})})));
    if(name==="ua_http_replays")return result(Object.entries(d.replays).filter(([,person])=>person===v[0]).map(([digest])=>({digest})));
    if(name==="ua_http_grants")return result(Object.entries(d.grants[v[0]]??{}).map(([assignment_id,g])=>({assignment_id,rostered:g.rostered&&!!d.memberships[v[0]]?.active,membership_epoch:String(d.memberships[v[0]]?.epoch??-1),grant_epoch:String(g.grantEpoch)})));
    if(name==="ua_http_assignments")return result(Object.entries(d.assignments).filter(([id])=>d.grants[v[0]]?.[id]||Object.values(d.attempts).some(a=>a.body.personId===v[0]&&a.body.assignmentId===id)).map(([,record])=>({record})));
    if(name==="ua_http_series")return result(Object.entries(d.series).filter(([key])=>key.startsWith(v[0]+"/")).map(([key,s])=>({
      demo_id:key.slice(v[0].length+1),id:s.id,current_attempt_id:s.currentAttemptId,generation:String(s.generation),normal_attempt_used:s.normalAttemptUsed,
      official_attempt_id:s.officialAttemptId,recovery_state:s.recoveryState,recovery_window:s.recovery})));
    if(name==="ua_http_attempt_ids")return result(Object.entries(d.attempts).filter(([,a])=>a.body.personId===v[0]).map(([id])=>({id})));
    if(name==="ua_http_receipts")return result(Object.entries(d.receipts).filter(([key])=>key.startsWith(v[0]+"/")).map(([key,r])=>({key,payload:r.payload,attempt_id:r.attemptId})));
    if(name==="ua_http_bonuses")return result(Object.entries(d.bonuses??{}).filter(([,b])=>b.personId===v[0]).map(([attempt_id,b])=>{const {personId,...record}=b;return{attempt_id,record};}));
    if(name==="ua_http_cancellations")return result([]);
    if(name==="ua_http_profile_write"){if(!d.people[v[1]])return result();d.people[v[1]].profile=JSON.parse(v[0]);return ack();}
    if(name==="ua_http_family_merge"){
      const old=d.families[v[0]];
      if(old){if(old.person_id!==v[1])return result();if(old.revoked_at_ms===null){old.revoked_at_ms=v[3];old.logout_retain_until_ms=v[4];}}
      else{if(v[3]===null&&Object.values(d.families).some(f=>f.person_id===v[1]&&f.revoked_at_ms===null))throw Error("SYNTHETIC_ACTIVE_FAMILY_UNIQUE");
        d.families[v[0]]={person_id:v[1],expires_at_ms:v[2],revoked_at_ms:v[3],logout_retain_until_ms:v[4],auth_provider:v[5]};}return ack();
    }
    if(name==="ua_http_access_merge"){
      const old=d.access[v[0]];if(old){if(old.family_id!==v[1]||old.expires_at_ms!==v[2])return result();old.superseded ||=v[3];}
      else d.access[v[0]]={family_id:v[1],expires_at_ms:v[2],superseded:v[3]};return ack();
    }
    if(name==="ua_http_refresh_merge"){
      const old=d.refresh[v[0]];if(old){if(old.family_id!==v[1])return result();old.consumed ||=v[2];}
      else d.refresh[v[0]]={family_id:v[1],consumed:v[2]};return ack();
    }
    if(name==="ua_attempt_insert"){
      if(d.attempts[v[0]])return result();d.attempts[v[0]]={body:JSON.parse(v[6]),frozen_test:JSON.parse(v[7]),question_order:JSON.parse(v[8])};return ack();
    }
    if(name==="ua_http_series_merge"){
      const key=v[0]+"/"+v[1],old=d.series[key];if(old&&(old.currentAttemptId!==v[10]||old.generation!==v[11]))return result();
      d.series[key]={id:v[2],currentAttemptId:v[3],generation:v[4],stateRevision:v[5],normalAttemptUsed:v[6],officialAttemptId:v[7],recoveryState:v[8],recovery:JSON.parse(v[9])};return ack();
    }
    if(name==="ua_http_receipt_insert"){if(d.receipts[v[1]])return result();d.receipts[v[1]]={payload:v[2],attemptId:v[3]};return ack();}
    if(name==="ua_contract_staff_load")return result([structuredClone(d.staffProjection)]);
    if(name==="ua_contract_staff_write"){d.staffProjection=JSON.parse(v[0]);return ack();}
    if(name==="ua_contract_staff_session")return result(d.providerSessions?.[v[0]]===v[1]?[{}]:[]);
  };
  return pool;
}
