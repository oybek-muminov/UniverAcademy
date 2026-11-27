import {fetchNativeCabinet} from './cloudflare-cabinet-route.mjs';
import {forwardTeacherStaging} from './teacher-staging-proxy.mjs';
import {telegramMenuEnvironmentKeys} from './telegram-menu-completion.mjs';
import {createTelegramClerkEntryApi,atomicEntryEnabled,atomicAuthorizedParties,atomicEntryEnvironmentKeys} from "./telegram-clerk-entry-api.mjs";
import {createTelegramRegisterApi,telegramRegisterEnvironmentKeys,REGISTER_PATH} from "./telegram-register-api.mjs";
import {createDeletionApi,isDeletionRequestPath,deletionRequestEnvironmentKeys} from "./account-deletion-api.mjs";
import {isContractPath} from "./contract-paths.mjs";
import {isHyperdriveConnectionString} from "./hyperdrive-connection-string.mjs";
import {ApiFault} from "../supabase/functions/univeracademy-api/fault.ts";
import {checkSessionPolicy} from "../supabase/functions/univeracademy-api/student-state.ts";
import {createCloudflareApi} from "./cloudflare-api.mjs";
import {createClerkWorkerAdapter} from "./clerk-worker-bindings.mjs";
import {publicEnvironmentOptions} from "./vercel-node.mjs";
import {withPublicCors} from "./local-cors.mjs";
import {channelGateBlocks,CHANNEL_REQUIRED_CODE} from "./channel-gate-api.mjs";
import {createTelegramDirectory} from "./cloudflare-telegram-directory.mjs";
import {readStagingStaffCabinet} from "./staging-private-start.mjs";

const unavailable=()=>new ApiFault("SERVICE_UNAVAILABLE",503);
const deny=()=>{throw unavailable();};
// Registration uses no scoring conversion. Never import a test or rounding policy
// to make the existing composition shape look ready for scoring operations.
const unavailableNumbers=Object.freeze({policyId:"registration-only-scoring-unavailable",
  toFiniteNumber:deny,toDisplayString:deny,toStudentPointsDisplayString:deny});
