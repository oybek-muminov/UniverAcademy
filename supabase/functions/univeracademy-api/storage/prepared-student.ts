import {fail} from "../fault.ts";
import {authenticate,bearer,proofHash} from "../student-state.ts";
import type {StudentState,StudentTransactions,TransactionContext} from "../student-state.ts";
import {PostgresTransactions,integer} from "./postgres-transaction.ts";
import type {PgPool,PgClient,LockedTransaction} from "./postgres-transaction.ts";
import {locateStudentAccessOnClient} from "./student-scope.ts";
import {StudentHttpRows} from "./student-http-rows.ts";
import {setTrustedPhase} from "./trusted-server-context.ts";

// The first student flow uses existing opaque application-session proofs. Login,
// refresh/logout, staff and removal remain in their existing adapters.
export function isFirstStudentRequest(request:Request):boolean {
  const p=new URL(request.url).pathname.replace(/\/$/,""),m=request.method;
  return (m==="GET"&&(p==="/api/v1/me"||p==="/api/v1/exams"||
    /^\/api\/v1\/exams\/[^/]+$/.test(p)||/^\/api\/v1\/attempts\/[^/]+(?:\/result)?$/.test(p)))||
    (m==="POST"&&(/^\/api\/v1\/exams\/[^/]+\/attempts$/.test(p)||/^\/api\/v1\/attempts\/[^/]+\/submit$/.test(p)))||
    (m==="PUT"&&/^\/api\/v1\/attempts\/[^/]+\/answers\/[^/]+$/.test(p));
}
// Only implemented non-prepared operations may reach the existing adapters.
// Unknown methods/paths use the handler's NOT_FOUND response, before row loading.
export function isLegacyStudentRequest(request:Request):boolean {
  const p=new URL(request.url).pathname.replace(/\/$/,""),m=request.method;
  return (m==="POST"&&["/api/v1/auth/telegram","/api/v1/auth/refresh","/api/v1/auth/logout"].includes(p))||
    (m==="PATCH"&&p==="/api/v1/me")||
    (m==="GET"&&/^\/api\/v1\/exams\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/history$/.test(p));
}
type Binding=Readonly<{method:string;url:string;bodyDigest:string;keyDigest:string;proofDigest:string}>;
type Entry={request:Request;used:boolean;client?:PgClient;personId?:string;binding?:Binding;
  phase:"created"|"located"|"authorized"|"flushed"|"closed"};
const entries=new WeakMap<object,Entry>();
const entry=(key:object)=>{const e=entries.get(key);if(!e||e.phase==="closed")fail("SERVICE_UNAVAILABLE",503);return e;};
const check=(e:Entry,tx:LockedTransaction)=>{
  if(e.request.signal.aborted||e.client!==tx.client||tx.personIds.length!==1||tx.personIds[0]!==e.personId)
    fail("SERVICE_UNAVAILABLE",503);
};
async function fresh(tx:LockedTransaction):Promise<void>{
  const r=await tx.client.query({name:"ua_clock",text:"SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms",values:[]});
  if(r.rows.length!==1)fail("SERVICE_UNAVAILABLE",503);
  const now=integer(r.rows[0].now_ms);if(now<tx.now||now>8_640_000_000_000_000)fail("SERVICE_UNAVAILABLE",503);tx.now=now;
}

