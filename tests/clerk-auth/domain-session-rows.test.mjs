import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {domainExecutor} from './domain-executor.mjs';
import {durableWrite} from '../storage-auth/disk-executor.mjs';
import {PostgresTransactions} from '../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts';
import {ClerkAuthRows} from '../../supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts';
import {resetTrustedServerContext,setTrustedPhase,setTrustedPeople,closeTrustedServerContext} from '../../supabase/functions/univeracademy-api/storage/trusted-server-context.ts';

const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),P=id(1),Q=id(2),F=id(10),G=id(11),H=id(12);
const digest=n=>n.toString(16).padStart(64,'0'),issuer='https://fixture.invalid',subject='user_A';
const familySql=t=>`SELECT p.family_id::text FROM ua_private.${t} p JOIN ua_private.student_families f ON f.id=p.family_id WHERE p.digest=$1 AND f.person_id=$2`;
const reads={
 ua_clerk_families:['SELECT id::text,person_id::text,expires_at_ms::text,revoked_at_ms::text,logout_retain_until_ms::text,auth_provider FROM ua_private.student_families WHERE person_id=$1','id'],
 ua_clerk_bindings:['SELECT b.family_id::text,b.person_id::text,b.issuer,b.subject,b.sid FROM ua_private.clerk_family_bindings b JOIN ua_private.student_families f ON f.id=b.family_id WHERE f.person_id=$1','f.id'],
 ua_clerk_access:['SELECT a.digest,a.family_id::text,a.expires_at_ms::text,a.superseded FROM ua_private.student_access a JOIN ua_private.student_families f ON f.id=a.family_id WHERE f.person_id=$1','f.id'],
 ua_clerk_refresh:['SELECT r.digest,r.family_id::text,r.consumed FROM ua_private.student_refresh r JOIN ua_private.student_families f ON f.id=r.family_id WHERE f.person_id=$1','f.id']
};
async function setup(t,change=()=>{}){
 const dir=mkdtempSync(join(tmpdir(),'ua-session-row-double-')),path=join(dir,'rows.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const profile={person_id:P,first_name:'Synthetic',last_name:'Student',roles:['student'],registration_complete:false,active_group_id:null,qadam_id:'0000000001'};
 const data={people:{[P]:{telegram_id:null,enabled:true,roles:['student'],profile},[Q]:{}},memberships:{[P]:{active:false,epoch:0,revision:0,affinity_group_id:null}},families:{[F]:{person_id:P,expires_at_ms:50000,revoked_at_ms:null,logout_retain_until_ms:null,auth_provider:'clerk'},[G]:{person_id:P,expires_at_ms:9000,revoked_at_ms:8000,logout_retain_until_ms:60000,auth_provider:'clerk'},[H]:{person_id:Q,expires_at_ms:50000,revoked_at_ms:null,logout_retain_until_ms:null,auth_provider:'clerk'}},
 access:{[digest(1)]:{family_id:F,expires_at_ms:30000,superseded:false},[digest(2)]:{family_id:G,expires_at_ms:9000,superseded:true},[digest(3)]:{family_id:H,expires_at_ms:30000,superseded:false}},refresh:{[digest(4)]:{family_id:F,consumed:false},[digest(5)]:{family_id:G,consumed:true},[digest(6)]:{family_id:H,consumed:false}},
 clerkIdentities:{[JSON.stringify([issuer,subject])]:{personId:P,enabled:true}},clerkBindings:{[F]:{personId:P,issuer,userId:subject,sessionId:'sess_Active'},[G]:{personId:P,issuer,userId:subject,sessionId:'sess_Retired'},[H]:{personId:Q,issuer,userId:'user_Q',sessionId:'sess_Q'}},clerkFences:{[JSON.stringify([issuer,subject,'sess_Active'])]:{personId:P,retiredAt:null},[JSON.stringify([issuer,subject,'sess_Retired'])]:{personId:P,retiredAt:8000}},clerkReplays:{}};
 change(data);durableWrite(path,data);const pool=domainExecutor(path),runner=new PostgresTransactions(pool);return{pool,runner,path,data,run:work=>runner.run([P],work)};
}
const query=(tx,name,text,values)=>tx.client.query({name,text,values});

test('actual ClerkAuthRows.loadSession receives only its selected persisted family and proof rows',async t=>{
 const f=await setup(t),before=readFileSync(f.path,'utf8');const r=await f.run(tx=>new ClerkAuthRows().loadSession({client:tx.client,personId:P,existing:true,now:tx.now},{kind:'access',digest:digest(1)},false));
 assert.equal(r.familyId,F);assert.deepEqual(Object.keys(r.state.families),[F]);assert.deepEqual(Object.keys(r.state.familyBindings),[F]);assert.deepEqual(Object.keys(r.state.access),[digest(1)]);assert.deepEqual(Object.keys(r.state.refresh),[digest(4)]);assert.equal(readFileSync(f.path,'utf8'),before);
});
for(const [kind,table,proof,family]of [['access','student_access',1,F],['refresh','student_refresh',4,F],['refresh','student_refresh',5,G]])test('exact '+kind+' digest family hint '+proof,async t=>{
 const f=await setup(t);assert.deepEqual(await f.run(tx=>query(tx,'ua_clerk_session_family',familySql(table),[digest(proof),P])),{rows:[{family_id:family}],rowCount:1});
});
test('consumed/revoked/expired relationship is not hidden from revocation-only snapshot loading',async t=>{
 const f=await setup(t),result=await f.run(tx=>new ClerkAuthRows().loadSession({client:tx.client,personId:P,existing:true,now:tx.now},{kind:'refresh',digest:digest(5)},true));assert.equal(result.familyId,G);assert.equal(result.state.refresh[digest(5)].consumed,true);assert.equal(result.state.families[G].revokedAt,8000);assert.equal(result.state.families[G].expiresAt,9000);
});
test('disabled local records remain visible to revocation-only loading and ordinary loading still denies',async t=>{
 const f=await setup(t,d=>{d.people[P].enabled=false;d.clerkIdentities[JSON.stringify([issuer,subject])].enabled=false;});
 await assert.rejects(f.run(tx=>new ClerkAuthRows().loadSession({client:tx.client,personId:P,existing:true,now:tx.now},{kind:'access',digest:digest(1)},false)),e=>e.code==='ACCOUNT_DISABLED');
 const r=await f.run(tx=>new ClerkAuthRows().loadSession({client:tx.client,personId:P,existing:true,now:tx.now},{kind:'refresh',digest:digest(4)},true));assert.equal(r.state.person.enabled,false);assert.equal(Object.values(r.state.identities)[0].enabled,false);
});
for(const proof of [3,6,99])test('foreign or unknown proof reveals no family '+proof,async t=>{
 const f=await setup(t),table=proof===3?'student_access':'student_refresh';assert.deepEqual(await f.run(tx=>query(tx,'ua_clerk_session_family',familySql(table),[digest(proof),P])),{rows:[],rowCount:0});
});
for(const [name,[sql,column]]of Object.entries(reads))test('scoped/unscoped projection honors both person and family: '+name,async t=>{
 const f=await setup(t),field=name==='ua_clerk_families'?'id':'family_id';const all=await f.run(tx=>query(tx,name,sql,[P]));assert.deepEqual(new Set(all.rows.map(x=>x[field])),new Set([F,G]));
 for(const family of [F,G,H]){const scoped=await f.run(tx=>query(tx,name,sql+` AND ${column}=$2`,[P,family]));assert.deepEqual(scoped.rows.map(x=>x[field]),family===H?[]:[family]);}
});
test('family selector rejects person substitution and table/SQL changes before returning data',async t=>{
 const f=await setup(t);await assert.rejects(f.run(tx=>query(tx,'ua_clerk_session_family',familySql('student_access'),[digest(3),Q])),/FIXTURE_SESSION_PERSON_SCOPE/);await assert.rejects(f.run(tx=>query(tx,'ua_clerk_session_family',familySql('student_access').replace('student_access','other_table'),[digest(1),P])),/FIXTURE_SESSION_FAMILY_SQL/);
});
for(const raw of ['',null,'A'.repeat(64),'a'.repeat(63),'a'.repeat(64)+'\n'])test('family selector rejects malformed proof digest '+JSON.stringify(raw),async t=>{
 const f=await setup(t);await assert.rejects(f.run(tx=>query(tx,'ua_clerk_session_family',familySql('student_refresh'),[raw,P])),/FIXTURE_SESSION_DIGEST/);
});
test('scoped projection rejects missing filter SQL, malformed family and extra arguments',async t=>{
 const f=await setup(t),[sql,column]=reads.ua_clerk_families;
 await assert.rejects(f.run(tx=>query(tx,'ua_clerk_families',sql,[P,F])),/FIXTURE_SESSION_READ_SQL/);await assert.rejects(f.run(tx=>query(tx,'ua_clerk_families',sql+` AND ${column}=$2`,[P,'not-a-uuid'])),/FIXTURE_SESSION_FAMILY_ID/);await assert.rejects(f.run(tx=>query(tx,'ua_clerk_families',sql,[P,F,'extra'])),/FIXTURE_SESSION_READ_VALUES/);
});
test('session reads cannot precede the ordered person lock',async t=>{
 const f=await setup(t),c=await f.pool.connect();try{await c.query({name:'ua_begin',text:'BEGIN',values:[]});await resetTrustedServerContext(c);await setTrustedPhase(c,'auth');await setTrustedPeople(c,[P]);await assert.rejects(c.query({name:'ua_clerk_session_family',text:familySql('student_access'),values:[digest(1),P]}),/FIXTURE_SESSION_LOCK_ORDER/);await c.query({name:'ua_rollback',text:'ROLLBACK',values:[]});}finally{closeTrustedServerContext(c);c.release(true);}
});
