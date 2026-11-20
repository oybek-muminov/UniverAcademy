// Protocol double adapted from tests/clerk-auth/scoped-store.test.mjs; not native PG.
import {test} from "node:test";
import assert from "node:assert/strict";
import {ClerkScopedAuthStore} from "../../supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts";
import {clerkIdentityKey,clerkSessionKey} from "../../supabase/functions/univeracademy-api/clerk-auth.ts";
import {proofHash} from "../../supabase/functions/univeracademy-api/student-state.ts";
import {exchangeClerkSession} from "../../supabase/functions/univeracademy-api/clerk-http.ts";
import {testPolicy,testNumbers} from "../backend/http-fixture.ts";

export const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
export const at=Date.UTC(2026,10,7),who={issuer:"https://clerk.example.invalid",userId:"user_StoreA1",sessionId:"sess_StoreA1"};
export const proof=(identity=who)=>({...identity,kind:"clerk_verified",notBefore:at-1,expiresAt:at+10000,authorizedParty:"https://student.example.invalid",tokenId:crypto.randomUUID()});
const hex=n=>n.toString(16).padStart(64,"0");
const empty=()=>({people:{},members:{},identities:{},families:{},bindings:{},fences:{},access:{},refresh:{},replays:{},history:{foreign:"unchanged synthetic history"}});

