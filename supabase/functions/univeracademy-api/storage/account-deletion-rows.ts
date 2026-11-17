import {ApiFault,fail} from '../fault.ts';
import {proofHash} from '../student-state.ts';
import type {DeletionRequestStore,DeletionRecoveryStore,DeletionLease} from '../account-deletion.ts';
import {StorageUnavailable} from './postgres-transaction.ts';
import type {PgPool,PgClient} from './postgres-transaction.ts';
import {resetTrustedServerContext,setTrustedPhase,closeTrustedServerContext,canonicalPersonId} from './trusted-server-context.ts';
const query=(c:PgClient,name:string,text:string,values:readonly unknown[]=[])=>c.query({name,text,values});
const errorCode=(e:unknown)=>e&&typeof e==='object'&&'code'in e?(e as {code:unknown}).code:null;
const rejected=(e:unknown)=>errorCode(e)==='42501'&&e instanceof Error&&e.message==='DELETION_REJECTED';
/** No ambiguous DB result is represented as authorization rejection. */
async function transaction<T>(pool:PgPool,work:(c:PgClient)=>Promise<T>):Promise<T>{
 let c:PgClient;try{c=await pool.connect();}catch{throw new StorageUnavailable('not_committed');}
 let began=false,committing=false,discard=false;
 try{
  await query(c,'ua_delete_begin','BEGIN');began=true;
  await resetTrustedServerContext(c);
  const result=await work(c);committing=true;
  await query(c,'ua_delete_commit','COMMIT');began=false;return result;
 }catch(error){
  discard=true;
  if(committing)throw new StorageUnavailable('commit_unknown');
  if(began){try{await query(c,'ua_delete_rollback','ROLLBACK');began=false;}catch{throw new StorageUnavailable('commit_unknown');}}
  if(rejected(error))throw new ApiFault('FORBIDDEN',403);
  if(error instanceof ApiFault)throw error;
  throw new StorageUnavailable('not_committed');
 }finally{closeTrustedServerContext(c);try{c.release(discard);}catch{/* one cleanup attempt only */}}
}
const privilegeSql=`SELECT current_user AS role,
 r.rolsuper OR r.rolbypassrls OR r.rolcreaterole AS elevated,
 EXISTS(SELECT 1 FROM pg_roles x WHERE (x.rolname IN('ua_owner','ua_deletion_executor','ua_person_lock_owner','ua_clerk_lock_owner') OR x.rolsuper OR x.rolbypassrls OR x.rolcreaterole)
 AND (pg_has_role(current_user,x.oid,'MEMBER') OR pg_has_role(current_user,x.oid,'SET'))) AS inherited,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ua_private' AND
 c.relname IN('account_deletion_jobs','account_deletion_control','deleted_clerk_subjects','deleted_proof_digests') AND
 (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
 has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS writable
 FROM pg_roles r WHERE r.rolname=current_user`;
async function requireRole(c:PgClient,expectedRole:string){
 const r=await query(c,'ua_delete_role_preflight',privilegeSql);
 if(r.rows.length!==1||r.rows[0].role!==expectedRole||r.rows[0].elevated!==false||r.rows[0].inherited!==false||r.rows[0].writable!==false)fail('SERVICE_UNAVAILABLE',503);
}
export class AccountDeletionRequests implements DeletionRequestStore {
 private readonly pool:PgPool; private readonly role:string;
 constructor(pool:PgPool,role:string){if(!role||role==='postgres')throw Error('restricted role required');this.pool=pool;this.role=role;}
 async prepare(input:Parameters<DeletionRequestStore['prepare']>[0]):Promise<void>{
  const access=await proofHash(input.accessToken);
  await transaction(this.pool,async c=>{
   await requireRole(c,this.role);await setTrustedPhase(c,'auth');
   const located=await query(c,'ua_delete_locate_access','SELECT person_id::text FROM ua_private.locate_student_access($1::text)',[access]);
   if(located.rows.length!==1||!canonicalPersonId(located.rows[0].person_id))fail('UNAUTHORIZED',401);
   const p=input.identity;
   const rows=await query(c,'ua_delete_prepare','SELECT job_id::text,state FROM ua_private.prepare_account_deletion($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::text,$8::bigint)',
    [input.requestId,located.rows[0].person_id,access,p.issuer,p.userId,p.sessionId,input.receiptHash,input.verifiedAfter]);
   if(rows.rows.length!==1||rows.rows[0].job_id!==input.requestId||!['pending','provider_deleted','completed'].includes(String(rows.rows[0].state)))fail('SERVICE_UNAVAILABLE',503);
  });
 }
 async status(receiptHash:string){return transaction(this.pool,async c=>{
  await requireRole(c,this.role);
  const r=await query(c,'ua_delete_status','SELECT state FROM ua_private.account_deletion_status($1::text)',[receiptHash]);
  if(!r.rows.length)return null;
  if(r.rows.length!==1)fail('SERVICE_UNAVAILABLE',503);
  const state=r.rows[0].state;
  if(state==='completed')return 'completed' as const;
  if(state==='pending'||state==='provider_deleted')return 'pending' as const;
  fail('SERVICE_UNAVAILABLE',503);
 });}
}
export class AccountDeletionRecovery implements DeletionRecoveryStore {
 private readonly pool:PgPool; private readonly role:string; private readonly newLease:()=>string;
 constructor(pool:PgPool,role:string,newLease:()=>string=()=>crypto.randomUUID()){
  if(!role||role==='postgres')throw Error('restricted role required');this.pool=pool;this.role=role;this.newLease=newLease;
 }
 async claim():Promise<DeletionLease|null>{return transaction(this.pool,async c=>{
  await requireRole(c,this.role);
  const jobs=await query(c,'ua_delete_due','SELECT job_id::text FROM ua_private.due_account_deletions()');
  for(const row of jobs.rows){
   if(!canonicalPersonId(row.job_id))fail('SERVICE_UNAVAILABLE',503);
   const leaseId=this.newLease();if(!canonicalPersonId(leaseId))fail('SERVICE_UNAVAILABLE',503);
   const result=await query(c,'ua_delete_claim','SELECT job_id::text,lease_id::text,issuer,subject FROM ua_private.claim_account_deletion($1::uuid,$2::uuid)',[row.job_id,leaseId]);
   if(!result.rows.length)continue;
   const r=result.rows[0];if(result.rows.length!==1||r.job_id!==row.job_id||r.lease_id!==leaseId||typeof r.issuer!=='string'||typeof r.subject!=='string')fail('SERVICE_UNAVAILABLE',503);
   return {jobId:row.job_id,leaseId,issuer:r.issuer,userId:r.subject};
  }return null;
 });}
 async providerDeleted(lease:DeletionLease){await this.mutate('mark_account_provider_deleted',lease);}
 async finish(lease:DeletionLease){await this.mutate('finish_account_deletion',lease);}
 private async mutate(name:'mark_account_provider_deleted'|'finish_account_deletion',lease:DeletionLease){
  if(!canonicalPersonId(lease.jobId)||!canonicalPersonId(lease.leaseId))fail('SERVICE_UNAVAILABLE',503);
  await transaction(this.pool,async c=>{
   await requireRole(c,this.role);
   const r=await query(c,'ua_delete_'+name,`SELECT ua_private.${name}($1::uuid,$2::uuid) AS ok`,[lease.jobId,lease.leaseId]);
   if(r.rows.length!==1||r.rows[0].ok!==true)fail('SERVICE_UNAVAILABLE',503);
  });
 }
}
