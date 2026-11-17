import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {ReactNode} from 'react';
import {useClerk,useSession,useReverification} from '@clerk/react';
import {reverificationError} from '@clerk/shared/authorization-errors';
import {createDeletionController,browserDeletionReceiptStore} from './controller.ts';
import type {DeletionPort,Scope} from './controller.ts';
import {createRecoveryIndex,withRecoveryIndex} from './recovery.ts';
import {SavedDeletionRecoveryLink} from './recovery-link.tsx';
import {AccountDeletionPanel} from './panel.tsx';
export type AccountDeletionBinding={personId:string;port:DeletionPort;isCurrent():boolean;clearMatching():void};
type Props={binding:AccountDeletionBinding|null;enabled:boolean;cabinetDisplayId?:string;children:(actions:{onDeleteAccount:()=>void;deletionBusy:boolean})=>ReactNode};
function ReadyHost({binding,enabled,scope,children,cabinetDisplayId}:{binding:AccountDeletionBinding;enabled:boolean;scope:Scope;cabinetDisplayId?:string;children:Props['children']}){
  const clerk=useClerk();const latest=useRef(clerk);latest.current=clerk;
  const currentScope=()=>{const session=latest.current.session;return binding.isCurrent()&&session?.status==='active'&&!session.currentTask?{personId:binding.personId,clerkUserId:session.user.id,clerkSessionId:session.id}:null};
  const verify=useReverification(async()=>{
    const session=latest.current.session;
    if(!session||session.user.id!==scope.clerkUserId||session.id!==scope.clerkSessionId||!binding.isCurrent())throw Error('Identity changed');
    if(!session.checkAuthorization({reverification:{level:'first_factor',afterMinutes:4}}))return reverificationError({level:'first_factor',afterMinutes:4});
    const token=await session.getToken({skipCache:true});
    if(!token||latest.current.session!==session||session.status!=='active'||session.currentTask||!binding.isCurrent())throw Error('Identity changed');
    return{token,clerkUserId:session.user.id,clerkSessionId:session.id};
  });
  const verifyRef=useRef(verify);verifyRef.current=verify;
  const [controller]=useState(()=>createDeletionController({enabled,scope,currentScope,
    reverify:async()=>{const proof=await verifyRef.current();return proof&&'token'in proof?proof:null},
    store:{
      read:()=>withRecoveryIndex(browserDeletionReceiptStore(localStorage,scope),createRecoveryIndex(localStorage)).read(),
      write:value=>withRecoveryIndex(browserDeletionReceiptStore(localStorage,scope),createRecoveryIndex(localStorage)).write(value),
      remove:(value,outcome)=>withRecoveryIndex(browserDeletionReceiptStore(localStorage,scope),createRecoveryIndex(localStorage)).remove(value,outcome),
    },port:binding.port,onCompleted:()=>{if(currentScope()?.clerkSessionId===scope.clerkSessionId){binding.clearMatching();location.assign('/account-deletion-status')}},
  }));
  useEffect(()=>()=>controller.dispose(),[controller]);
  const state=useSyncExternalStore(controller.subscribe,controller.snapshot);
  const busy=['verifying','submitting','pending','status_unavailable','completed'].includes(state.phase);
  return <>{children({onDeleteAccount:()=>controller.request(),deletionBusy:busy})}<AccountDeletionPanel controller={controller} cabinetDisplayId={cabinetDisplayId} hideRequestButton/>{['pending','status_unavailable'].includes(state.phase)?<a href="/account-deletion-status">O‘chirish natijasini alohida tekshirish</a>:<SavedDeletionRecoveryLink/>}</>;
}
export function AccountDeletionHost({binding,enabled,children,cabinetDisplayId}:Props){
  const{session}=useSession();const[notice,setNotice]=useState('');
  const scope=useMemo(()=>binding&&session?.status==='active'&&!session.currentTask?{personId:binding.personId,clerkUserId:session.user.id,clerkSessionId:session.id}:null,[binding,session?.id,session?.user.id,session?.status,session?.currentTask]);
  if(!enabled||!binding||!scope)return <>{children({onDeleteAccount:()=>setNotice(!enabled?'Hisobni o‘chirish hali yoqilmagan.':'Hisobni o‘chirish uchun Clerk hisobingizga qayta kirishingiz kerak.'),deletionBusy:false})}{notice&&<p role="status">{notice}</p>}<SavedDeletionRecoveryLink/></>;
  return <ReadyHost key={JSON.stringify(scope)} binding={binding} enabled={enabled} scope={scope} cabinetDisplayId={cabinetDisplayId}>{children}</ReadyHost>;
}
