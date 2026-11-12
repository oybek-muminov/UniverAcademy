// SQL EXECUTOR DOUBLE. Statement dispatch is by name; this is not PostgreSQL,
// an RLS engine, a SQL parser, or proof that the proposed SQL runs on a real DB.
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import assert from "node:assert/strict";
const resetSql="SELECT set_config('ua.phase',$1,true),set_config('ua.person_id',$2,true),set_config('ua.person_ids',$3,true),set_config('ua.clerk_issuer',$4,true),set_config('ua.clerk_subject',$5,true),set_config('ua.telegram_id',$6,true)";
const contextKeys=["phase","person_id","person_ids","clerk_issuer","clerk_subject","telegram_id"];
const controls={ua_begin:["ua_commit","ua_rollback"],ua_clerk_begin:["ua_clerk_commit","ua_clerk_rollback"],ua_locator_begin:[null,"ua_locator_rollback"],ua_clerk_locator_begin:[null,"ua_clerk_locator_rollback"]};
const uuid=v=>typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/.test(v);
function values(v,n){
  assert.ok(Array.isArray(v)&&v.length===n&&Reflect.ownKeys(v).length===n+1,"CONTEXT_VALUES_SHAPE");
  for(let i=0;i<n;i++)assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(v,String(i))??{},"value"),"CONTEXT_VALUES_SHAPE");
  return v;
}
function personIds(raw){
  assert.equal(typeof raw,"string","CONTEXT_PERSON_IDS");let ids;
  try{ids=JSON.parse(raw);}catch{assert.fail("CONTEXT_PERSON_IDS");}
  assert.ok(Array.isArray(ids)&&ids.length>0&&ids.every((id,i)=>uuid(id)&&(i===0||ids[i-1]<id))&&JSON.stringify(ids)===raw,"CONTEXT_PERSON_IDS");return ids;
}
function clerk(issuer,subject){
  let valid=false;try{valid=typeof issuer==="string"&&issuer.startsWith("https://")&&new URL(issuer).origin===issuer;}catch{}
  assert.ok(valid&&typeof subject==="string"&&/^user_[A-Za-z0-9]+(?![\s\S])/.test(subject),"CONTEXT_CLERK_IDENTITY");
}
export function durableWrite(path, value) {
  const temporary = path + ".tmp", fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export class DiskExecutor {
  events = []; now = 10000; beforeLock; failStatement; failCommit; releasedDiscard = false; extension;
  // One serialized physical-connection model. SET LOCAL values are transaction
  // owned; seeded session values let controls prove an explicit reset is needed.
  sessionContext={}; contextEvents=[];
  tail = Promise.resolve();
  constructor(path) { this.path = path; }
  read() { return JSON.parse(readFileSync(this.path, "utf8")); }
  async connect() {
    const prior = this.tail; let unlock;
    this.tail = new Promise((resolve) => { unlock = resolve; }); await prior;
    let draft,active=false,initialized=false,aborted=false,released=false,ending;
    let context=structuredClone(this.sessionContext);
    const clear=()=>{draft=undefined;active=false;initialized=false;aborted=false;ending=undefined;context=structuredClone(this.sessionContext);};
    const result = (rows = []) => ({ rows, rowCount: rows.length });
    const ack = () => result([{}]);
    const execute=async ({ name, text, values: v }) => {
        this.events.push(name);
        if(Object.hasOwn(controls,name)){
          assert.equal(active,false,"TRANSACTION_ALREADY_ACTIVE");assert.equal(text,"BEGIN","TRANSACTION_SQL");values(v,0);
          if(this.failStatement===name){this.failStatement=null;throw Error("SYNTHETIC_WRITE_FAILURE");}
          draft=this.read();active=true;initialized=false;aborted=false;ending=controls[name];context=structuredClone(this.sessionContext);return result();
        }
        assert.equal(active,true,"TRANSACTION_REQUIRED");
        if(name===ending[1]){
          assert.equal(text,"ROLLBACK","TRANSACTION_SQL");values(v,0);
          if(this.failStatement===name){this.failStatement=null;throw Error("SYNTHETIC_WRITE_FAILURE");}clear();return result();
        }
        assert.equal(aborted,false,"TRANSACTION_ABORTED");
        if (this.failStatement === name) { this.failStatement = null; throw Error("SYNTHETIC_WRITE_FAILURE"); }
        if(name==="ua_context_reset"){
          assert.equal(initialized,false,"CONTEXT_RESET_ORDER");assert.equal(text,resetSql,"CONTEXT_RESET_SQL");values(v,6);
          assert.deepEqual(v,["deny","","[]","","",""],"CONTEXT_RESET_VALUES");context=Object.fromEntries(contextKeys.map((key,i)=>[key,v[i]]));initialized=true;return result();
        }
        assert.equal(initialized,true,"CONTEXT_RESET_REQUIRED");
        if(name==="ua_context_phase"){
          assert.equal(text,"SELECT set_config('ua.phase',$1,true)","CONTEXT_PHASE_SQL");values(v,1);const next=v[0];
          assert.ok(["deny","auth","domain","exchange"].includes(next),"CONTEXT_PHASE");
          if(next==="auth")assert.ok(context.phase==="deny"||context.phase==="auth","CONTEXT_PHASE_ORDER");
          if(next==="domain"||next==="exchange"){
            assert.equal(context.phase,"auth","CONTEXT_PHASE_ORDER");const ids=personIds(context.person_ids);assert.ok(ids.length===1&&context.person_id===ids[0],"CONTEXT_SINGLE_PERSON_REQUIRED");
            if(next==="exchange"){clerk(context.clerk_issuer,context.clerk_subject);assert.equal(context.telegram_id,"","CONTEXT_MIXED_IDENTITY");}
          }
          context.phase=next;return result();
        }
        assert.notEqual(context.phase,"deny","CONTEXT_AUTH_REQUIRED");
        if(name==="ua_people_context"){
          assert.equal(context.phase,"auth","CONTEXT_AUTH_PHASE");assert.equal(text,"SELECT set_config('ua.person_id',$1,true),set_config('ua.person_ids',$2,true)","CONTEXT_PEOPLE_SQL");values(v,2);
          const ids=personIds(v[1]);assert.equal(v[0],ids.length===1?ids[0]:"","CONTEXT_PERSON_BINDING");[context.person_id,context.person_ids]=v;return result();
        }
        if(name==="ua_telegram_identity_context"){
          assert.equal(context.phase,"auth","CONTEXT_AUTH_PHASE");assert.equal(text,"SELECT set_config('ua.telegram_id',$1,true)","CONTEXT_TELEGRAM_SQL");values(v,1);
          assert.ok(typeof v[0]==="string"&&/^[1-9][0-9]*(?![\s\S])/.test(v[0])&&Number.isSafeInteger(Number(v[0])),"CONTEXT_TELEGRAM_ID");context.telegram_id=v[0];return result();
        }
        if(name==="ua_clerk_identity_context"){
          assert.equal(context.phase,"auth","CONTEXT_AUTH_PHASE");assert.equal(text,"SELECT set_config('ua.clerk_issuer',$1,true),set_config('ua.clerk_subject',$2,true)","CONTEXT_CLERK_SQL");values(v,2);clerk(...v);[context.clerk_issuer,context.clerk_subject]=v;return result();
        }
        if(name==="ua_clerk_person_context"){
          assert.equal(context.phase,"auth","CONTEXT_AUTH_PHASE");assert.equal(text,"SELECT set_config('ua.person_id',$1,true)","CONTEXT_ACTOR_SQL");values(v,1);
          assert.ok(uuid(v[0])&&personIds(context.person_ids).includes(v[0]),"CONTEXT_ACTOR_OUTSIDE_LOCK_SCOPE");context.person_id=v[0];return result();
        }
        if (name===ending[0]) {
          assert.equal(text,"COMMIT","TRANSACTION_SQL");values(v,0);
          const failure = this.failCommit; this.failCommit = null;
          if (failure === "before") throw Error("SYNTHETIC_COMMIT_UNKNOWN");
          durableWrite(this.path, draft);clear();
          if (failure === "after") throw Error("SYNTHETIC_COMMIT_UNKNOWN");
          return result();
        }
        if(this.extension){const handled=await this.extension({name,text,values:v},draft??this.read());if(handled!==undefined)return handled;}
        if(name==="ua_clerk_retire_person"){for(const f of Object.values(draft.clerkFences??{}))if(f.personId===v[0]&&f.retiredAt===null)f.retiredAt=v[1];return result();}
        if(name==="ua_session_provenance")return result(Object.values(draft.families).filter(f=>f.person_id===v[0]&&f.revoked_at_ms===null&&f.expires_at_ms>v[1]).map(f=>({auth_provider:f.auth_provider})));
        if (name === "ua_people_lock") {
          assert.equal(context.phase,"auth","CONTEXT_LOCK_PHASE");values(v,1);assert.deepEqual(v[0],personIds(context.person_ids),"CONTEXT_LOCK_SCOPE");
          assert.equal(text,"SELECT id::text AS id FROM ua_private.lock_people($1::uuid[]) ORDER BY id","CONTEXT_LOCK_SQL");
          if (this.beforeLock) { const fn = this.beforeLock; this.beforeLock = null; await fn(); }
          return result(v[0].filter((id) => draft.people[id]).map((id) => ({ id })));
        }
        if (name === "ua_clock") return result([{ now_ms: String(this.now) }]);
        if (name === "ua_student_load") { const p = draft.people[v[0]]; return result(p ? [{ ...p, telegram_id: String(p.telegram_id) }] : []); }
        if (name === "ua_attempt_load") { const a = draft.attempts[v[0]]; return result(a?.body.personId === v[1] ? [a] : []); }
        if (name === "ua_answers_load") return result(Object.values(draft.answers[v[0]] ?? {}).map((a) => ({ ...a,
          revision: String(a.revision), saved_at_ms: String(a.saved_at_ms), series_state_revision: String(a.series_state_revision) })));
        if (name === "ua_ordinary_load") return result(draft.results[v[0]] ? [{ exact_result: draft.results[v[0]] }] : []);
        if (name === "ua_attempt_update") {
          const a = draft.attempts[v[2]];
          if (!a || a.body.personId !== v[3] || a.body.generation !== v[4] || a.body.stateRevision !== v[5]) return result();
          a.body = JSON.parse(v[0]); return ack();
        }
        if (name === "ua_answer_cas") {
          const answers = draft.answers[v[0]] ??= {}, old = answers[v[1]];
          if (old && old.revision !== v[6]) return result();
          answers[v[1]] = { question_id: v[1], selected_option_id: v[2], revision: v[3], saved_at_ms: v[4], series_state_revision: v[5] };
          return ack();
        }
        if (name === "ua_ordinary_insert") {
          if (draft.results[v[0]]) return result(); draft.results[v[0]] = JSON.parse(v[1]); return ack();
        }
        if (name === "ua_series_update") {
          const s = draft.series[v[3] + "/" + v[4]];
          if (!s || s.currentAttemptId !== v[2] || s.generation !== v[5]) return result();
          s.stateRevision = v[0]; if (v[1]) s.officialAttemptId = v[2]; return ack();
        }
        if (name === "ua_access_load") {
          const a = draft.access[v[0]], f = a && draft.families[a.family_id];
          return result(f?.person_id === v[1] ? [{ ...a, expires_at_ms: String(a.expires_at_ms),
            family_expires_at_ms: String(f.expires_at_ms), revoked_at_ms: f.revoked_at_ms === null ? null : String(f.revoked_at_ms) }] : []);
        }
        if (name === "ua_init_consume") {
          if (draft.replays[v[0]]) return result(); draft.replays[v[0]] = v[1]; return ack();
        }
        if (name === "ua_families_revoke" || name === "ua_family_revoke") {
          for (const [id, f] of Object.entries(draft.families))
            if ((name === "ua_family_revoke" ? id === v[2] : f.person_id === v[2]) && f.revoked_at_ms === null) {
              f.revoked_at_ms = v[0]; f.logout_retain_until_ms = v[1];
            }
          return result();
        }
        if (name === "ua_family_insert") {
          if (draft.families[v[0]] || Object.values(draft.families).some((f) => f.person_id === v[1] && f.revoked_at_ms === null)) throw Error("SYNTHETIC_UNIQUE_CONSTRAINT");
          draft.families[v[0]] = { person_id: v[1], expires_at_ms: v[2], revoked_at_ms: null, logout_retain_until_ms: null,auth_provider:"telegram" }; return result();
        }
        if (name === "ua_access_insert" || name === "ua_refresh_insert") {
          const table = name === "ua_access_insert" ? draft.access : draft.refresh;
          if (table[v[0]]) throw Error("SYNTHETIC_UNIQUE_CONSTRAINT");
          table[v[0]] = name === "ua_access_insert" ? { family_id: v[1], expires_at_ms: v[2], superseded: false } : { family_id: v[1], consumed: false };
          return result();
        }
        if (name === "ua_refresh_load") {
          const p = draft.refresh[v[0]], f = p && draft.families[p.family_id];
          return result(f?.person_id === v[1] ? [{ ...p, expires_at_ms: String(f.expires_at_ms), revoked_at_ms: f.revoked_at_ms === null ? null : String(f.revoked_at_ms) }] : []);
        }
        if (name === "ua_refresh_consume") { draft.refresh[v[0]].consumed = true; return ack(); }
        if (name === "ua_access_supersede") { for (const p of Object.values(draft.access)) if (p.family_id === v[0]) p.superseded = true; return result(); }
        throw Error("UNHANDLED_STATEMENT:" + name + ":" + text.slice(0, 20));
      };
    return {get context(){return structuredClone(context);},release:(discard)=>{
      assert.equal(released,false,"CLIENT_ALREADY_RELEASED");released=true;this.releasedDiscard=!!discard;this.events.push("release");
      const unfinished=active;clear();unlock();assert.ok(!unfinished||discard,"ACTIVE_TRANSACTION_RELEASE");
    },query:async statement=>{
      assert.equal(released,false,"CLIENT_ALREADY_RELEASED");
      const before=structuredClone(context);
      try{
        assert.ok(statement&&typeof statement==="object"&&Reflect.ownKeys(statement).sort().join(",")==="name,text,values","STATEMENT_SHAPE");
        for(const key of ["name","text","values"])assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(statement,key)??{},"value"),"STATEMENT_SHAPE");
        assert.ok(typeof statement.name==="string"&&typeof statement.text==="string"&&Array.isArray(statement.values),"STATEMENT_SHAPE");
        const answer=await execute(statement);this.contextEvents.push({name:statement.name,before,after:structuredClone(context),active});return answer;
      }catch(error){if(active)aborted=true;throw error;}
    }};
  }
}
