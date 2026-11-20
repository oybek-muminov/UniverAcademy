import {StudentApiError,StudentClientProtocolError,STUDENT_PROFILE_ACCEPT,decodeStudentSession} from './student-client.ts';
import type {StudentSchema} from './student-client.ts';
export const TELEGRAM_ATOMIC_CONTRACT_SHA256='2d575800ef4548634867a1dbae622539d537d9f45dd900aa039f8ce15614b13a';
export const TELEGRAM_ATOMIC_CONTRACT_VERSION='0.1.1-univeracademy-id.1';
export type TelegramAtomicInput={init_data:string;confirmation:'link-telegram-account-v1'};
export type TelegramAtomicClientOptions={mode:'production';contractSha256:string;baseUrl:string;transport(request:Request):Promise<Response>;timeoutMs?:number};
function bad(code='CLIENT_INVALID_RESPONSE'):never{throw new StudentClientProtocolError(code);}
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
// Keep the atomic entry's stricter protocol checks after common ID normalization.
function validateAtomicSession(value: unknown, contentType: string | null): StudentSchema['SuccessSession'] {
  const result = decodeStudentSession(value, contentType);
  const session = result.data, profile = session.profile;
  const validToken = (v: string) => v.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(v);
  const validDate = (v: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) &&
    new Date(Date.parse(v)).toISOString().slice(0,19) === v.slice(0,19);
  if (!validToken(session.access_token) || !validToken(session.refresh_token) ||
      !validDate(session.expires_at) || !validDate(session.refresh_expires_at) ||
      Date.parse(session.expires_at) > Date.parse(session.refresh_expires_at) || !uuid(profile.person_id) ||
      (profile.active_group_id !== null && !uuid(profile.active_group_id)) ||
      [profile.first_name,profile.last_name].some(name => Array.from(name).length > 100 || /[\x00-\x1f\x7f]/.test(name))) bad();
  return result;
}
/** Backend-owned additive client. No token storage, identity fields, retry,
 * native fetch fallback, or changes to the legacy student-client contract. */
export function createProductionTelegramAtomicClient(options:TelegramAtomicClientOptions){
 if(options?.mode!=='production')bad('PRODUCTION_CLIENT_MODE_REQUIRED');
 if(options.contractSha256!==TELEGRAM_ATOMIC_CONTRACT_SHA256)bad('CONTRACT_HASH_MISMATCH');
 let base:URL;try{base=new URL(options.baseUrl);}catch{bad('INVALID_PRODUCTION_BASE_URL');}
 const host=base.hostname;
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname.replace(/\/$/,'')!=='/api/v1'||typeof options.transport!=='function'||host==='localhost'||host.endsWith('.localhost')||host==='[::1]'||/^127\./.test(host)||host==='0.0.0.0'||host==='[::]'||host.endsWith('.invalid')||host==='invalid')bad('INVALID_PRODUCTION_BASE_URL');
 const timeoutMs=options.timeoutMs??10000;if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)bad('INVALID_CLIENT_TIMEOUT');
 const endpoint=base.origin+'/api/v1/auth/telegram/entry',transport=options.transport;
 return Object.freeze({async enter(clerkJWT:string,input:TelegramAtomicInput):Promise<StudentSchema['SuccessSession']>{
  if(typeof clerkJWT!=='string'||clerkJWT.length>16384||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(clerkJWT))bad('INVALID_CLERK_TOKEN');
  if(!plain(input)||Reflect.ownKeys(input).length!==2||!Object.hasOwn(input,'init_data')||!Object.hasOwn(input,'confirmation'))bad('INVALID_TELEGRAM_REQUEST');
  const raw=Object.getOwnPropertyDescriptor(input,'init_data'),confirmation=Object.getOwnPropertyDescriptor(input,'confirmation');
  if(!raw||!Object.hasOwn(raw,'value')||typeof raw.value!=='string'||!raw.value||raw.value.length>16384||!confirmation||!Object.hasOwn(confirmation,'value')||confirmation.value!=='link-telegram-account-v1')bad('INVALID_TELEGRAM_REQUEST');
  const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const timeout=setTimeout(()=>controller.abort(),timeoutMs);
  let abort:(()=>void)|undefined;
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>{void reader?.cancel().catch(()=>{});reject(new StudentClientProtocolError('CLIENT_REQUEST_UNCONFIRMED'));};controller.signal.addEventListener('abort',abort,{once:true});});
  const work=async()=>{
   const response=await transport(new Request(endpoint,{method:'POST',headers:{accept:STUDENT_PROFILE_ACCEPT,'content-type':'application/json',authorization:'Bearer '+clerkJWT},body:JSON.stringify({init_data:raw.value,confirmation:confirmation.value}),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal}));
   if(controller.signal.aborted){void response?.body?.cancel().catch(()=>{});bad('CLIENT_REQUEST_UNCONFIRMED');}
   if(!(response instanceof Response)||response.redirected||(response.url&&response.url!==endpoint)||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))bad();
   reader=response.body?.getReader();if(!reader)bad();let length=0;const chunks:Uint8Array[]=[];
   try{for(;;){const part=await reader.read();if(controller.signal.aborted)bad('CLIENT_REQUEST_UNCONFIRMED');if(part.done)break;length+=part.value.byteLength;if(length>65536)bad();chunks.push(part.value);}}
   finally{void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{bad();}
   if(!response.ok){
    if(!plain(value)||!plain(value.error)||typeof value.error.code!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(value.error.code))bad();
    throw new StudentApiError(response.status,value.error.code,uuid(value.error.request_id)?value.error.request_id:'');
   }
   if(response.status!==200)bad();return validateAtomicSession(value,response.headers.get('content-type'));
  };
  try{return await Promise.race([work(),cancelled]);}
  catch(error){if(error instanceof StudentApiError||error instanceof StudentClientProtocolError)throw error;bad('CLIENT_REQUEST_UNCONFIRMED');}
  finally{clearTimeout(timeout);if(abort)controller.signal.removeEventListener('abort',abort);}
 }});
}
export type TelegramAtomicClient=ReturnType<typeof createProductionTelegramAtomicClient>;