const same=(a:unknown,b:unknown)=>JSON.stringify(a,(_,v)=>typeof v==="bigint"?v.toString():v)===JSON.stringify(b,(_,v)=>typeof v==="bigint"?v.toString():v);
function assertRequestWrites(request:Request,raw:string,before:StudentState,after:StudentState,personId:string):void{
  const path=new URL(request.url).pathname.replace(/\/$/,""),m=request.method;
  const start=path.match(/^\/api\/v1\/exams\/([^/]+)\/attempts$/),exam=path.match(/^\/api\/v1\/exams\/([^/]+)$/);
  const target=path.match(/^\/api\/v1\/attempts\/([^/]+)(?:\/(submit|result|answers\/([^/]+)))?$/);
  let input:Record<string,unknown>|undefined;
  const parsed=()=>{if(input)return input;let value;try{value=JSON.parse(raw);}catch{fail("RESPONSE_INVARIANT_FAILED",500);}
    if(!value||typeof value!=="object"||Array.isArray(value))fail("RESPONSE_INVARIANT_FAILED",500);return input=value;};
  const changed=Object.keys(after.attempts).filter(id=>!same(before.attempts[id],after.attempts[id]));
  for(const id of changed){
    const old=before.attempts[id],next=after.attempts[id];
    if(next.personId!==personId||
      (target?id!==target[1].toLowerCase():start?next.assignmentId!==start[1].toLowerCase():exam?next.assignmentId!==exam[1].toLowerCase():path!=="/api/v1/exams"))fail("RESPONSE_INVARIANT_FAILED",500);
    if(!old){
      if(!(m==="POST"&&start)||changed.length!==1||parsed().confirmed!==true||Object.keys(parsed()).length!==1)fail("RESPONSE_INVARIANT_FAILED",500);
    }
    if(m==="POST"&&target?.[2]==="submit"&&raw!=="")fail("RESPONSE_INVARIANT_FAILED",500);
    const answers=next.answers.filter(a=>!same(old?.answers.find(b=>b.questionId===a.questionId),a));
    if(answers.length){
      if(m!=="PUT"||!target?.[3]||answers.length!==1||answers[0].questionId!==target[3].toLowerCase())fail("RESPONSE_INVARIANT_FAILED",500);
      const body=parsed();
      if(!Number.isSafeInteger(body.expected_revision)||typeof body.expected_revision!=="number"||(body.selected_option_id!==null&&typeof body.selected_option_id!=="string")||Object.keys(body).sort().join(",")!=="expected_revision,selected_option_id"||answers[0].revision!==body.expected_revision+1||answers[0].selectedOptionId!==(typeof body.selected_option_id==="string"?body.selected_option_id.toLowerCase():body.selected_option_id))fail("RESPONSE_INVARIANT_FAILED",500);
    }
  }
  const demos=new Set(changed.map(id=>after.attempts[id].published.demoId));
  for(const key of Object.keys(after.series))if(!same(before.series[key],after.series[key])&&
    (!key.startsWith(personId+"/")||!demos.has(key.slice(personId.length+1))))fail("RESPONSE_INVARIANT_FAILED",500);
  for(const key of Object.keys(after.receipts))if(!same(before.receipts[key],after.receipts[key])){
    const receiptKey=request.headers.get("idempotency-key");
    if(!receiptKey||receiptKey.length<8||receiptKey.length>128)fail("RESPONSE_INVARIANT_FAILED",500);
    const receiptPath=start?`/exams/${start[1].toLowerCase()}/attempts`:
      target?.[2]==="submit"?`/attempts/${target[1].toLowerCase()}/submit`:undefined;
    if(m!=="POST"||receiptPath===undefined||key!==`${personId}/${m}/${receiptPath}/${receiptKey}`)fail("RESPONSE_INVARIANT_FAILED",500);
  }
}

