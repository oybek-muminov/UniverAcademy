/** Isolated local PostgreSQL fixture. Catalog definitions are read-only captures.
 * Never run against an external database; ownership and RLS are replayed rather
 * than mocked. LOGIN flags are deliberately suppressed in these local roles. */
import {readFile} from 'node:fs/promises';
import pg from '../account-deletion/tooling/node_modules/pg/lib/index.js';
const base=JSON.parse(await readFile(new URL('../account-deletion/schema-catalog.json',import.meta.url),'utf8'));
const catalog=JSON.parse(await readFile(new URL('./production-auth-extended-catalog.json',import.meta.url),'utf8'));
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const permission={a:'INSERT',r:'SELECT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN',X:'EXECUTE',U:'USAGE',C:'CREATE'};
async function acl(db,kind,object,entries,column){
 for(const entry of entries??[]){
  const [grantee,rest]=entry.split('='),codes=rest.split('/')[0],role=grantee?qi(grantee):'PUBLIC';
  for(let i=0;i<codes.length;i++){
   const code=codes[i];if(code==='*')continue;
   if(!permission[code])throw Error('Unsupported captured ACL '+code);
   await db.query('GRANT '+permission[code]+(column?' ('+qi(column)+')':'')+' ON '+kind+' '+object+' TO '+role+(codes[i+1]==='*'?' WITH GRANT OPTION':''));
  }
 }
}
export async function nativeFixture({url=process.env.UA_SCHEMA_NATIVE_URL,deletion=false}={}){
 if(!url||!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Requires disposable loopback PostgreSQL');
 const admin=new pg.Client({connectionString:url});await admin.connect();
 try {
 await admin.query('CREATE SCHEMA ua_private');
 for(const role of catalog.roles){
  if(role.super||role.bypassrls||role.create_db||role.create_role)throw Error('Unexpected privileged production role');
  await admin.query('CREATE ROLE '+qi(role.name)+' NOLOGIN '+(role.inherit?'INHERIT':'NOINHERIT')+' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE');
 }
 for(const domain of catalog.domains)await admin.query('CREATE DOMAIN ua_private.'+qi(domain.name)+' AS '+domain.base+(domain.not_null?' NOT NULL':'')+(domain.default?' DEFAULT '+domain.default:'')+' '+(domain.checks??[]).join(' '));
 const tables=new Map();for(const c of base.tables){if(!tables.has(c.relname))tables.set(c.relname,[]);tables.get(c.relname).push(c)}
 for(const [table,cols]of tables)await admin.query('CREATE TABLE ua_private.'+qi(table)+'('+cols.map(c=>qi(c.attname)+' '+c.typ+(c.attnotnull?' NOT NULL':'')).join(',')+')');
 for(const c of base.constraints.filter(c=>!c.def.startsWith('FOREIGN')))await admin.query('ALTER TABLE '+c.tbl+' ADD CONSTRAINT '+qi(c.conname)+' '+c.def);
 for(const c of base.constraints.filter(c=>c.def.startsWith('FOREIGN')))await admin.query('ALTER TABLE '+c.tbl+' ADD CONSTRAINT '+qi(c.conname)+' '+c.def);
 for(const f of catalog.functions)await admin.query(f.definition);
 for(const check of catalog.checks)await admin.query('ALTER TABLE '+check.table+' ADD CONSTRAINT '+qi(check.name)+' '+check.definition);
 if(catalog.defaults?.length)throw Error('Defaults catalog format requires explicit review');
 for(const trigger of catalog.triggers)await admin.query(trigger.definition);
 for(const table of catalog.table_acl){
  await admin.query('ALTER TABLE ua_private.'+qi(table.table)+' OWNER TO '+qi(table.owner));
  if(table.rls)await admin.query('ALTER TABLE ua_private.'+qi(table.table)+' ENABLE ROW LEVEL SECURITY');
  if(table.force)await admin.query('ALTER TABLE ua_private.'+qi(table.table)+' FORCE ROW LEVEL SECURITY');
  await acl(admin,'TABLE','ua_private.'+qi(table.table),table.acl);
 }
 for(const c of catalog.column_acl)await acl(admin,'TABLE','ua_private.'+qi(c.table),c.acl,c.column);
 for(const policy of catalog.policies)await admin.query('CREATE POLICY '+qi(policy.policyname)+' ON '+qi(policy.schemaname)+'.'+qi(policy.tablename)+' AS '+policy.permissive+' FOR '+policy.cmd+' TO '+policy.roles.map(r=>r==='public'?'PUBLIC':qi(r)).join(',')+(policy.qual?' USING ('+policy.qual+')':'')+(policy.with_check?' WITH CHECK ('+policy.with_check+')':''));
 for(const f of catalog.functions){
  const result=await admin.query("SELECT p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ua_private' AND p.proname=$1",[f.name]);
  if(result.rows.length!==1)throw Error('Ambiguous helper signature '+f.name);
  const signature=result.rows[0].signature;
  await admin.query('ALTER FUNCTION '+signature+' OWNER TO '+qi(f.owner));
  await admin.query('REVOKE ALL ON FUNCTION '+signature+' FROM PUBLIC');
  await acl(admin,'FUNCTION',signature,f.acl);
 }
 // Schema ACL is replayed below once captured. Do not invent permissive USAGE.
 if(!catalog.schema_acl)throw Error('Missing captured schema ACL');
 const schema=catalog.schema_acl;
 await admin.query('ALTER SCHEMA ua_private OWNER TO '+qi(schema.owner));
 await acl(admin,'SCHEMA','ua_private',schema.acl);
 for(const member of catalog.memberships.filter(m=>m.member!=='postgres'))await admin.query('GRANT '+qi(member.role)+' TO '+qi(member.member)+' WITH INHERIT '+member.inherit+', SET '+member.set+', ADMIN '+member.admin);
 let installed=false;
 async function installDeletion(){
  if(installed)return;
  const sql=await readFile(new URL('../../supabase/proposals/account-deletion-rebuild.review.sql',import.meta.url),'utf8');
  await admin.query("SET ua.review_deletion_install='isolated-fixture';"+sql);
  // Explicit local composition grants: captured production role rights remain
  // unchanged except these narrowly audited candidate freeze-helper EXECUTEs.
  const writers=new Set([...catalog.roles.map(r=>r.name)]);
  for(const writer of writers)await admin.query('GRANT EXECUTE ON FUNCTION ua_private.assert_deletion_writable(text,jsonb),ua_private.assert_deletion_staff_writable(jsonb,jsonb) TO '+qi(writer));
  installed=true;
 }
 if(deletion)await installDeletion();
 const pool=new pg.Pool({connectionString:url,max:8});
 const runtimePool={async connect(){const client=await pool.connect();await client.query('SET SESSION AUTHORIZATION ua_api_login');return client;}};
 return {admin,pool:runtimePool,installDeletion,async close(){await pool.end();await admin.end();},catalog};
 } catch(error) { await admin.end(); throw error; }
}
