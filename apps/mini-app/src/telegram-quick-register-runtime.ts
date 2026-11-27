import {StudentFlow} from './flow.ts';
import {StudentFailure} from './transport.ts';
import {isChannelRequired} from './channel-required.ts';
import type {createProductionOwnerConnection} from './production-connection.ts';
import type {TelegramRegisterResult} from './telegram-register-client.ts';

type Connection=ReturnType<typeof createProductionOwnerConnection>;
export type QuickNames={firstName:string;lastName:string};
export type QuickPhase='new'|'resuming'|'name'|'registering'|'ready'|'blocked'|'channel_required';
type State={phase:QuickPhase;notice:string;flow:StudentFlow|null};

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
  let state:State={phase:'new',notice:'',flow:null},epoch=0,disposed=false,connection:Connection|null=null,abort:AbortController|null=null,raw:string|null=null;
  const listeners=new Set<()=>void>();
  const set=(next:Partial<State>)=>{if(!disposed){state=Object.freeze({...state,...next});listeners.forEach(f=>f());}};
  const launch=()=>{const value=options.readLaunch();if(!value||(raw!==null&&value!==raw))throw Error('Launch changed');raw??=value;return value;};
  const check=(n:number)=>{if(disposed||n!==epoch)throw Error('Superseded');launch();};
  const reopen='Kabinetni Telegram botidan /start orqali qayta oching.';
  async function open(method:'telegram_resume'|'telegram_atomic',proof:string,n:number,names?:QuickNames){
    abort=new AbortController();connection=options.connect(method,abort.signal,launch());
    const target=connection;
    const person=await target.auth.login(proof);
    try{check(n);}catch(error){target.auth.clear();throw error;}
    if(!person||target.auth.person()!==person)throw Error('Profile mismatch');
    const flow=new StudentFlow(target.port,undefined,undefined,'clerk');await flow.enter();check(n);
    const student=flow.snapshot().student;
    if(flow.snapshot().failure||student?.person!==person)throw Error('Profile mismatch');
    // The names were just typed on our own card: finish the profile with them
    // instead of asking a second time inside the cabinet.
    if(names&&!student.registrationComplete&&!student.staffCabinet){await flow.register(names.firstName,names.lastName);check(n);}
    set({phase:'ready',flow,notice:''});
  }
  const clear=(notice=reopen)=>{epoch++;abort?.abort();connection?.auth.clear();connection=null;set({phase:'blocked',flow:null,notice});};
  const failureNotice=(error:unknown)=>{
    const code=error instanceof StudentFailure?error.code:'';
    if(code==='INIT_DATA_EXPIRED'||code==='INIT_DATA_REPLAY'||code==='INIT_DATA_INVALID')return 'Vaqt tugadi. '+reopen;
    if(code==='RATE_LIMITED')return 'Juda ko‘p urinish bo‘ldi. 10 daqiqadan keyin qayta urinib ko‘ring.';
    if(code==='VALIDATION_ERROR')return 'Ism va familiyani faqat harflar bilan yozing.';
    if(code==='IDENTITY_LINK_CONFLICT')return 'Bu Telegram hisobi bilan muammo bor. Ustozingizga murojaat qiling.';
    return 'Kabinetni tayyorlab bo‘lmadi. Internetni tekshirib, qayta urinib ko‘ring.';
  };
  const fatal=(error:unknown)=>error instanceof StudentFailure&&['INIT_DATA_EXPIRED','INIT_DATA_REPLAY','INIT_DATA_INVALID','IDENTITY_LINK_CONFLICT'].includes(error.code);
  async function resume(){
    if(disposed)return;const n=++epoch;set({phase:'resuming',notice:''});
    try{await open('telegram_resume',launch(),n);}
    catch(error){
      if(disposed||n!==epoch)return;const established=!!connection?.auth.person();connection?.auth.clear();connection=null;
      if(!established&&isChannelRequired(error))set({phase:'channel_required',notice:'',flow:null});
      else if(!established&&error instanceof StudentFailure&&error.kind==='conflict'&&error.code==='TELEGRAM_LINK_REQUIRED')set({phase:'name',notice:''});
      else clear();
    }
  }
  return {
    snapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
    resume:async()=>{if(state.phase==='new')await resume();},
    async submit(names:QuickNames){
      if(state.phase!=='name'||disposed)return; // also blocks double taps
      const firstName=names.firstName.trim().replace(/\s+/g,' '),lastName=names.lastName.trim().replace(/\s+/g,' ');
      if(!firstName||!lastName){set({notice:'Ism va familiyani kiriting.'});return;}
      const n=++epoch;set({phase:'registering',notice:''});
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
          try{await flow.enter();check(n);set({phase:'ready',flow,notice:''});return;}catch{/* fall through */}
        }
        connection?.auth.clear();connection=null;
        if(fatal(error))clear(failureNotice(error));
        else set({phase:'name',notice:failureNotice(error),flow:null});
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
