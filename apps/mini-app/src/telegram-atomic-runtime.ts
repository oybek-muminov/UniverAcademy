import {StudentFlow} from './flow.ts';
import {StudentFailure} from './transport.ts';
import {isChannelRequired} from './channel-required.ts';
import type {createProductionOwnerConnection} from './production-connection.ts';
type Identity={userId:string;sessionId:string};
type Connection=ReturnType<typeof createProductionOwnerConnection>;
export function createAtomicTelegramRuntime(options:{
  readLaunch():string;
  identity():Identity|null;
  reverify(identity:Identity):Promise<{token:string;userId:string;sessionId:string}|null>;
  connect(method:'telegram_resume'|'telegram_atomic',signal:AbortSignal,raw:string):Connection;
}){
  type State={phase:'new'|'resuming'|'choose'|'verifying'|'linking'|'ready'|'blocked'|'channel_required';notice:string;flow:StudentFlow|null};
  let state:State={phase:'new',notice:'',flow:null},epoch=0,disposed=false,connection:Connection|null=null,abort:AbortController|null=null;
  let raw:string|null=null,anchor:Identity|null=null,pendingIdentity:Identity|null=null;
  const listeners=new Set<()=>void>();
  const set=(next:Partial<State>)=>{if(!disposed){state=Object.freeze({...state,...next});listeners.forEach(f=>f())}};
  const same=(a:Identity|null,b:Identity)=>a?.userId===b.userId&&a.sessionId===b.sessionId;
  const launch=()=>{const value=options.readLaunch();if(!value||raw!==null&&value!==raw)throw Error('Launch changed');raw??=value;return value};
  const check=(n:number,id?:Identity)=>{if(disposed||n!==epoch)throw Error('Superseded');launch();if(id&&!same(options.identity(),id))throw Error('Account changed')};
  async function open(method:'telegram_resume'|'telegram_atomic',proof:string,n:number,id?:Identity){
    abort=new AbortController();connection=options.connect(method,abort.signal,launch());
    const target=connection;
    const person=await target.auth.login(proof);
    try{check(n,id)}catch(error){target.auth.clear();throw error}
    if(!person||target.auth.person()!==person)throw Error('Profile mismatch');
    const flow=new StudentFlow(target.port,undefined,undefined,'clerk');await flow.enter();check(n,id);
    if(flow.snapshot().failure||flow.snapshot().student?.person!==person)throw Error('Profile mismatch');
    pendingIdentity=null;anchor=id??null;set({phase:'ready',flow,notice:''});
  }
  const clear=()=>{epoch++;abort?.abort();connection?.auth.clear();connection=null;anchor=null;pendingIdentity=null;set({phase:'blocked',flow:null,notice:'Telegram botida /start orqali yangidan oching.'})};
  return{
    deletionBinding(){
      const target=connection,personId=target?.auth.person();
      if(!target||!personId||state.phase!=='ready')return null;
      return{personId,port:target.auth.createDeletionPort(personId),isCurrent:()=>connection===target&&target.auth.person()===personId,
        clearMatching:()=>{if(connection===target&&target.auth.person()===personId){target.auth.clearMatching(personId);clear()}}};
    },
    snapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn)}},
    async resume(){if(state.phase!=='new'||disposed)return;const n=++epoch;set({phase:'resuming'});
      try{await open('telegram_resume',launch(),n)}catch(error){if(disposed||n!==epoch)return;const established=!!connection?.auth.person();connection?.auth.clear();connection=null;
        if(!established&&isChannelRequired(error))set({phase:'channel_required',notice:'',flow:null});
        else if(!established&&error instanceof StudentFailure&&((error.kind==='conflict'&&error.code==='TELEGRAM_LINK_REQUIRED')||(error.kind==='auth'&&error.code==='CLERK_SESSION_REVOKED')))set({phase:'choose',notice:''});
        else clear();
      }
    },
    async confirm(confirmation:string){if(state.phase!=='choose'||confirmation!=='link-telegram-account-v1'||disposed)return;
      const id=options.identity();if(!id)return;let submitted=false;const captured={...id},n=++epoch;pendingIdentity=captured;set({phase:'verifying',notice:''});
      try{
        check(n,captured);const proof=await options.reverify(captured);check(n,captured);
        if(!proof){pendingIdentity=null;set({phase:'choose'});return}
        if(!same(proof,captured)||!proof.token)throw Error('Account changed');
        submitted=true;set({phase:'linking'});await open('telegram_atomic',proof.token,n,captured);
      }catch{if(!disposed&&n===epoch){if(!submitted){pendingIdentity=null;set({phase:'choose',notice:'Tasdiqlash yakunlanmadi. Hisobni tekshirib qayta urinishingiz mumkin.'});}else clear()}}
    },
    cancel(){if(state.phase==='verifying'){epoch++;pendingIdentity=null;set({phase:'choose',notice:'Tasdiqlash bekor qilindi.'})}else clear()},
    observe(){
      if(pendingIdentity&&!same(options.identity(),pendingIdentity)){
        if(state.phase==='verifying'){
          epoch++;pendingIdentity=null;abort?.abort();set({phase:'choose',notice:'Hisob o‘zgardi. Yangi hisobni alohida tasdiqlang.'});
        }else{
          clear();set({notice:'Hisob o‘zgardi. Yuborilgan so‘rov natijasi noaniq; bu uni bekor qilganini bildirmaydi. Telegram botida /start orqali yangidan oching.'});
        }
      }else if(anchor&&!same(options.identity(),anchor))clear();
    },
    async logout(){const pending=connection?.auth.logout();clear();try{await pending}catch{/* cannot claim remote acknowledgement */}},
    dispose(){clear();disposed=true;listeners.clear()},
  };
}