// These bindings share the API Worker with registration. Only the pilot route,
// directory RPC and scheduled handler consume their own values.
const pilotEnvironmentKeys=[
  "UA_CABINET_OWNER_ORIGIN","UA_CABINET_STAGING_ENABLED","UA_CABINET_STAGING_NODE_ORIGIN","UA_CABINET_STAGING_PROXY_SECRET",
  "UA_CABINET_STUDENT_ORIGIN","UA_TELEGRAM_PILOT_DIRECTORY_ENABLED","UA_TELEGRAM_PILOT_DISPATCH_ENABLED","UA_TEACHER_NOTICES_ENABLED",
  "TEACHER_PILOT_HYPERDRIVE","CABINET_HYPERDRIVE","UA_CABINET_RUNTIME","UA_CABINET_TEACHER_ORIGIN","UA_CABINET_ALLOW_LEGACY_TELEGRAM",
];
const envKeys=["UA_API_ORIGIN","UA_ALLOWED_ORIGINS","UA_SESSION_POLICY",
  "UA_CLERK_PROVIDER_SETTINGS","UA_CLERK_SECRET_KEY","HYPERDRIVE","UA_TELEGRAM_BOT_TOKEN","UA_TELEGRAM_LOOKUP_TIMEOUT_MS","UA_TELEGRAM_START_MODE",
  "UA_CHANNEL_GATE_ENABLED","UA_REQUIRED_CHANNEL","UA_REQUIRED_CHANNEL_URL",
  "UA_TELEGRAM_LOGIN_ENABLED","UA_TELEGRAM_LOGIN_CLIENT_ID","UA_TELEGRAM_LOGIN_CLIENT_SECRET","UA_TELEGRAM_LOGIN_REDIRECT_URI",
  ...pilotEnvironmentKeys,...deletionRequestEnvironmentKeys,...atomicEntryEnvironmentKeys,...telegramMenuEnvironmentKeys,...telegramRegisterEnvironmentKeys];
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
  if(!isHyperdriveConnectionString(connectionString))throw unavailable();
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
const TELEGRAM_JWKS="https://oauth.telegram.org/.well-known/jwks.json";
async function defaultTelegramKeys(){
  const {createRemoteJWKSet}=await import("jose");
  return createRemoteJWKSet(new URL(TELEGRAM_JWKS),{timeoutDuration:3000,cooldownDuration:30000,cacheMaxAge:600000});
}
function telegramLoginEnabled(env){
  const d=env&&Object.getOwnPropertyDescriptor(env,"UA_TELEGRAM_LOGIN_ENABLED");
  if(!d)return false;
  if(!Object.hasOwn(d,"value")||!["true","false"].includes(d.value))throw unavailable();
  return d.value==="true";
}
async function telegramLoginConfig(env,transport,telegramKeys){
  const clientId=own(env,"UA_TELEGRAM_LOGIN_CLIENT_ID"),clientSecret=own(env,"UA_TELEGRAM_LOGIN_CLIENT_SECRET"),redirectUri=own(env,"UA_TELEGRAM_LOGIN_REDIRECT_URI");
  if(typeof clientId!=="string"||typeof clientSecret!=="string"||typeof redirectUri!=="string")throw unavailable();
  const trustedKeys=await telegramKeys();
  if(typeof trustedKeys!=="function")throw unavailable();
  return Object.freeze({clientId,clientSecret,redirectUri,transport,trustedKeys});
}
// Kanal a'zoligi shart: 403 + kanal havolasi. Mini App shu kod bo'yicha "Kanalga o'tish" ekranini ochadi.
function channelRequired(gate){
  return new Response(JSON.stringify({error:{code:CHANNEL_REQUIRED_CODE,message:CHANNEL_REQUIRED_CODE,request_id:crypto.randomUUID(),channel_url:gate.url}}),{status:403,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",
      "cdn-cache-control":"no-store","cloudflare-cdn-cache-control":"no-store"}});
}
function registrationRoute(request){
  const p=new URL(request.url).pathname;
  return (request.method==="POST"&&/^\/api\/v1\/auth\/(clerk|refresh|logout|telegram\/(?:link|resume|browser-link))\/?$/.test(p))||
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
  makeClerk=createClerkWorkerAdapter,transport=request=>globalThis.fetch(request),now=Date.now,readStaff=readStagingStaffCabinet,telegramKeys=defaultTelegramKeys}={}){
  if([loadClient,makeClerk,transport,now,readStaff,telegramKeys].some(v=>typeof v!=="function"))throw unavailable();
  return Object.freeze({async fetch(request,env){
    let publics;
    try{
      if(!(request instanceof Request))throw unavailable();
      if (new URL(request.url).pathname.startsWith('/api/v1/student/pilot/')) {
        const mode=env?.UA_CABINET_RUNTIME;
        if (mode==='worker') return fetchNativeCabinet(request,env,'student');
        if (mode!==undefined && mode!=='node') return response('NOT_FOUND',404);
        return forwardTeacherStaging(request,env,{surface:'student',transport});
      }
      publics=publicBindings(env);
      if(new URL(request.url).origin!==publics.apiOrigin)return response("MALFORMED_REQUEST",400);
      if(isDeletionRequestPath(new URL(request.url).pathname))
        return await createDeletionApi({allowedOrigins:publics.allowedOrigins,loadClient,makeClerk,transport,now}).fetch(request,env);
      if(new URL(request.url).pathname.replace(/\/$/,"")===REGISTER_PATH)
        return await createTelegramRegisterApi({allowedOrigins:publics.allowedOrigins,getBindings:env=>privateBindings(env,true),loadClient,transport,now}).fetch(request,env);
      if(new URL(request.url).pathname==="/api/v1/auth/telegram/entry")
        return await createTelegramClerkEntryApi({allowedOrigins:publics.allowedOrigins,getBindings:env=>privateBindings(env,true),loadClient,makeClerk,transport,now,numericPresentation:unavailableNumbers}).fetch(request,env);
      return await withPublicCors(async scopedRequest=>{
        // Liveness only: no private binding, database, provider, version or topology.
        if(scopedRequest.method==="GET"&&new URL(scopedRequest.url).pathname==="/health")
          return new Response('{"status":"ok"}',{status:200,headers:{"content-type":"application/json","cache-control":"no-store"}});
        if(!new URL(scopedRequest.url).pathname.startsWith("/api/v1/"))return response("NOT_FOUND",404);
        if(!registrationRoute(scopedRequest))return isContractPath(new URL(scopedRequest.url).pathname)?response():response("NOT_FOUND",404);
        let clerk,result;
        try{
          if(scopedRequest.signal.aborted)throw unavailable();
          const telegram=/^\/api\/v1\/auth\/telegram\/(link|resume|browser-link)\/?$/.test(new URL(scopedRequest.url).pathname);
          const path=new URL(scopedRequest.url).pathname.replace(/\/$/,"");
          const atomic=(path==="/api/v1/auth/clerk"||path==="/api/v1/auth/telegram/link")&&atomicEntryEnabled(env);
          if(atomic&&path==="/api/v1/auth/telegram/link")return response("NOT_FOUND",404);
          // "Log In With Telegram" browser link: absent unless explicitly enabled, then fully configured or unavailable.
          let telegramLogin;
          if(path==="/api/v1/auth/telegram/browser-link"){
            if(!telegramLoginEnabled(env))return response("NOT_FOUND",404);
            telegramLogin=await telegramLoginConfig(env,transport,telegramKeys);
          }
          const bindings=privateBindings(env,telegram);
          if(atomic&&path==="/api/v1/auth/clerk"){
            const parties=atomicAuthorizedParties(env,bindings.settings);
            const webParties=bindings.settings.authorizedParties.filter(p=>!parties.includes(p));
            if(!webParties.length)return response("NOT_FOUND",404);
            bindings.settings={...bindings.settings,authorizedParties:webParties};
          }
          if(path==="/api/v1/auth/telegram/resume"){
            // Faqat kabineti bor o'quvchi; yangi o'quvchi /link yo'lidan o'tadi va bu yerga kirmaydi.
            const directory=createTelegramDirectory({loadClient});
            const lookupEnv={...env};delete lookupEnv.UA_TELEGRAM_START_MODE; // "faqat ro'yxatdan o'tish" rejimi haqiqiy holatni yashiradi
            const blocked=await channelGateBlocks({request:scopedRequest,env,bindings,now,
              fetcher:(url,init)=>transport(new Request(url,init)),
              isLinked:async id=>(await directory.lookupTelegramStart({update_id:0,telegram_user_id:id},lookupEnv)).status==="linked",
              isStaff:async id=>(await readStaff({telegramUserId:id},env))!==null});
            if(blocked){result=channelRequired(blocked);return result;}
          }
          clerk=await makeClerk(bindings.settings,{secretKey:bindings.secretKey,transport,now,
            timeoutMs:bindings.settings?.timeoutMs,maxResponseBytes:65536,signal:scopedRequest.signal});
          if(scopedRequest.signal.aborted||typeof clerk?.close!=="function")throw unavailable();
          if(atomic)clerk={...clerk,verifier:{...clerk.verifier,authorizedParties:bindings.settings.authorizedParties}};
          const Client=await loadClient();
          if(scopedRequest.signal.aborted||typeof Client!=="function")throw unavailable();
          const configuration={mode:"production",sessionPolicy:bindings.sessionPolicy,
            numericPresentation:unavailableNumbers,now,...(telegram?{botToken:bindings.botToken}:{}),...(telegramLogin?{telegramLogin}:{}),clerk:{verifier:clerk.verifier,liveness:clerk.liveness}};
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