// Statement-protocol double only. Its global queue is NOT Postgres locking/RLS.
export class Pool{
  state=empty();time=at;events=[];tail=Promise.resolve();fail;hook;inject;
  async connect(){
    const previous=this.tail;let release;this.tail=new Promise(r=>{release=r;});await previous;
    let draft;
    const result=rows=>({rows,rowCount:rows.length});
    return{query:async statement=>{
      let {name,text,values:v}=statement; const originalName=name;name=({ua_atomic_begin:'ua_clerk_begin',ua_atomic_commit:'ua_clerk_commit',ua_atomic_rollback:'ua_clerk_rollback',ua_atomic_clock:'ua_clerk_clock',ua_atomic_identity_gate:'ua_clerk_identity_gate',ua_atomic_telegram_gate:'ua_clerk_identity_gate',ua_atomic_mapping:'ua_clerk_locate',ua_atomic_person_lock:'ua_clerk_person_lock'})[name]??name;this.events.push({name,text,values:structuredClone(v)});if(this.hook)this.hook(name,this);
      if(this.fail===name||this.fail===originalName)throw Error("synthetic query failure");
      if(name==="ua_clerk_begin"){draft=structuredClone(this.state);return result([]);}
      if(name==="ua_clerk_commit"){this.state=draft;if(this.fail==="commit_after")throw Error("unknown commit");return result([]);}
      if(name==="ua_clerk_rollback")return result([]);
      if(name==='ua_atomic_telegram_owner'){
        const match=Object.entries(draft.people).find(([,p])=>p.telegramId===v[0]);if(!match)return result([]);
        const [pid,p]=match,linked=Object.entries(draft.identities).filter(([key,r])=>r.personId===pid&&JSON.parse(key)[0]===v[1]);
        return result(linked.length?linked.map(([key,r])=>({person_id:pid,person_enabled:p.enabled,issuer:JSON.parse(key)[0],subject:JSON.parse(key)[1],identity_enabled:r.enabled})):[{person_id:pid,person_enabled:p.enabled,issuer:null,subject:null,identity_enabled:null}]);
      }
      if(name==='ua_atomic_link'){
       const p=draft.people[v[0]];if(!p||p.telegramId!==null&&p.telegramId!==v[1]||Object.entries(draft.people).some(([id,p])=>id!==v[0]&&p.telegramId===v[1]))return result([{state:'conflict'}]);
       p.telegramId=v[1];return result([{state:'linked'}]);
      }
      if(name==='ua_atomic_replay'){draft.telegramReplays??={};if(draft.telegramReplays[v[0]])return result([]);draft.telegramReplays[v[0]]=v[1];return result([{digest:v[0]}]);}
      if(name==="ua_clerk_clock")return result([{now_ms:String(this.time)}]);
      if(name==="ua_context_reset"){assert.deepEqual(v,["deny","","[]","","",""]);assert.ok(text.endsWith("set_config('ua.telegram_id',$6,true)"));return result([]);}
      if(name==="ua_context_phase"){assert.equal(text,"SELECT set_config('ua.phase',$1,true)");assert.ok(["deny","auth","domain","exchange"].includes(v[0]));return result([]);}
      if(["ua_clerk_identity_gate","ua_clerk_identity_context","ua_people_context"].includes(name))return result([]);
      const owner=v[0],own=(map)=>Object.entries(map).filter(([,r])=>r.personId===owner);
      let rows;
      if(name==="ua_clerk_locate"){assert.equal(text,"SELECT person_id::text,enabled FROM ua_private.lock_clerk_identity($1::text,$2::text)");const r=draft.identities[JSON.stringify(v)];rows=r?[{person_id:r.personId,enabled:r.enabled}]:[];}
      else if(name==="ua_clerk_person_lock"){assert.equal(text,"SELECT id::text FROM ua_private.lock_people($1::uuid[]) ORDER BY id");assert.equal(v[0].length,1);rows=draft.people[v[0][0]]?[{id:v[0][0]}]:[];}
      else if(name==="ua_clerk_person"){const p=draft.people[owner];rows=p?[{telegram_id:p.telegramId===null?null:String(p.telegramId),enabled:p.enabled,roles:p.profile.roles,profile:p.profile}]:[];}
      else if(name==="ua_clerk_membership"){const m=draft.members[owner];rows=m?[{active:m.active,epoch:String(m.epoch),revision:String(m.revision),affinity_group_id:m.affinityGroupId}]:[];}
      else if(name==="ua_clerk_identities")rows=own(draft.identities).map(([k,r])=>{const [issuer,subject]=JSON.parse(k);return{issuer,subject,person_id:r.personId,enabled:r.enabled};});
      else if(name==="ua_clerk_families")rows=own(draft.families).map(([key,r])=>({id:key,person_id:r.personId,expires_at_ms:String(r.expiresAt),revoked_at_ms:r.revokedAt===null?null:String(r.revokedAt),logout_retain_until_ms:r.logoutRetainUntil===null?null:String(r.logoutRetainUntil),auth_provider:r.authProvider??null}));
      else if(name==="ua_clerk_bindings")rows=Object.entries(draft.bindings).filter(([key])=>draft.families[key]?.personId===owner).map(([key,r])=>({family_id:key,person_id:r.personId,issuer:r.issuer,subject:r.userId,sid:r.sessionId}));
      else if(name==="ua_clerk_fences")rows=own(draft.fences).map(([key,r])=>{const [issuer,subject,sid]=JSON.parse(key);return{issuer,subject,sid,person_id:r.personId,retired_at_ms:r.retiredAt===null?null:String(r.retiredAt)};});
      else if(name==="ua_clerk_replays")rows=own(draft.replays).map(([key,r])=>({digest:key,person_id:r.personId}));
      else if(name==="ua_clerk_access")rows=Object.entries(draft.access).filter(([,r])=>draft.families[r.familyId]?.personId===owner).map(([key,r])=>({digest:key,family_id:r.familyId,expires_at_ms:String(r.expiresAt),superseded:r.superseded}));
      else if(name==="ua_clerk_refresh")rows=Object.entries(draft.refresh).filter(([,r])=>draft.families[r.familyId]?.personId===owner).map(([key,r])=>({digest:key,family_id:r.familyId,consumed:r.consumed}));
      if(rows)return result(this.inject?this.inject(name,rows):structuredClone(rows));
      if(name==="ua_registration_write_target")return result([{expanded:true}]);
      if(name==="ua_clerk_person_insert"){
        if(draft.people[v[0]]||Object.values(draft.people).some(p=>p.profile.univeracademy_id===v[1]))return result([]);
        draft.people[v[0]]={telegramId:null,enabled:v[2],profile:JSON.parse(v[4])};
      }else if(name==="ua_clerk_member_insert")draft.members[v[0]]={active:false,epoch:0,revision:0,affinityGroupId:null};
      else if(name==="ua_clerk_identity_insert"){
        const key=JSON.stringify(v.slice(0,2));if(draft.identities[key])throw Error("identity unique conflict");draft.identities[key]={personId:v[2],enabled:true};
      }else if(name==="ua_clerk_profile_update")draft.people[v[1]].profile=JSON.parse(v[0]);
      else if(name==="ua_clerk_replay_insert"){
        if(draft.replays[v[0]])return result([]);draft.replays[v[0]]={personId:v[1],at:v[2]};
      }else if(name==="ua_clerk_fence_write")draft.fences[JSON.stringify(v.slice(0,3))]={personId:v[3],retiredAt:v[4]};
      else if(name==="ua_clerk_family_revoke")Object.assign(draft.families[v[2]],{revokedAt:v[0],logoutRetainUntil:v[1]});
      else if(name==="ua_clerk_family_insert"){
        if(Object.values(draft.families).some(f=>f.personId===v[1]&&f.revokedAt===null))throw Error("one current family");
        draft.families[v[0]]={personId:v[1],expiresAt:v[2],revokedAt:v[3],logoutRetainUntil:v[4],authProvider:v[5]};
      }else if(name==="ua_clerk_binding_insert")draft.bindings[v[0]]={issuer:v[1],userId:v[2],sessionId:v[3],personId:v[4]};
      else if(name==="ua_clerk_access_write")draft.access[v[0]]={familyId:v[1],expiresAt:v[2],superseded:v[3]};
      else if(name==="ua_clerk_refresh_write")draft.refresh[v[0]]={familyId:v[1],consumed:v[2]};
      else throw Error("Unexpected statement: "+name);
      return result([{ok:true}]);
    },release:discard=>{this.events.push({name:"release",discard});release();}};
  }
}

