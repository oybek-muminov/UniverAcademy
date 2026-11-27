import {StudentFlow} from './flow.ts';
import {StudentFailure} from './transport.ts';
import {isChannelRequired} from './channel-required.ts';
import {StudentClientProtocolError} from './owner-client/student-client.ts';
import type {createProductionOwnerConnection} from './production-connection.ts';
import type {TelegramRegisterResult} from './telegram-register-client.ts';

type Connection=ReturnType<typeof createProductionOwnerConnection>;
export type QuickNames={firstName:string;lastName:string};
export type QuickPhase='new'|'resuming'|'name'|'registering'|'ready'|'blocked'|'channel_required';
/** errorCode: short code shown in small grey text under a failure, so the next
 * report says exactly which step failed. Empty when there is nothing to report. */
type State={phase:QuickPhase;notice:string;errorCode:string;flow:StudentFlow|null};

const safeCode=(value:unknown)=>typeof value==='string'&&value?value.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'').toUpperCase().slice(0,64):'';
/** Only a request that never got an answer is a connection problem. A server
 * answer (401, 409, 503 ...) or a broken step in the app is not "check the internet". */
export function describeFailure(error:unknown):{code:string;network:boolean}{
  if(error instanceof StudentFailure)
    return{code:safeCode(error.code)||'UNKNOWN',network:error.kind==='offline'||(error.kind==='temporary'&&error.code==='CLIENT_REQUEST_UNCONFIRMED')};
  if(error instanceof StudentClientProtocolError){const code=safeCode(error.message)||'PROTOCOL';return{code,network:code==='CLIENT_REQUEST_UNCONFIRMED'};}
  const tagged=error&&typeof error==='object'?(error as {code?:unknown}).code:undefined;
  if(typeof tagged==='string'&&tagged)return{code:safeCode(tagged)||'UNKNOWN',network:tagged==='network_error'||tagged==='NETWORK_ERROR'};
  if(error instanceof TypeError&&/fetch|network|load failed/i.test(error.message))return{code:'NETWORK_ERROR',network:true};
  return{code:error instanceof Error&&error.message?safeCode(error.message)||'UNKNOWN':'UNKNOWN',network:false};
}

/** New student, Telegram only: name card -> server-made Clerk account ->
 * invisible ticket sign-in -> existing atomic entry. There is deliberately no
 * route from here to a Clerk/Google window: every failure ends on the name card
 * with "Qayta urinish", or on a "reopen from the bot" notice. */
