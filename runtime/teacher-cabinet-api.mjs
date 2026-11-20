import { availableStudentsGroup,cabinetQueryAllowed } from './teacher-student-directory.mjs';
import { randomUUID } from 'node:crypto';
import { createClerkVerifier, requireLiveClerk } from '../supabase/functions/univeracademy-api/clerk-auth.ts';
import { guardBoundFamily } from '../supabase/functions/univeracademy-api/clerk-http.ts';
import { ApiFault,fail } from '../supabase/functions/univeracademy-api/fault.ts';
import { authenticate,bearer,proofHash } from '../supabase/functions/univeracademy-api/student-state.ts';
import { ClerkAuthRows } from '../supabase/functions/univeracademy-api/storage/clerk-auth-rows.ts';
import { combined } from '../supabase/functions/univeracademy-api/storage/clerk-domain.ts';
import { PostgresTransactions } from '../supabase/functions/univeracademy-api/storage/postgres-transaction.ts';
import { locateStudentAccessOnClient } from '../supabase/functions/univeracademy-api/storage/student-scope.ts';
import { setTrustedPhase } from '../supabase/functions/univeracademy-api/storage/trusted-server-context.ts';
import { transactionPoolPort } from '../supabase/functions/univeracademy-api/storage/transaction-pool-port.ts';
import { createClerkPersonTransactions } from '../supabase/functions/univeracademy-api/teacher-browser-pilot-postgres.ts';
import { parseTeacherTestText } from './teacher-pilot-text-import.mjs';
import { imageLimits } from '../packages/test-content/image-policy.mjs';
import { CommittedAttemptError } from './teacher-staging-attempts.mjs';
import { runStagingPilot } from './teacher-staging-store.mjs';

