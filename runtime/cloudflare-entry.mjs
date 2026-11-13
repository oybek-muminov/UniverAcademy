import {ApiFault} from "../supabase/functions/univeracademy-api/fault.ts";
import {checkSessionPolicy} from "../supabase/functions/univeracademy-api/student-state.ts";
import {createCloudflareApi} from "./cloudflare-api.mjs";
import {createClerkWorkerAdapter} from "./clerk-worker-bindings.mjs";
import {publicEnvironmentOptions} from "./vercel-node.mjs";
import {withPublicCors} from "./local-cors.mjs";

const unavailable=()=>new ApiFault("SERVICE_UNAVAILABLE",503);
const deny=()=>{throw unavailable();};
// Registration uses no scoring conversion. Never import a test or rounding policy
// to make the existing composition shape look ready for scoring operations.
const unavailableNumbers=Object.freeze({policyId:"registration-only-scoring-unavailable",
  toFiniteNumber:deny,toDisplayString:deny,toStudentPointsDisplayString:deny});
const envKeys=["UA_API_ORIGIN","UA_ALLOWED_ORIGINS","UA_SESSION_POLICY",
  "UA_CLERK_PROVIDER_SETTINGS","UA_CLERK_SECRET_KEY","HYPERDRIVE","UA_TELEGRAM_BOT_TOKEN","UA_TELEGRAM_LOOKUP_TIMEOUT_MS"];
const policyKeys=["initDataMaxAgeSeconds","futureSkewSeconds","accessTtlMs",
  "familyTtlMs","logoutTombstoneMs","identityCollisionAttempts","newLogin"];

function own(object,key){
  const d=object&&Object.getOwnPropertyDescriptor(object,key);
  if(!d||!Object.hasOwn(d,"value"))throw unavailable();
  return d.value;
}
function json(value){
  if(typeof value!=="string"||!value||value.length>65536)throw unavailable();
  try{return JSON.parse(value);}catch{throw unavailable();}
}
function publicBindings(env){
  const apiOrigin=own(env,"UA_API_ORIGIN"),origins=own(env,"UA_ALLOWED_ORIGINS");
  if(typeof apiOrigin!=="string"||typeof origins!=="string")throw unavailable();
  return publicEnvironmentOptions({UA_API_ORIGIN:apiOrigin,UA_ALLOWED_ORIGINS:origins});
}
function privateBindings(env,telegram){
  if(!env||typeof env!=="object"||![Object.prototype,null].includes(Object.getPrototypeOf(env))||
    Reflect.ownKeys(env).some(key=>typeof key!=="string"||!envKeys.includes(key)))throw unavailable();
  const sessionPolicy=json(own(env,"UA_SESSION_POLICY"));
  if(!sessionPolicy||typeof sessionPolicy!=="object"||Array.isArray(sessionPolicy)||
    Object.keys(sessionPolicy).length!==policyKeys.length||Object.keys(sessionPolicy).some(k=>!policyKeys.includes(k)))throw unavailable();
  checkSessionPolicy(sessionPolicy);
  const settings=json(own(env,"UA_CLERK_PROVIDER_SETTINGS"));
  const secretKey=own(env,"UA_CLERK_SECRET_KEY"),drive=own(env,"HYPERDRIVE");
  // HYPERDRIVE is a trusted platform binding, not a caller-provided URL. Its
  // connectionString property may be a platform accessor. No other override or
  // environment fallback is consumed. The accepted adapter validates it again.
  if(!drive||typeof drive!=="object"||Array.isArray(drive))throw unavailable();
  const connectionString=drive.connectionString;
  if(typeof secretKey!=="string"||!secretKey||/[\r\n\0]/.test(secretKey)||typeof connectionString!=="string")throw unavailable();
  let u;try{u=new URL(connectionString);}catch{throw unavailable();}
  if(!["postgres:","postgresql:"].includes(u.protocol)||!u.hostname||!u.port||!u.username||!u.password||
    u.pathname.length<2||u.search||u.hash||/\s|\0/.test(connectionString))throw unavailable();
  // Optional for every accepted non-Telegram route. Do not even evaluate an
  // accessor for an unused secret. The new proof routes require an own value.
  let botToken;
  if(telegram){botToken=own(env,"UA_TELEGRAM_BOT_TOKEN");if(typeof botToken!=="string"||!botToken||/[\r\n\0]/.test(botToken))throw unavailable();}
  return {sessionPolicy:Object.freeze(sessionPolicy),settings,secretKey,postgres:{connectionString},...(telegram?{botToken}:{})};
}
function response(code="SERVICE_UNAVAILABLE",status=503){
  return new Response(JSON.stringify({error:{code,message:code,request_id:crypto.randomUUID()}}),{status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",
      "cdn-cache-control":"no-store","cloudflare-cdn-cache-control":"no-store"}});
}
function registrationRoute(request){
  const p=new URL(request.url).pathname;
  return (request.method==="POST"&&/^\/api\/v1\/auth\/(clerk|refresh|logout|telegram\/(?:link|resume))\/?$/.test(p))||
    (["GET","PATCH"].includes(request.method)&&/^\/api\/v1\/me\/?$/.test(p))||
    (request.method==="GET"&&/^\/api\/v1\/exams\/?$/.test(p));
}