export function createQuickRegisterRuntime(options:{
  readLaunch():string;
  register(input:{init_data:string;first_name:string;last_name:string}):Promise<TelegramRegisterResult>;
  /** Signs in with the one-time ticket and returns a fresh Clerk token. */
  signInWithTicket(ticket:string):Promise<string>;
  connect(method:'telegram_resume'|'telegram_atomic',signal:AbortSignal,raw:string):Connection;
}){
  let state:State={phase:'new',notice:'',errorCode:'',flow:null},epoch=0,disposed=false,connection:Connection|null=null,abort:AbortController|null=null,raw:string|null=null;
  const listeners=new Set<()=>void>();
  const set=(next:Partial<State>)=>{if(!disposed){state=Object.freeze({...state,...next});listeners.forEach(f=>f());}};
  const coded=(code:string)=>Object.assign(Error(code),{code});
  const launch=()=>{const value=options.readLaunch();if(!value||(raw!==null&&value!==raw))throw coded('LAUNCH_CHANGED');raw??=value;return value;};
  const check=(n:number)=>{if(disposed||n!==epoch)throw coded('SUPERSEDED');launch();};
  const reopen='Kabinetni Telegram botidan /start orqali qayta oching.';
  async function open(method:'telegram_resume'|'telegram_atomic',proof:string,n:number,names?:QuickNames){
    abort=new AbortController();connection=options.connect(method,abort.signal,launch());
    const target=connection;
    const person=await target.auth.login(proof);
    try{check(n);}catch(error){target.auth.clear();throw error;}
    if(!person||target.auth.person()!==person)throw coded('PROFILE_MISMATCH');
    const flow=new StudentFlow(target.port,undefined,undefined,'clerk');await flow.enter();check(n);
    const student=flow.snapshot().student;
    const failure=flow.snapshot().failure;
    if(failure)throw failure instanceof StudentFailure?failure:coded('PROFILE_READ_FAILED');
    if(student?.person!==person)throw coded('PROFILE_MISMATCH');
    // The names were just typed on our own card: finish the profile with them
    // instead of asking a second time inside the cabinet.
    if(names&&!student.registrationComplete&&!student.staffCabinet){await flow.register(names.firstName,names.lastName);check(n);}
    set({phase:'ready',flow,notice:'',errorCode:''});
  }
  const clear=(notice=reopen,errorCode='')=>{epoch++;abort?.abort();connection?.auth.clear();connection=null;set({phase:'blocked',flow:null,notice,errorCode});};
  const failureNotice=(error:unknown)=>{
    const {code,network}=describeFailure(error);
    if(code==='INIT_DATA_EXPIRED'||code==='INIT_DATA_REPLAY'||code==='INIT_DATA_INVALID')return 'Vaqt tugadi. '+reopen;
    if(code==='RATE_LIMITED')return 'Juda ko‘p urinish bo‘ldi. 10 daqiqadan keyin qayta urinib ko‘ring.';
    if(code==='VALIDATION_ERROR')return 'Ism va familiyani faqat harflar bilan yozing.';
    if(code==='IDENTITY_LINK_CONFLICT')return 'Bu Telegram hisobi bilan muammo bor. Ustozingizga murojaat qiling.';
    if(network)return 'Internet aloqasi uzildi. Internetni tekshirib, qayta urinib ko‘ring.';
    return 'Kabinetni ochishda xatolik yuz berdi. Qayta urinib ko‘ring. Takrorlansa, pastdagi kodni ustozingizga yuboring.';
  };
  const fatal=(error:unknown)=>error instanceof StudentFailure&&['INIT_DATA_EXPIRED','INIT_DATA_REPLAY','INIT_DATA_INVALID','IDENTITY_LINK_CONFLICT'].includes(error.code);
  async function resume(){
    if(disposed)return;const n=++epoch;set({phase:'resuming',notice:'',errorCode:''});
    try{await open('telegram_resume',launch(),n);}
    catch(error){
      if(disposed||n!==epoch)return;const established=!!connection?.auth.person();connection?.auth.clear();connection=null;
      if(!established&&isChannelRequired(error))set({phase:'channel_required',notice:'',errorCode:'',flow:null});
      else if(!established&&error instanceof StudentFailure&&error.kind==='conflict'&&error.code==='TELEGRAM_LINK_REQUIRED')set({phase:'name',notice:'',errorCode:''});
      else clear(reopen,describeFailure(error).code);
    }
  }
  return {
    snapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
    resume:async()=>{if(state.phase==='new')await resume();},
    async submit(names:QuickNames){
      if(state.phase!=='name'||disposed)return; // also blocks double taps
      const firstName=names.firstName.trim().replace(/\s+/g,' '),lastName=names.lastName.trim().replace(/\s+/g,' ');
      if(!firstName||!lastName){set({notice:'Ism va familiyani kiriting.',errorCode:''});return;}
      const n=++epoch;set({phase:'registering',notice:'',errorCode:''});
      try{
        const result=await options.register({init_data:launch(),first_name:firstName,last_name:lastName});check(n);
        if(result.status==='already_registered'){epoch++;state={...state,phase:'new'};await resume();return;}
        const token=await options.signInWithTicket(result.ticket);check(n);
        await open('telegram_atomic',token,n,{firstName,lastName});
      }catch(error){
        if(disposed||n!==epoch)return;
        const established=!!connection?.auth.person();
        if(established){
          // Cabinet exists; only the profile step failed. Keep it open and let the cabinet ask.
          const flow=new StudentFlow(connection!.port,undefined,undefined,'clerk');
          try{await flow.enter();check(n);if(!flow.snapshot().failure){set({phase:'ready',flow,notice:'',errorCode:''});return;}}catch{/* fall through */}
        }
        connection?.auth.clear();connection=null;
        const errorCode=describeFailure(error).code;
        if(fatal(error))clear(failureNotice(error),errorCode);
        else set({phase:'name',notice:failureNotice(error),errorCode,flow:null});
      }
    },
    deletionBinding(){
      const target=connection,personId=target?.auth.person();
      if(!target||!personId||state.phase!=='ready')return null;
      return{personId,port:target.auth.createDeletionPort(personId),isCurrent:()=>connection===target&&target.auth.person()===personId,
        clearMatching:()=>{if(connection===target&&target.auth.person()===personId){target.auth.clearMatching(personId);clear();}}};
    },
    reset(){clear();},
    async logout(){const pending=connection?.auth.logout();clear();try{await pending;}catch{/* cannot claim remote acknowledgement */}},
    dispose(){clear();disposed=true;listeners.clear();},
  };
}
