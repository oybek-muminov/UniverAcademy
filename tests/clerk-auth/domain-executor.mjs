import {firstTestExecutor} from "../first-test/executor.mjs";
import assert from "node:assert/strict";
const uuid=v=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(v);
function parameters(v,n){
  assert.ok(Array.isArray(v)&&v.length===n&&Reflect.ownKeys(v).length===n+1,"FIXTURE_CLERK_VALUES_SHAPE");
  for(let i=0;i<n;i++)assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(v,String(i))??{},"value"),"FIXTURE_CLERK_VALUES_SHAPE");
}
function identity(issuer,subject){
  let origin=false;try{origin=typeof issuer==="string"&&issuer.startsWith("https://")&&new URL(issuer).origin===issuer;}catch{}
  assert.ok(origin&&typeof subject==="string"&&/^user_[A-Za-z0-9]+(?![\s\S])/.test(subject),"FIXTURE_CLERK_IDENTITY");
}
const sessionReads={
  ua_clerk_families:["SELECT id::text,person_id::text,expires_at_ms::text,revoked_at_ms::text,logout_retain_until_ms::text,auth_provider FROM ua_private.student_families WHERE person_id=$1","id","ua_http_families"],
  ua_clerk_bindings:["SELECT b.family_id::text,b.person_id::text,b.issuer,b.subject,b.sid FROM ua_private.clerk_family_bindings b JOIN ua_private.student_families f ON f.id=b.family_id WHERE f.person_id=$1","f.id",null],
  ua_clerk_access:["SELECT a.digest,a.family_id::text,a.expires_at_ms::text,a.superseded FROM ua_private.student_access a JOIN ua_private.student_families f ON f.id=a.family_id WHERE f.person_id=$1","f.id","ua_http_access"],
  ua_clerk_refresh:["SELECT r.digest,r.family_id::text,r.consumed FROM ua_private.student_refresh r JOIN ua_private.student_families f ON f.id=r.family_id WHERE f.person_id=$1","f.id","ua_http_refresh"]
};
// Extends existing statement/disk DOUBLE. Global queue, not SQL/RLS/isolation.
export function domainExecutor(path){
  const pool=firstTestExecutor(path),previous=pool.extension;
  const result=(rows=[])=>structuredClone({rows,rowCount:rows.length}),ack=()=>result([{}]);
  const identityLocks=new WeakMap();
  const auth=()=>{
    const event=pool.contextEvents.at(-1);assert.ok(event?.active&&event.after.phase==="auth","FIXTURE_CLERK_AUTH_ORDER");return event.after;
  };
  const personScope=personId=>{
    const context=auth();assert.ok(uuid(personId)&&context.person_id===personId&&context.person_ids===JSON.stringify([personId]),"FIXTURE_SESSION_PERSON_SCOPE");
    const events=pool.contextEvents,start=events.findLastIndex(e=>["ua_begin","ua_clerk_begin"].includes(e.name));
    assert.ok(start>=0&&events.slice(start+1).some(e=>["ua_people_lock","ua_clerk_person_lock"].includes(e.name)),"FIXTURE_SESSION_LOCK_ORDER");
  };
  pool.extension=async(statement,d)=>{
    const {name,text,values:v}=statement;
    d.clerkIdentities??={};d.clerkBindings??={};d.clerkFences??={};d.clerkReplays??={};
    if(pool.clerkHook)await pool.clerkHook(name,d);
    if(name==="ua_clerk_identity_gate"){
      assert.equal(text,"SELECT pg_advisory_xact_lock(1430348620,hashtext($1))","FIXTURE_CLERK_GATE_SQL");parameters(v,1);assert.equal(typeof v[0],"string","FIXTURE_CLERK_GATE_IDENTITY");
      let pair;try{pair=JSON.parse(v[0]);}catch{assert.fail("FIXTURE_CLERK_GATE_IDENTITY");}
      assert.ok(Array.isArray(pair)&&pair.length===2&&JSON.stringify(pair)===v[0],"FIXTURE_CLERK_GATE_IDENTITY");identity(...pair);
      const context=auth();assert.equal(context.person_ids,"[]","FIXTURE_CLERK_GATE_ORDER");assert.equal(identityLocks.has(d),false,"FIXTURE_CLERK_GATE_ORDER");
      identityLocks.set(d,{pair,mapping:null});return result();
    }
    if(name==="ua_clerk_clock")return result([{now_ms:String(pool.now)}]);
    if(name==="ua_clerk_locate"){
      assert.equal(text,"SELECT person_id::text,enabled FROM ua_private.lock_clerk_identity($1::text,$2::text)","FIXTURE_CLERK_MAPPING_SQL");parameters(v,2);identity(...v);
      const context=auth(),lock=identityLocks.get(d);assert.ok(lock,"FIXTURE_CLERK_GATE_ORDER");assert.deepEqual(v,lock.pair,"FIXTURE_CLERK_GATE_BINDING");
      assert.equal(context.person_ids,"[]","FIXTURE_CLERK_MAPPING_ORDER");assert.equal(context.clerk_issuer,v[0],"FIXTURE_CLERK_CONTEXT_BINDING");assert.equal(context.clerk_subject,v[1],"FIXTURE_CLERK_CONTEXT_BINDING");
      const r=d.clerkIdentities[JSON.stringify(v)];
      if(!r){lock.mapping=null;return result();}
      assert.ok(uuid(r.personId)&&typeof r.enabled==="boolean","FIXTURE_CLERK_MAPPING_SHAPE");lock.mapping={personId:r.personId,enabled:r.enabled};
      return result([{person_id:r.personId,enabled:r.enabled}]);
    }
    if(["ua_clerk_locator","ua_clerk_current_mapping"].includes(name)){
      const r=d.clerkIdentities[JSON.stringify(v.slice(0,2))];return result(r&&(name==="ua_clerk_locate"||r.enabled)&&(name!=="ua_clerk_current_mapping"||r.personId===v[2])?[{person_id:r.personId}]:[]);
    }
    if(name==="ua_clerk_person_lock"){
      assert.equal(text,"SELECT id::text FROM ua_private.lock_people($1::uuid[]) ORDER BY id","FIXTURE_CLERK_PEOPLE_SQL");parameters(v,1);const ids=v[0];
      if(Array.isArray(ids))parameters(ids,ids.length);
      assert.ok(Array.isArray(ids)&&ids.length>0&&ids.every((id,i)=>uuid(id)&&(i===0||ids[i-1]<id)),"FIXTURE_CLERK_PEOPLE_IDS");
      const context=auth(),lock=identityLocks.get(d);assert.ok(lock?.mapping?.enabled,"FIXTURE_CLERK_MAPPING_ORDER");assert.ok(ids.includes(lock.mapping.personId),"FIXTURE_CLERK_MAPPING_SCOPE");assert.equal(context.person_ids,JSON.stringify(ids),"FIXTURE_CLERK_PEOPLE_CONTEXT");
      return result(ids.filter(id=>Object.hasOwn(d.people,id)).map(id=>({id})));
    }
    if(name==="ua_clerk_session_family"){
      parameters(v,2);assert.ok(typeof v[0]==="string"&&/^[0-9a-f]{64}(?![\s\S])/.test(v[0]),"FIXTURE_SESSION_DIGEST");personScope(v[1]);
      const tables=["student_access","student_refresh"],table=tables.find(t=>text===`SELECT p.family_id::text FROM ua_private.${t} p JOIN ua_private.student_families f ON f.id=p.family_id WHERE p.digest=$1 AND f.person_id=$2`);
      assert.ok(table,"FIXTURE_SESSION_FAMILY_SQL");const proof=(table==="student_access"?d.access:d.refresh)[v[0]],family=proof&&d.families[proof.family_id];
      if(!family||family.person_id!==v[1])return result();assert.ok(uuid(proof.family_id),"FIXTURE_SESSION_FAMILY_SHAPE");return result([{family_id:proof.family_id}]);
    }
    if(Object.hasOwn(sessionReads,name)){
      assert.ok(v.length===1||v.length===2,"FIXTURE_SESSION_READ_VALUES");parameters(v,v.length);personScope(v[0]);const[sql,column,delegate]=sessionReads[name],scoped=v.length===2;
      if(scoped)assert.ok(uuid(v[1]),"FIXTURE_SESSION_FAMILY_ID");assert.equal(text,sql+(scoped?` AND ${column}=$2`:""),"FIXTURE_SESSION_READ_SQL");
      const full=delegate?await previous({name:delegate,values:[v[0]]},d):result(Object.entries(d.clerkBindings).filter(([id])=>d.families[id]?.person_id===v[0]).map(([id,r])=>({family_id:id,person_id:r.personId,issuer:r.issuer,subject:r.userId,sid:r.sessionId})));
      return result(full.rows.filter(row=>!scoped||(name==="ua_clerk_families"?row.id:row.family_id)===v[1]));
    }
    if(name==="ua_clerk_person")return previous({name:"ua_http_person",values:v},d);
    if(name==="ua_clerk_membership"){const m=d.memberships[v[0]];return result(m?[{active:m.active,epoch:String(m.epoch),revision:String(m.revision),affinity_group_id:m.affinity_group_id}]:[]);}
    if(name==="ua_clerk_identities")return result(Object.entries(d.clerkIdentities).filter(([,r])=>r.personId===v[0]).map(([key,r])=>{const [issuer,subject]=JSON.parse(key);return{issuer,subject,person_id:r.personId,enabled:r.enabled};}));
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