/** Trusted composition seams only; none can be registered through env/request.
 * Default construction is inert. Client and Clerk resources are request-owned;
 * no warm singleton DB client, Node listener, SDK, fixture or credential fallback.
 * Hyperdrive caching OFF, verified origin TLS and the restricted DB role remain
 * deployment gates; a syntactically valid binding does not establish them.
 */
export function createCloudflareEntrypoint({loadClient=async()=>(await import("pg")).Client,
  makeClerk=createClerkWorkerAdapter,transport=request=>globalThis.fetch(request),now=Date.now}={}){
  if([loadClient,makeClerk,transport,now].some(v=>typeof v!=="function"))throw unavailable();
  return Object.freeze({async fetch(request,env){
    let publics;
    try{
      if(!(request instanceof Request))throw unavailable();
      publics=publicBindings(env);
      if(new URL(request.url).origin!==publics.apiOrigin)return response("MALFORMED_REQUEST",400);
      return await withPublicCors(async scopedRequest=>{
        if(!new URL(scopedRequest.url).pathname.startsWith("/api/v1/"))return response("NOT_FOUND",404);
        if(!registrationRoute(scopedRequest))return response();
        let clerk,result;
        try{
          if(scopedRequest.signal.aborted)throw unavailable();
          const telegram=/^\/api\/v1\/auth\/telegram\/(link|resume)\/?$/.test(new URL(scopedRequest.url).pathname);
          const bindings=privateBindings(env,telegram);
          clerk=await makeClerk(bindings.settings,{secretKey:bindings.secretKey,transport,now,
            timeoutMs:bindings.settings?.timeoutMs,maxResponseBytes:65536,signal:scopedRequest.signal});
          if(scopedRequest.signal.aborted||typeof clerk?.close!=="function")throw unavailable();
          const Client=await loadClient();
          if(scopedRequest.signal.aborted||typeof Client!=="function")throw unavailable();
          const configuration={mode:"production",sessionPolicy:bindings.sessionPolicy,
            numericPresentation:unavailableNumbers,now,...(telegram?{botToken:bindings.botToken}:{}),clerk:{verifier:clerk.verifier,liveness:clerk.liveness}};
          // fetch awaits the accepted resource's end() before returning any ACK.
          result=await createCloudflareApi({...publics,Client,postgres:bindings.postgres,configuration}).fetch(scopedRequest);
        }catch{result=response();}
        finally{
          try{await clerk?.close();}catch{result=response();}
        }
        return result;
      },publics.allowedOrigins)(request);
    }catch{return response();} // No raw exception, private binding, body or log.
  }});
}

export default createCloudflareEntrypoint();