// Server-owned broker. Its WeakMap record, checked-out client and auth projection
// never reach the student handler callback. This is a JS lifetime/scope boundary,
// Trusted-server assertion only; not authentication against DB-credential holders
// and not proof of RLS isolation.
// No caller-controlled `trusted`/activation flag, credential loader or fallback.
export type BoundStudentAuthorization=(tx:LockedTransaction,auth:StudentState)=>Promise<()=>void>;
export class PreparedStudentTransactions implements StudentTransactions {
  readonly #pool:PgPool;
  readonly #authorizeBound?:BoundStudentAuthorization;
  constructor(pool:PgPool,request:Request,authorizeBound?:BoundStudentAuthorization){
    if(!isFirstStudentRequest(request))fail("SERVICE_UNAVAILABLE",503);
    this.#pool=pool;this.#authorizeBound=authorizeBound;
    entries.set(this,{request:request.clone(),used:false,phase:"created"});
    Object.freeze(this);
  }
  async transaction<T>(work:(tx:TransactionContext)=>Promise<T>):Promise<T>{
    const e=entry(this);if(e.used||typeof work!=="function")fail("SERVICE_UNAVAILABLE",503);e.used=true;
    let boundGuard:(()=>void)|undefined;
    const checkBound=()=>{if(boundGuard&&boundGuard()!==undefined)fail("SERVICE_UNAVAILABLE",503);};
    try{
      const token=bearer(e.request)!;
      const raw=await e.request.clone().text();
      e.binding=Object.freeze({method:e.request.method,url:e.request.url,
        bodyDigest:await proofHash(raw),
        keyDigest:await proofHash(e.request.headers.get("idempotency-key")??""),proofDigest:await proofHash(token)});
      if(e.request.signal.aborted)fail("SERVICE_UNAVAILABLE",503);
      return await new PostgresTransactions(this.#pool).runPrepared({
        prepare:async client=>{
          e.client=client;
          const scope=await locateStudentAccessOnClient(client,e.binding!.proofDigest);
          if(scope.kind!=="person")fail("SERVICE_UNAVAILABLE",503);
          e.personId=scope.personId;e.phase="located";return [scope.personId];
        },
        beforeCommit:()=>{
          if(e.phase!=="flushed"||e.request.signal.aborted||!e.binding)fail("SERVICE_UNAVAILABLE",503);
          checkBound();
        },
        observe:event=>{if(event.kind==="commit_ack"||event.kind==="commit_unknown"||event.kind==="rollback_start"||event.kind==="cleanup")e.phase="closed";},
      },async tx=>{
        check(e,tx);
        const personId=e.personId!,rows=new StudentHttpRows(this.#authorizeBound?{boundClerk:true,externalAuthWriter:true}:{}),auth=await rows.loadAuthentication(tx,personId);
        const authority=structuredClone(auth);
        const authorize=async()=>{await fresh(tx);check(e,tx);
          if((await authenticate(authority,token,tx.now)).personId!==personId)fail("SESSION_REVOKED",401);
          checkBound();};
        // The locator is a hint. Verify current proof/family/account/role under
        // the same person lock BEFORE loading any assignment/attempt/answer.
        await authorize();
        if(this.#authorizeBound){
          boundGuard=await this.#authorizeBound(tx,structuredClone(authority));
          if(typeof boundGuard!=="function")fail("SERVICE_UNAVAILABLE",503);
          await authorize();
        }
        e.phase="authorized";
        await setTrustedPhase(tx.client,"domain");
        await authorize(); // The context statement is another async boundary.
        const profileOnly=e.request.method==="GET"&&new URL(e.request.url).pathname.replace(/\/$/,"")==="/api/v1/me";
        const state=profileOnly?auth:await rows.loadDomain(tx,personId,auth),before=structuredClone(state);
        await authorize();check(e,tx);
        const value=await work({state,now:()=>{check(e,tx);if(e.phase!=="authorized")fail("SERVICE_UNAVAILABLE",503);return tx.now;}});
        check(e,tx);await authorize();
        const authView=(s:StudentState)=>JSON.stringify({people:s.people,families:s.families,access:s.access,refresh:s.refresh,consumedInitData:s.consumedInitData});
        if(authView(before)!==authView(state))fail("RESPONSE_INVARIANT_FAILED",500);
        assertRequestWrites(e.request,raw,before,state,personId);
        await rows.flush(tx,personId,before,state);
        await authorize();e.phase="flushed";
        return value;
      });
    }finally{e.phase="closed";e.client=undefined;entries.delete(this);}
  }
}
