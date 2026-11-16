import type {JWTVerifyGetKey} from "jose";
import {fail} from "./fault.ts";

export type ClerkIdentity={issuer:string;userId:string;sessionId:string};
export type ClerkDisplayNames=Readonly<{firstName:string|null;lastName:string|null}>;
export type ClerkProof=Readonly<ClerkIdentity&{kind:"clerk_verified";notBefore:number;expiresAt:number;authorizedParty:string;tokenId:string;tokenIdKind?:"signed_input_sha256_v1"}>;
export type ClerkVerifierConfiguration={issuer:string;authorizedParties:readonly string[];
  audience:{kind:"required";value:string}|{kind:"clerk_default_no_audience"};
  trustedKeys:JWTVerifyGetKey;now:()=>number};
export type ClerkLiveness=(identity:ClerkIdentity,now:number,options?:{signal?:AbortSignal})=>Promise<{
  issuer:string;userId:string;sessionId:string;status:string;accountEnabled:boolean;expiresAt:number;
  // Raw server-fetched display fields, not authentication inputs. Validate only
  // after the locked platform mapping selects new-person creation.
  firstName?:unknown;lastName?:unknown;
}>;
// Display data only, never identity/role authority. Match the existing API's
// Unicode code-point maximum; absent/blank names stay missing, not invented.
export function clerkDisplayNames(value:{firstName?:unknown;lastName?:unknown}):ClerkDisplayNames{
  const name=(v:unknown):string|null=>{
    if(v===undefined||v===null)return null;
    if(typeof v!=="string"||Array.from(v).length>100||v.includes("\u0000"))fail("SERVICE_UNAVAILABLE",503);
    for(const c of v)if(c.length===1&&c.charCodeAt(0)>=0xd800&&c.charCodeAt(0)<=0xdfff)fail("SERVICE_UNAVAILABLE",503);
    return v.trim()?v:null;
  };
  return Object.freeze({firstName:name(value.firstName),lastName:name(value.lastName)});
}
const user=(v:unknown):v is string=>typeof v==="string"&&/^user_[A-Za-z0-9]+(?![\s\S])/.test(v);
const session=(v:unknown):v is string=>typeof v==="string"&&/^sess_[A-Za-z0-9]+(?![\s\S])/.test(v);
const seconds=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0&&Number.isSafeInteger(v*1000);
function origin(v:unknown):boolean{
  if(typeof v!=="string")return false;
  try{const u=new URL(v);return u.origin===v&&u.protocol==="https:"&&!u.hostname.includes("*");}catch{return false;}
}
export function clerkIdentityKey(identity:Pick<ClerkIdentity,"issuer"|"userId">):string{return JSON.stringify([identity.issuer,identity.userId]);}
export function clerkSessionKey(identity:ClerkIdentity):string{return JSON.stringify([identity.issuer,identity.userId,identity.sessionId]);}
// Keep the deployed jti tuple byte-for-byte stable. Missing-jti fingerprints
// occupy a different tuple arity, so no provider jti can collide with that space.
export function clerkReplayIdentity(proof:ClerkProof):string{
  if(typeof proof.tokenId!=="string"||!proof.tokenId)fail("CLERK_TOKEN_INVALID",401);
  if(proof.tokenIdKind===undefined)return JSON.stringify([proof.issuer,proof.userId,proof.sessionId,proof.tokenId]);
  if(proof.tokenIdKind!=="signed_input_sha256_v1"||!/^[0-9a-f]{64}$/.test(proof.tokenId))fail("CLERK_TOKEN_INVALID",401);
  return JSON.stringify([proof.issuer,proof.userId,proof.sessionId,"signed_input_sha256_v1",proof.tokenId]);
}
export function checkClerkProof(proof:ClerkProof,now:number):void{
  if(proof.kind!=="clerk_verified"||!origin(proof.issuer)||!user(proof.userId)||!session(proof.sessionId)||
    !Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(proof.notBefore)||!Number.isSafeInteger(proof.expiresAt)||
    proof.notBefore>now||now>=proof.expiresAt)fail("CLERK_TOKEN_INVALID",401);
}
// Fixed server-only categories, never payloads, identities, tokens or raw errors.
// Observability is non-authoritative: a throwing log sink cannot change denial.
function verificationDenied(reason:string):void{
  try{console.warn("UA_CLERK_VERIFICATION_DENIED",reason);}catch{/* retain original authorization result */}
}
export function createClerkVerifier(config:ClerkVerifierConfiguration){
  if(!config||!origin(config.issuer)||!Array.isArray(config.authorizedParties)||!config.authorizedParties.length||
      config.authorizedParties.some(p=>!origin(p))||typeof config.trustedKeys!=="function"||typeof config.now!=="function"||
      !config.audience||!(config.audience.kind==="clerk_default_no_audience"||
      (config.audience.kind==="required"&&typeof config.audience.value==="string"&&config.audience.value.length)))fail("SERVICE_UNAVAILABLE",503);
  return async(token:string):Promise<ClerkProof>=>{
    let jose;
    try{jose=await import("jose");}catch{fail("SERVICE_UNAVAILABLE",503);}
    const {jwtVerify,errors}=jose;
    const now=config.now();if(!Number.isSafeInteger(now)||now<0)fail("SERVICE_UNAVAILABLE",503);
    let verified;
    try{
      verified=await jwtVerify(token,config.trustedKeys,{issuer:config.issuer,algorithms:["RS256"],
        ...(config.audience.kind==="required"?{audience:config.audience.value}:{}),
        requiredClaims:["iss","sub","sid","iat","nbf","exp","azp","v"],clockTolerance:0,currentDate:new Date(now)});
    }catch(error){
      if(error instanceof errors.JWKSTimeout||error instanceof errors.JWKSInvalid||error instanceof errors.JWKInvalid){
        verificationDenied("KEY_SERVICE_UNAVAILABLE");fail("SERVICE_UNAVAILABLE",503);
      }
      if(error instanceof errors.JOSEError){
        let reason="JWT_INVALID";
        if(error instanceof errors.JWTExpired)reason="JWT_EXPIRED";
        else if(error instanceof errors.JWSSignatureVerificationFailed)reason="SIGNATURE_INVALID";
        else if(error instanceof errors.JWKSNoMatchingKey)reason="KEY_NO_MATCH";
        else if(error instanceof errors.JWTClaimValidationFailed){
          const claims:Record<string,string>={iss:"CLAIM_ISS",sub:"CLAIM_SUB",sid:"CLAIM_SID",iat:"CLAIM_IAT",nbf:"CLAIM_NBF",exp:"CLAIM_EXP",azp:"CLAIM_AZP",jti:"CLAIM_JTI",v:"CLAIM_V",aud:"CLAIM_AUD"};
          reason=Object.hasOwn(claims,error.claim)?claims[error.claim]:"CLAIM_INVALID";

        }
        verificationDenied(reason);fail("CLERK_TOKEN_INVALID",401);
      }
      verificationDenied("VERIFIER_UNAVAILABLE");
      fail("SERVICE_UNAVAILABLE",503);
    }
    const p=verified.payload;
    if(typeof verified.protectedHeader.kid!=="string"||!verified.protectedHeader.kid||!user(p.sub)||!session(p.sid)||
       !seconds(p.iat)||!seconds(p.nbf)||!seconds(p.exp)||p.exp<=p.iat||p.nbf>=p.exp||p.iat*1000>now||
       p.v!==2||(config.audience.kind==="clerk_default_no_audience"&&p.aud!==undefined)||
       typeof p.azp!=="string"||!config.authorizedParties.includes(p.azp)||(Object.hasOwn(p,"jti")&&(typeof p.jti!=="string"||!p.jti))||
       (p.sts!==undefined&&p.sts!=="active")||p.act!==undefined){
      const reason=typeof verified.protectedHeader.kid!=="string"||!verified.protectedHeader.kid?"HEADER_KEY_MISSING"
        :!user(p.sub)||!session(p.sid)?"IDENTITY_SHAPE"
        :!seconds(p.iat)||!seconds(p.nbf)||!seconds(p.exp)||p.exp<=p.iat||p.nbf>=p.exp||p.iat*1000>now?"TIMESTAMP_INVALID"
        :p.v!==2?"VERSION_INVALID"
        :config.audience.kind==="clerk_default_no_audience"&&p.aud!==undefined?"AUDIENCE_UNEXPECTED"
        :typeof p.azp!=="string"||!config.authorizedParties.includes(p.azp)?"AUTHORIZED_PARTY_INVALID"
        :Object.hasOwn(p,"jti")&&(typeof p.jti!=="string"||!p.jti)?"TOKEN_ID_INVALID"
        :p.sts!==undefined&&p.sts!=="active"?"SESSION_STATUS_INVALID":"ACTOR_UNEXPECTED";
      verificationDenied(reason);fail("CLERK_TOKEN_INVALID",401);
    }
    let tokenId:string,tokenIdKind:"signed_input_sha256_v1"|undefined;
    if(Object.hasOwn(p,"jti"))tokenId=p.jti as string;
    else{
      // Only after signature AND every v2/issuer/party/time/status check passed.
      // Hash signed header.payload, not the malleable signature encoding. A
      // different valid encoding of the same signature keeps one replay key.
      const signingInput=token.slice(0,token.lastIndexOf("."));
      try{
        const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(signingInput));
        tokenId=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("");
      }catch{fail("SERVICE_UNAVAILABLE",503);}
      tokenIdKind="signed_input_sha256_v1";
    }
    // Preserve case-sensitive external IDs. Token/organization roles and emails
    // are deliberately absent from the verified proof and cannot grant authority.
    const proof:ClerkProof=Object.freeze({kind:"clerk_verified",issuer:config.issuer,userId:p.sub,sessionId:p.sid,
      notBefore:Math.max(p.iat,p.nbf)*1000,expiresAt:p.exp*1000,authorizedParty:p.azp,tokenId,...(tokenIdKind?{tokenIdKind}:{})});
    if(tokenIdKind){
      const afterHash=config.now();if(!Number.isSafeInteger(afterHash)||afterHash<now)fail("SERVICE_UNAVAILABLE",503);
      checkClerkProof(proof,afterHash);
    }
    return proof;
  };
}
async function readLiveClerk<T>(identity:ClerkIdentity,now:number,read:ClerkLiveness,
  project:(live:Awaited<ReturnType<ClerkLiveness>>)=>T):Promise<T>{
  if(!origin(identity.issuer)||!user(identity.userId)||!session(identity.sessionId))fail("CLERK_TOKEN_INVALID",401);
  if(!Number.isSafeInteger(now)||now<0)fail("SERVICE_UNAVAILABLE",503);
  if(typeof read!=="function")fail("SERVICE_UNAVAILABLE",503);
  let live;try{live=await read({issuer:identity.issuer,userId:identity.userId,sessionId:identity.sessionId},now);}catch{fail("SERVICE_UNAVAILABLE",503);}
  if(!live||live.issuer!==identity.issuer||live.userId!==identity.userId||live.sessionId!==identity.sessionId||
      live.status!=="active"||live.accountEnabled!==true||!Number.isSafeInteger(live.expiresAt)||live.expiresAt<=now)
    fail("CLERK_SESSION_REVOKED",401);
  // Copy the requested projection in this checked frame, without another await
  // over a mutable provider model. Common authority never reads display fields.
  return project(live);
}
// Creation-only projection. Common login/session/profile authority must not
// depend on optional provider display data for an existing platform mapping.
export async function requireLiveClerkProfile(identity:ClerkIdentity,now:number,read:ClerkLiveness):Promise<ClerkDisplayNames&{expiresAt:number}>{
  return readLiveClerk(identity,now,read,live=>Object.freeze({...clerkDisplayNames(live),expiresAt:live.expiresAt}));
}
export async function requireLiveClerk(identity:ClerkIdentity,now:number,read:ClerkLiveness):Promise<number>{
  return readLiveClerk(identity,now,read,live=>live.expiresAt);
}
