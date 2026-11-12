import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {domainExecutor} from './domain-executor.mjs';
import {durableWrite} from '../storage-auth/disk-executor.mjs';
import {resetTrustedServerContext,setTrustedPhase,setTrustedPeople,setTrustedClerk,closeTrustedServerContext} from '../../supabase/functions/univeracademy-api/storage/trusted-server-context.ts';

const P='00000000-0000-4000-8000-000000000001',Q='00000000-0000-4000-8000-000000000002';
const issuer='https://fixture.invalid',subject='user_CaseA',pair=[issuer,subject];
const gateSql='SELECT pg_advisory_xact_lock(1430348620,hashtext($1))';
const mappingSql='SELECT person_id::text,enabled FROM ua_private.lock_clerk_identity($1::text,$2::text)';
const peopleSql='SELECT id::text FROM ua_private.lock_people($1::uuid[]) ORDER BY id';
const query=(c,name,text,values=[])=>c.query({name,text,values});
async function setup(t,{mapping={personId:P,enabled:true},missingPerson=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'ua-domain-shape-')),path=join(dir,'rows.json');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 durableWrite(path,{people:{...(missingPerson?{}:{[P]:{}}),[Q]:{}},clerkIdentities:mapping?{[JSON.stringify(pair)]:mapping}:{}});
 const pool=domainExecutor(path),c=await pool.connect();t.after(()=>{closeTrustedServerContext(c);try{c.release(true);}catch{}});
 await query(c,'ua_clerk_begin','BEGIN');await resetTrustedServerContext(c);await setTrustedPhase(c,'auth');return{pool,c};
}
async function gate(c){await query(c,'ua_clerk_identity_gate',gateSql,[JSON.stringify(pair)]);await setTrustedClerk(c,...pair);}
async function mapped(t,options){const f=await setup(t,options);await gate(f.c);f.mapping=await query(f.c,'ua_clerk_locate',mappingSql,pair);return f;}
const people=(c,ids)=>query(c,'ua_clerk_person_lock',peopleSql,[ids]);

