import {firstTestExecutor} from "../first-test/executor.mjs";
// Extends existing statement/disk DOUBLE. Global queue, not SQL/RLS/isolation.
export function domainExecutor(path){
  const pool=firstTestExecutor(path),previous=pool.extension;
  const result=(rows=[])=>structuredClone({rows,rowCount:rows.length}),ack=()=>result([{}]);
  pool.extension=async(statement,d)=>{
    const {name,values:v}=statement;
    d.clerkIdentities??={};d.clerkBindings??={};d.clerkFences??={};d.clerkReplays??={};
    if(pool.clerkHook)await pool.clerkHook(name,d);
    if(["ua_clerk_identity_gate","ua_clerk_identity_context","ua_clerk_person_context"].includes(name))return result();
    if(name==="ua_clerk_clock")return result([{now_ms:String(pool.now)}]);
    if(["ua_clerk_locate","ua_clerk_locator","ua_clerk_current_mapping"].includes(name)){
      const r=d.clerkIdentities[JSON.stringify(v.slice(0,2))];return result(r&&(name==="ua_clerk_locate"||r.enabled)&&(name!=="ua_clerk_current_mapping"||r.personId===v[2])?[{person_id:r.personId}]:[]);
    }
    if(name==="ua_clerk_person_lock")return result(d.people[v[0]]?[{id:v[0]}]:[]);
    if(name==="ua_clerk_person")return previous({name:"ua_http_person",values:v},d);
    if(name==="ua_clerk_membership"){const m=d.memberships[v[0]];return result(m?[{active:m.active,epoch:String(m.epoch),revision:String(m.revision),affinity_group_id:m.affinity_group_id}]:[]);}
    if(name==="ua_clerk_identities")return result(Object.entries(d.clerkIdentities).filter(([,r])=>r.personId===v[0]).map(([key,r])=>{const [issuer,subject]=JSON.parse(key);return{issuer,subject,person_id:r.personId,enabled:r.enabled};}));
    if(name==="ua_clerk_families")return previous({name:"ua_http_families",values:v},d);
    if(name==="ua_clerk_access"||name==="ua_clerk_refresh")return previous({name:name==="ua_clerk_access"?"ua_http_access":"ua_http_refresh",values:v},d);
    if(name==="ua_clerk_bindings")return result(Object.entries(d.clerkBindings).filter(([id])=>d.families[id]?.person_id===v[0]).map(([id,r])=>({family_id:id,person_id:r.personId,issuer:r.issuer,subject:r.userId,sid:r.sessionId})));
    if(name==="ua_clerk_fences")return result(Object.entries(d.clerkFences).filter(([,r])=>r.personId===v[0]).map(([key,r])=>{const [issuer,subject,sid]=JSON.parse(key);return{issuer,subject,sid,person_id:r.personId,retired_at_ms:r.retiredAt===null?null:String(r.retiredAt)};}));
    if(name==="ua_clerk_replays")return result(Object.entries(d.clerkReplays).filter(([,r])=>r.personId===v[0]).map(([digest,r])=>({digest,person_id:r.personId})));
    if(name==="ua_clerk_person_insert"){
      if(d.people[v[0]]||Object.values(d.people).some(p=>p.profile.qadam_id===v[1]))return result();
      d.people[v[0]]={telegram_id:null,enabled:v[2],roles:v[3],profile:JSON.parse(v[4])};return ack();
    }
    if(name==="ua_clerk_member_insert"){if(d.memberships[v[0]])return result();d.memberships[v[0]]={active:false,epoch:0,revision:0,affinity_group_id:null};return ack();}
    if(name==="ua_clerk_identity_insert"){const key=JSON.stringify(v.slice(0,2));if(d.clerkIdentities[key])return result();d.clerkIdentities[key]={personId:v[2],enabled:true};return ack();}
    if(name==="ua_clerk_profile_update")return previous({name:"ua_http_profile_write",values:v},d);
    if(name==="ua_clerk_replay_insert"){if(d.clerkReplays[v[0]])return result();d.clerkReplays[v[0]]={personId:v[1],at:v[2]};return ack();}
    if(name==="ua_clerk_fence_write"){const key=JSON.stringify(v.slice(0,3)),old=d.clerkFences[key];if(old&&old.personId!==v[3])return result();d.clerkFences[key]={personId:v[3],retiredAt:old?.retiredAt??v[4]};return ack();}
    if(name==="ua_clerk_family_revoke"){const f=d.families[v[2]];if(!f||f.person_id!==v[3]||f.revoked_at_ms!==null)return result();f.revoked_at_ms=v[0];f.logout_retain_until_ms=v[1];return ack();}
    if(name==="ua_clerk_family_insert"){if(d.families[v[0]]||Object.values(d.families).some(f=>f.person_id===v[1]&&f.revoked_at_ms===null))return result();d.families[v[0]]={person_id:v[1],expires_at_ms:v[2],revoked_at_ms:v[3],logout_retain_until_ms:v[4],auth_provider:v[5]};return ack();}
    if(name==="ua_clerk_binding_insert"){if(d.clerkBindings[v[0]])return result();d.clerkBindings[v[0]]={issuer:v[1],userId:v[2],sessionId:v[3],personId:v[4]};return ack();}
    if(name==="ua_clerk_access_write"||name==="ua_clerk_refresh_write")return previous({name:name==="ua_clerk_access_write"?"ua_http_access_merge":"ua_http_refresh_merge",values:v},d);
    if(name==="ua_clerk_staff_access"){
      const link=d.clerkIdentities[JSON.stringify(v.slice(0,2))],p=d.people[v[2]],a=d.staffAccess[v[2]];
      return result(link?.enabled&&link.personId===v[2]&&p&&a?[{id:v[2],enabled:p.enabled,roles:p.roles,...a}]:[]);
    }
    return previous(statement,d);
  };
  return pool;
}
