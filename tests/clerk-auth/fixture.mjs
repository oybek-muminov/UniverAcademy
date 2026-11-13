import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from "jose";
import {ApiFault} from "../../supabase/functions/univeracademy-api/fault.ts";
import {createClerkCandidateHandler} from "../../supabase/functions/univeracademy-api/clerk-http.ts";
import {clerkIdentityKey,clerkSessionKey} from "../../supabase/functions/univeracademy-api/clerk-auth.ts";
import {initialStaffState,staffIds,validate} from "../backend/staff-fixture.ts";
import {clock,botKey,testPolicy,testNumbers,ids} from "../backend/http-fixture.ts";
import {createLocalStudentClient,STUDENT_CONTRACT_SHA256} from "../../packages/api-client/student-client.ts";

// Contract harness: one global queue and whole-state clone, not PostgreSQL/RLS.
export class ClerkMemory {
  time=clock;events=[];beforeWork;failCommit;tail=Promise.resolve();
  constructor(state,liveClock){this.state=state;this.liveClock=liveClock;this.time=liveClock?liveClock():clock;}
  async transaction(work){
    const prior=this.tail;let release;this.tail=new Promise(r=>{release=r;});await prior;
    this.events.push("lock");
    try{
      if(this.beforeWork){const hook=this.beforeWork;this.beforeWork=null;await hook();}
      const state=structuredClone(this.state),now=this.liveClock?this.liveClock():this.time;this.time=now;
      const result=await work({state,now:()=>now});
      const failure=this.failCommit;this.failCommit=null;
      if(failure==="before")throw new ApiFault("SERVICE_UNAVAILABLE",503);
      this.state=state;this.events.push("commit");
      if(failure==="after")throw new ApiFault("SERVICE_UNAVAILABLE",503);
      return result;
    }finally{this.events.push("release");release();}
  }
}
const keys=generateKeyPair("RS256",{modulusLength:2048});
export const issuer="https://clerk.example.com",uiOrigin="https://student.example.com";
export const users={student:"user_StudentCaseA1",other:"user_StudentCaseB2",admin:"user_AdminCaseC3",teacher:"user_TeacherCaseD4",owner:"user_OwnerCaseE5"};
export const sids={first:"sess_StudentFirstA1",second:"sess_StudentSecondB2",admin:"sess_AdminCaseC3",teacher:"sess_TeacherCaseD4",owner:"sess_OwnerCaseE5"};
export async function clerkFixture({fresh=false,legacyTelegram=false,now}={}){
  const domain=initialStaffState();
  if(fresh){domain.student.people={};domain.student.grants={};domain.student.families={};domain.student.access={};domain.student.refresh={};domain.student.consumedInitData={};domain.memberships={};domain.staff={};}
  const store=new ClerkMemory({domain,identities:{},familyBindings:{},studentSessions:{},consumedTokens:{}},now);
  const live=new Map(),pair=await keys,jwk=await exportJWK(pair.publicKey);jwk.kid="clerk-synthetic-rsa";
  const verifier={issuer,authorizedParties:[uiOrigin],audience:{kind:"clerk_default_no_audience"},trustedKeys:createLocalJWKSet({keys:[jwk]}),now:()=>now?now():store.time};
  const bind=(userId,personId)=>{store.state.identities[clerkIdentityKey({issuer,userId})]={personId,enabled:true};};
  const activate=(userId,sessionId)=>{live.set(sessionId,{issuer,userId,sessionId,status:"active",accountEnabled:true,expiresAt:store.time+86400000});};
  if(!fresh){
    bind(users.student,ids.person);
    for(const [role,userId]of Object.entries({admin:users.admin,teacher:users.teacher,owner:users.owner})){
      const personId=staffIds[role],record=domain.staff["synthetic-"+role];
      domain.student.people[personId]={telegramId:null,enabled:true,profile:{person_id:personId,first_name:"Synthetic",last_name:role,roles:[role],registration_complete:true,active_group_id:null,qadam_id:null}};
      domain.staff[userId]=structuredClone(record);bind(userId,personId);
    }
  }
  const seen=[];const liveness=async(id,now)=>{seen.push({...id,now});return live.get(id.sessionId);};
  const deps={mode:"local_candidate",transactions:store,verifier,liveness,sessionPolicy:testPolicy,numericPresentation:testNumbers,
    ...(legacyTelegram?{legacyTelegram:{botToken:botKey}}:{}),staff:{validate,newAssignmentId:()=>crypto.randomUUID()}};
  let handler=createClerkCandidateHandler(deps);
  const sign=async({userId=users.student,sessionId=sids.first,claims={},privateKey=pair.privateKey,algorithm="RS256",headers={}}={})=>{
    const seconds=Math.floor(store.time/1000);
    return new SignJWT({iss:issuer,sub:userId,sid:sessionId,iat:seconds-1,nbf:seconds-1,exp:seconds+60,azp:uiOrigin,jti:crypto.randomUUID(),v:2,...claims})
      .setProtectedHeader({alg:algorithm,kid:jwk.kid,...headers}).sign(privateKey);
  };
  const call=async(method,path,body,token,extraHeaders={})=>{
    const r=await handler(new Request("https://api.example.com/api/v1"+path,{method,headers:{...(token?{authorization:"Bearer "+token}:{}),...(body!==undefined?{"content-type":"application/json"}:{}),...extraHeaders},...(body!==undefined?{body:typeof body==="string"?body:JSON.stringify(body)}:{})}));
    return{status:r.status,json:await r.json()};
  };
  const exchange=async(token,body={})=>call("POST","/auth/clerk",body,token);
  const client=createLocalStudentClient({mode:"local_fixture",contractSha256:STUDENT_CONTRACT_SHA256,baseUrl:"https://local.invalid/api/v1",transport:request=>handler(request)});
  const snapshot=()=>structuredClone(store.state);
  const resetHandler=()=>{handler=createClerkCandidateHandler(deps);};
  return{store,live,verifier,deps,bind,activate,seen,sign,call,exchange,client,snapshot,resetHandler,pair,handler:request=>handler(request),
    person:()=>store.state.identities[clerkIdentityKey({issuer,userId:users.student})]?.personId,
    session:key=>store.state.studentSessions[clerkSessionKey({issuer,userId:users.student,sessionId:key})]};
}