test('mapping helper returns exact enabled/person row and disabled is visible rather than absent',async t=>{
 for(const enabled of [true,false]){
  const f=await mapped(t,{mapping:{personId:P,enabled}});assert.deepEqual(f.mapping,{rows:[{person_id:P,enabled}],rowCount:1});
  f.mapping.rows[0].enabled=!enabled;assert.deepEqual((await query(f.c,'ua_clerk_locate',mappingSql,pair)).rows,[{person_id:P,enabled}]);
 }
});
test('authoritative absence returns no mapping, never an invented enabled identity',async t=>{const f=await mapped(t,{mapping:null});assert.deepEqual(f.mapping,{rows:[],rowCount:0});await setTrustedPeople(f.c,[P]);await assert.rejects(people(f.c,[P]),/FIXTURE_CLERK_MAPPING_ORDER/);});
test('disabled mapping cannot proceed to person locks',async t=>{const f=await mapped(t,{mapping:{personId:P,enabled:false}});await setTrustedPeople(f.c,[P]);await assert.rejects(people(f.c,[P]),/FIXTURE_CLERK_MAPPING_ORDER/);});
test('person helper takes a sorted UUID array and returns detached ordered string IDs',async t=>{
 const f=await mapped(t);await setTrustedPeople(f.c,[P,Q]);const r=await people(f.c,[P,Q]);assert.deepEqual(r,{rows:[{id:P},{id:Q}],rowCount:2});assert.equal(typeof r.rows[0].id,'string');r.rows[0].id='changed';assert.deepEqual((await people(f.c,[P,Q])).rows,[{id:P},{id:Q}]);
});
test('missing people remain missing after an existing mapping; no lock row is fabricated',async t=>{const f=await mapped(t,{missingPerson:true});await setTrustedPeople(f.c,[P]);assert.deepEqual(await people(f.c,[P]),{rows:[],rowCount:0});});
for(const ids of [P,[],[P,P],[Q,P],[P+'\n'],[9]])test('malformed/noncanonical person-lock argument rejected '+JSON.stringify(ids),async t=>{
 const f=await mapped(t);await setTrustedPeople(f.c,[P,Q]);await assert.rejects(people(f.c,ids),/FIXTURE_CLERK_PEOPLE_IDS/);
});
test('person lock cannot add a participant outside the established context',async t=>{const f=await mapped(t);await setTrustedPeople(f.c,[P]);await assert.rejects(people(f.c,[P,Q]),/FIXTURE_CLERK_PEOPLE_CONTEXT/);});
test('person lock cannot replace the mapped person with another participant',async t=>{const f=await mapped(t);await setTrustedPeople(f.c,[Q]);await assert.rejects(people(f.c,[Q]),/FIXTURE_CLERK_MAPPING_SCOPE/);});
test('mapping lock requires the earlier exact identity gate and verified context',async t=>{
 const f=await setup(t);await setTrustedClerk(f.c,...pair);await assert.rejects(query(f.c,'ua_clerk_locate',mappingSql,pair),/FIXTURE_CLERK_GATE_ORDER/);
});
test('person locks cannot occur before mapping lock',async t=>{const f=await setup(t);await gate(f.c);await setTrustedPeople(f.c,[P]);await assert.rejects(people(f.c,[P]),/FIXTURE_CLERK_MAPPING_ORDER/);});
test('identity gate cannot be acquired after person scope',async t=>{const f=await setup(t);await setTrustedPeople(f.c,[P]);await assert.rejects(query(f.c,'ua_clerk_identity_gate',gateSql,[JSON.stringify(pair)]),/FIXTURE_CLERK_GATE_ORDER/);});
test('mapping cannot be selected from a different gated subject',async t=>{
 const f=await setup(t);await gate(f.c);await assert.rejects(query(f.c,'ua_clerk_locate',mappingSql,[issuer,'user_Other']),/FIXTURE_CLERK_GATE_BINDING/);
});
test('mapping context must match the exact issuer and case-sensitive subject',async t=>{
 const f=await setup(t);await query(f.c,'ua_clerk_identity_gate',gateSql,[JSON.stringify(pair)]);await setTrustedClerk(f.c,issuer,'user_caseA');await assert.rejects(query(f.c,'ua_clerk_locate',mappingSql,pair),/FIXTURE_CLERK_CONTEXT_BINDING/);
});
test('helper locks stay in auth phase',async t=>{const f=await mapped(t);await setTrustedPeople(f.c,[P]);await setTrustedPhase(f.c,'domain');await assert.rejects(people(f.c,[P]),/FIXTURE_CLERK_AUTH_ORDER/);});
for(const mapping of [{personId:9,enabled:true},{personId:P,enabled:'true'},{personId:P,enabled:null}])test('malformed fixture mapping is rejected without boolean coercion '+JSON.stringify(mapping),async t=>{
 const f=await setup(t,{mapping});await gate(f.c);await assert.rejects(query(f.c,'ua_clerk_locate',mappingSql,pair),/FIXTURE_CLERK_MAPPING_SHAPE/);
});
test('mapping and people helpers reject changed SQL and wrong parameter arity',async t=>{
 const f=await setup(t);await gate(f.c);await assert.rejects(query(f.c,'ua_clerk_locate',mappingSql.replace(',enabled',''),pair),/FIXTURE_CLERK_MAPPING_SQL/);
 const g=await mapped(t);await setTrustedPeople(g.c,[P]);await assert.rejects(query(g.c,'ua_clerk_person_lock',peopleSql,[[P],'extra']),/FIXTURE_CLERK_VALUES_SHAPE/);
});
test('helper parameter getters and sparse UUID arrays are rejected without reading a getter',async t=>{
 const f=await setup(t);let gets=0;const v=[];Object.defineProperty(v,'0',{enumerable:true,get(){gets++;throw Error('unread');}});await assert.rejects(query(f.c,'ua_clerk_identity_gate',gateSql,v),/FIXTURE_CLERK_VALUES_SHAPE/);assert.equal(gets,0);
 const g=await mapped(t);await setTrustedPeople(g.c,[P]);await assert.rejects(people(g.c,new Array(1)),/FIXTURE_CLERK_VALUES_SHAPE/);
});
test('ordinary locator remains one-column and filters disabled mappings',async t=>{
 const f=await setup(t,{mapping:{personId:P,enabled:false}});await setTrustedClerk(f.c,...pair);
 const sql='SELECT person_id::text FROM ua_private.clerk_identities WHERE issuer=$1 AND subject=$2 AND enabled=true';assert.deepEqual(await query(f.c,'ua_clerk_locator',sql,pair),{rows:[],rowCount:0});
});
test('fresh transaction cannot inherit an earlier identity gate',async t=>{
 const f=await mapped(t);await query(f.c,'ua_clerk_rollback','ROLLBACK');closeTrustedServerContext(f.c);await query(f.c,'ua_clerk_begin','BEGIN');await resetTrustedServerContext(f.c);await setTrustedPhase(f.c,'auth');await setTrustedClerk(f.c,...pair);await assert.rejects(query(f.c,'ua_clerk_locate',mappingSql,pair),/FIXTURE_CLERK_GATE_ORDER/);
});