const actions={
  teacher:new Set(['createGroup','addMember','createInvite','sendInvite','importTest','readDraft','updateDraft','previewTest','publishTest','assignTest']),
  student:new Set(['acceptInvite','startAttempt','resumeAttempt','saveAnswer','submitAttempt']),
  admin:new Set(['approveGroup']),
};
async function bodyBytes(request,max) {
  if (Number(request.headers.get('content-length'))>max) fail('FILE_TOO_LARGE',413);
  const reader=request.body?.getReader(); if (!reader) fail('VALIDATION_ERROR',422);
  const chunks=[]; let count=0;
  try {
    for (;;) {
      const {value,done}=await reader.read(); if(done) break;
      count+=value.length;
      if (count>max) {await reader.cancel();fail('FILE_TOO_LARGE',413);}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return Buffer.concat(chunks,count);
}
async function inputJson(req) {
  if (req.headers.get('content-type')?.split(';')[0].trim()!=='application/json') fail('JSON_REQUIRED',415);
  const bytes=await bodyBytes(req,512*1024);
  try {
    const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    if (!input||typeof input!=='object'||Array.isArray(input)) throw Error();
    return input;
  } catch {fail('INVALID_JSON',400);}
}
async function clock(tx) {
  const {rows}=await tx.client.query({text:'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now',values:[]});
  const at=Number(rows[0]?.now);
  if (!Number.isSafeInteger(at)||at<tx.now) fail('SERVICE_UNAVAILABLE',503);
  return at;
}
async function inDomainRole(tx,work) {
  const [{initial}]=(await tx.client.query({text:'SELECT current_user::text AS initial',values:[]})).rows;
  await tx.client.query({text:'SET LOCAL ROLE ua_cabinet_stage',values:[]});
  const value=await work();
  // A failure aborts the entire transaction; its transaction-local role is reset by ROLLBACK.
  await tx.client.query({text:"SELECT set_config('role',$1,true)",values:[initial]});
  return value;
}
async function studentTransaction(options,pool,request,operation) {
  const token=bearer(request),digest=await proofHash(token);
  let expiry=0,checked=0,completed=false;
  return new PostgresTransactions(pool).runPrepared({
    prepare:async client=>[(await locateStudentAccessOnClient(client,digest)).personId],
    beforeCommit:()=>{
      request.signal.throwIfAborted();
      const now=options.verifier.now();
      if (!completed||!Number.isSafeInteger(now)||now>=expiry||now<checked) fail('SESSION_REVOKED',401);
    },
  },async tx=>{
    const personId=tx.personIds[0];
    const {state,familyId}=await new ClerkAuthRows().loadSession({client:tx.client,personId,now:tx.now,existing:true},{kind:'access',digest},false);
    const materialized=combined(state),family=state.families[familyId],entry=state.access[digest];
    if (!entry||!family) fail('SESSION_REVOKED',401);
    checked=await clock(tx); tx.now=checked;
    const identity=await authenticate(materialized.domain.student,token,checked);
    if (identity.personId!==personId || identity.familyId!==familyId) fail('SESSION_REVOKED',401);
    expiry=Math.min(family.expiresAt,entry.expiresAt);
    if (family.authProvider==='telegram') {
      if (options.allowLegacyTelegram!==true||state.familyBindings[familyId]) fail('FORBIDDEN',403);
    } else {
      if (family.authProvider!=='clerk') fail('SESSION_REVOKED',401);
      await guardBoundFamily({state:materialized,now:()=>tx.now,restrictProviderExpiry:value=>{expiry=Math.min(expiry,value);}},request,'',{
        verifier:options.verifier,liveness:(identity,now)=>options.liveness(identity,now,{signal:request.signal})});
    }
    await setTrustedPhase(tx.client,'domain');
    tx.now=await clock(tx);
    if (tx.now>=expiry) fail('SESSION_REVOKED',401);
    const result=await inDomainRole(tx,()=>operation(tx,{personId,role:'student'}));
    checked=await clock(tx);
    await authenticate(materialized.domain.student,token,checked);
    if (checked>=expiry) fail('SESSION_REVOKED',401);
    completed=true;return result;
  });
}
function httpsOrigin(origin) {
  try { const u=new URL(origin);return u.origin===origin&&u.protocol==='https:'; }catch{return false;}
}
export function createCabinetApi(options, normalizeImage) {
  const configured=options.enabled===true;
  return {async fetch(req){
    const responseHeaders=new Headers({'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
    const reply=(status,body)=>Response.json(body,{status,headers:responseHeaders});
    try {
      if (!configured) fail('NOT_FOUND',404);
      if (!httpsOrigin(options.teacherOrigin)||!httpsOrigin(options.studentOrigin)||!options.pool||
          !options.verifier?.authorizedParties?.includes(options.teacherOrigin)||typeof options.liveness!=='function') fail('SERVICE_UNAVAILABLE',503);
      const url=new URL(req.url),match=/^\/api\/v1\/(teacher|admin|student)\/pilot\/(dashboard|import-preview|media(?:\/([0-9a-f-]{36}))?|commands\/([A-Za-z]+))$/.exec(url.pathname);
      const groupId=availableStudentsGroup(url.pathname);
      if((!match&&!groupId)||!cabinetQueryAllowed(url,req.method)||url.hash||url.username||url.password) fail('NOT_FOUND',404);
      const role=groupId?'teacher':match[1],path=match?.[2],mediaId=match?.[3],command=match?.[4];
      const origin=req.headers.get('origin');
      const publicOrigin=role==='student'?options.studentOrigin:options.teacherOrigin;
      if (url.origin!==publicOrigin && !(role==='student'&&url.origin===options.apiOrigin)) fail('NOT_FOUND',404);
      if (origin!==null && origin!==publicOrigin) fail('FORBIDDEN',403);
      if (origin) {responseHeaders.set('access-control-allow-origin',origin);responseHeaders.set('vary','Origin');}
      if (req.method==='OPTIONS') {
        if(!origin||!['GET','POST'].includes(req.headers.get('access-control-request-method'))) fail('FORBIDDEN',403);
        responseHeaders.set('access-control-allow-methods','GET, POST');
        responseHeaders.set('access-control-allow-headers','authorization, content-type, idempotency-key, accept');
        return new Response(null,{status:204,headers:responseHeaders});
      }
      const authorization=req.headers.get('authorization');
      if (!authorization||authorization.length>8192||!/^Bearer [^\s]+$/i.test(authorization)) fail('AUTH_REQUIRED',401);
      let input={},key,action;
      if (req.method==='GET' && path==='dashboard') action='dashboard';
      else if (req.method==='GET' && groupId) {action='availableStudents';input={groupId,after:url.searchParams.get('after')};}
      else if (req.method==='GET' && mediaId && role!=='admin') {action='readMedia';input={id:mediaId};}
      else if (req.method==='POST'&&command&&actions[role].has(command)) {
        action=command;key=req.headers.get('idempotency-key');
        if (typeof key!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) fail('IDEMPOTENCY_KEY_REQUIRED',400);
        input=await inputJson(req);
      } else if (req.method==='POST' && role==='teacher' && path==='import-preview') {
        action='previewText';input=await inputJson(req);
      } else if (req.method==='POST' && role==='teacher' && path==='media') {
        const type=req.headers.get('content-type')?.split(';')[0].trim();
        if (!Object.hasOwn(imageLimits,type)) fail('IMAGE_TYPE_REQUIRED',415);
        action='putMedia';input={raw:await bodyBytes(req,imageLimits[type]),type};
      } else fail('NOT_FOUND',404);
      const pool=transactionPoolPort(options.pool);
      const operation=async(tx,actor)=>{
        if(action==='previewText') {
          // Check the teacher's current database role/subject grant even for a read-only preview.
          await runStagingPilot(tx,actor,'dashboard',{},null);
          return parseTeacherTestText(input.text);
        }
        if(action==='putMedia') input={id:randomUUID(),contentType:'image/png',bytes:await normalizeImage(input.raw,input.type)};
        const data=await runStagingPilot(tx,actor,action,input,key);
        if(action==='createInvite'||action==='sendInvite') return {...data,telegramUrl:'https://t.me/univeracademybot?start='+encodeURIComponent(data.token)};
        return data;
      };
      let result;
      if (role==='student') result=await studentTransaction(options,pool,req,operation);
      else {
        const verifier=options.verifier;
        const proof=await createClerkVerifier({...verifier,authorizedParties:[options.teacherOrigin]})(authorization.slice(7));
        result=await createClerkPersonTransactions({pool,verifier}).run(proof,req.signal,async scope=>{
          const {tx}=scope;
          const validUntil=await requireLiveClerk(proof,await scope.clock(),(identity,now)=>options.liveness(identity,now,{signal:req.signal}));
          scope.restrictLease(validUntil);
          tx.now=await scope.clock();if(tx.now>=validUntil) fail('CLERK_SESSION_REVOKED',401);
          return inDomainRole(tx,()=>operation(tx,{personId:tx.personIds[0],role}));
        });
      }
      if (result instanceof CommittedAttemptError) throw result.error;
      if (action==='readMedia') {
        responseHeaders.set('content-type','image/png');
        return new Response(result.bytes,{status:200,headers:responseHeaders});
      }
      return reply(200,{data:result});
    }catch(error){
      const known=error instanceof ApiFault || (error.status===422&&['INVALID_FORMULA','INVALID_TEXT_IMPORT','INVALID_IMAGE'].includes(error.code));
      const status=known?error.status:500;
      const code=known?error.code:'INTERNAL_ERROR';
      return reply(status,{error:{code,message:typeof error.detail==='string'?error.detail.slice(0,300):code}});
    }
  }};
}
