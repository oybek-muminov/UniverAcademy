import {readFile} from 'node:fs/promises';
import {PGlite} from './tooling/node_modules/@electric-sql/pglite/dist/index.js';
const catalog=JSON.parse(await readFile(new URL('./schema-catalog.json',import.meta.url),'utf8'));
const proposal=await readFile(new URL('../../supabase/proposals/account-deletion-rebuild.review.sql',import.meta.url),'utf8');
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const people=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
const families=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
const job='20000000-0000-4000-8000-000000000001',lease='30000000-0000-4000-8000-000000000001';
const education={demo:'40000000-0000-4000-8000-000000000001',version:'40000000-0000-4000-8000-000000000002',assignment:'40000000-0000-4000-8000-000000000003',question:'40000000-0000-4000-8000-000000000004',
 attempts:['50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002'],
 series:['60000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000002']};
const ownedTables=['people','memberships','clerk_identities','clerk_student_sessions','clerk_family_bindings','student_families','student_access','student_refresh','init_data_replays','clerk_exchange_replays','attempts','exam_series','answers','ordinary_results','statistical_bonuses','grants','command_receipts','attempt_cancellations'];
const sharedTables=['groups','demos','test_versions','draft_questions','assignments'];
const issuer='https://clerk.example.test',access='a'.repeat(64),receipt='b'.repeat(64);
async function fixture(){
 let db;
 if(process.env.UA_SCHEMA_NATIVE_URL){
  if(!['127.0.0.1','localhost'].includes(new URL(process.env.UA_SCHEMA_NATIVE_URL).hostname))throw Error('Native schema fixtures require disposable loopback PostgreSQL');
  const {default:pg}=await import('./tooling/node_modules/pg/lib/index.js');
  const client=new pg.Client({connectionString:process.env.UA_SCHEMA_NATIVE_URL});await client.connect();
  db={query:(...a)=>client.query(...a),exec:q=>client.query(q),close:()=>client.end()};
 }else{db=new PGlite();await db.waitReady;}
 await db.exec('CREATE SCHEMA ua_private; CREATE ROLE ua_request NOLOGIN; CREATE ROLE ua_recovery NOLOGIN; GRANT USAGE ON SCHEMA ua_private TO ua_request,ua_recovery;');
 const tables=new Map();for(const c of catalog.tables){if(!tables.has(c.relname))tables.set(c.relname,[]);tables.get(c.relname).push(c)}
 for(const [name,cols]of tables)await db.exec(`CREATE TABLE ua_private.${qi(name)}(${cols.map(c=>qi(c.attname)+' '+c.typ.replace('ua_private.safe_counter','bigint').replace('ua_private.ms_time','bigint').replace('ua_private.proof_digest','text')+(c.attnotnull?' NOT NULL':'')).join(',')}); ALTER TABLE ua_private.${qi(name)} ENABLE ROW LEVEL SECURITY; ALTER TABLE ua_private.${qi(name)} FORCE ROW LEVEL SECURITY;`);
 for(const c of catalog.constraints.filter(c=>!c.def.startsWith('FOREIGN')))await db.exec(`ALTER TABLE ${c.tbl} ADD CONSTRAINT ${qi(c.conname)} ${c.def}`);
 for(const c of catalog.constraints.filter(c=>c.def.startsWith('FOREIGN')))await db.exec(`ALTER TABLE ${c.tbl} ADD CONSTRAINT ${qi(c.conname)} ${c.def}`);
 await db.exec("SET ua.review_deletion_install='isolated-fixture';"+proposal);
 await db.exec(`GRANT EXECUTE ON FUNCTION ua_private.prepare_account_deletion(uuid,uuid,text,text,text,text,text,bigint),ua_private.account_deletion_status(text) TO ua_request;
 GRANT EXECUTE ON FUNCTION ua_private.claim_account_deletion(uuid,uuid),ua_private.due_account_deletions(),ua_private.mark_account_provider_deleted(uuid,uuid),ua_private.finish_account_deletion(uuid,uuid) TO ua_recovery;`);
 const future=Date.now()+3600000;
 await db.exec('BEGIN');
 for(let i=0;i<2;i++){
  await db.query('INSERT INTO ua_private.people VALUES($1,$2,$3,true,ARRAY[\'student\'],\'{}\')',[people[i],100+i,'000000000'+i]);
  await db.query('INSERT INTO ua_private.memberships VALUES($1,NULL,false,0,0)',[people[i]]);
  await db.query('INSERT INTO ua_private.clerk_identities VALUES($1,$2,$3,true)',[issuer,'user_Test'+i,people[i]]);
  await db.query('INSERT INTO ua_private.clerk_student_sessions VALUES($1,$2,$3,$4,NULL)',[issuer,'user_Test'+i,'sess_Test'+i,people[i]]);
  await db.query("INSERT INTO ua_private.student_families VALUES($1,$2,$3,NULL,NULL,'clerk')",[families[i],people[i],future]);
  await db.query('INSERT INTO ua_private.clerk_family_bindings VALUES($1,$2,$3,$4,$5)',[families[i],issuer,'user_Test'+i,'sess_Test'+i,people[i]]);
  await db.query('INSERT INTO ua_private.student_access VALUES($1,$2,$3,false)',[i?'d'.repeat(64):access,families[i],future]);
  await db.query('INSERT INTO ua_private.student_refresh VALUES($1,$2,false)',[(i?'e':'f').repeat(64),families[i]]);
 }
 await db.query("INSERT INTO ua_private.groups VALUES($1,1,'active')",[lease]);
 await db.query("INSERT INTO ua_private.demos VALUES($1,'math','Shared course')",[education.demo]);
 await db.query("INSERT INTO ua_private.test_versions VALUES($1,$2,1,'published','{}','{}')",[education.version,education.demo]);
 await db.query("INSERT INTO ua_private.draft_questions VALUES($1,$2,0,'{}')",[education.version,education.question]);
 await db.query("INSERT INTO ua_private.assignments VALUES($1,$2,$3,$4,1,'{}')",[education.assignment,lease,education.demo,education.version]);
 for(let i=0;i<2;i++){
  await db.query('INSERT INTO ua_private.init_data_replays VALUES($1,$2,$3)',[(i?'4':'1').repeat(64),people[i],Date.now()]);
  await db.query('INSERT INTO ua_private.clerk_exchange_replays VALUES($1,$2,$3)',[(i?'5':'2').repeat(64),people[i],Date.now()]);
  await db.query('UPDATE ua_private.memberships SET affinity_group_id=$1,active=true WHERE person_id=$2',[lease,people[i]]);
  await db.query("INSERT INTO ua_private.attempts VALUES($1,$2,$3,$4,1,1,'{}','{}','[]')",[education.attempts[i],people[i],education.assignment,education.demo]);
  await db.query("INSERT INTO ua_private.exam_series VALUES($1,$2,$3,$4,1,1,true,$4,'none',NULL)",[people[i],education.demo,education.series[i],education.attempts[i]]);
  await db.query('INSERT INTO ua_private.answers VALUES($1,$2,NULL,1,$3,1)',[education.attempts[i],education.question,Date.now()]);
  await db.query("INSERT INTO ua_private.ordinary_results VALUES($1,'{}')",[education.attempts[i]]);
  await db.query("INSERT INTO ua_private.statistical_bonuses VALUES($1,$2,'{}')",[people[i],education.attempts[i]]);
  await db.query("INSERT INTO ua_private.attempt_cancellations VALUES($1,$2,'{}')",[people[i],education.attempts[i]]);
  await db.query("INSERT INTO ua_private.command_receipts VALUES($1,$2,'payload',$3)",[people[i],'student-'+i,education.attempts[i]]);
  await db.query('INSERT INTO ua_private.grants VALUES($1,$2,true,1)',[people[i],education.assignment]);
 }
 await db.exec('COMMIT');return db;
}

export {fixture,people,families,job,lease,issuer,access,receipt,education,ownedTables,sharedTables};
