import {AccountDeletionHost} from './account-deletion-candidate/host.tsx';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {SignIn,useClerk,useSession,useReverification} from '@clerk/react';
import {reverificationError} from '@clerk/shared/authorization-errors';
import type {CommonEntryConfig} from './common-production-runtime.ts';
import {createProductionOwnerConnection} from './production-connection.ts';
import {readTelegramBridge} from './telegram-bootstrap.ts';
import {createAtomicTelegramRuntime} from './telegram-atomic-runtime.ts';
import {StudentApp} from './student-app.tsx';
const policy={level:'first_factor',afterMinutes:4} as const;
export function AtomicTelegramEntry({config,scope}:{config:CommonEntryConfig;scope:unknown}){
  const clerk=useClerk(),{session}=useSession();
  const latest=useRef({clerk,scope});latest.current={clerk,scope};
  // Official SDK hook only wraps a proof-producing callback. Atomic POST is outside
  // the hook, preventing SDK automatic retries from replaying the mutation.
  const verify=useReverification(async(expected:{userId:string;sessionId:string})=>{
    const current=latest.current.clerk.session;
    const same=()=>latest.current.clerk.session===current&&current?.status==='active'&&!current.currentTask&&current.id===expected.sessionId&&current.user.id===expected.userId;
    if(!same()||!current)throw Error('Account changed');
    if(!current.checkAuthorization({reverification:policy}))return reverificationError(policy);
    const token=await current.getToken({skipCache:true});
    if(!same()||!token)throw Error('Account changed');
    return{token,userId:current.user.id,sessionId:current.id};
  });
  const verifyRef=useRef(verify);verifyRef.current=verify;
  const [runtime]=useState(()=>createAtomicTelegramRuntime({
    readLaunch:()=>{if(!config.telegramEnabled)throw Error('Telegram disabled');return readTelegramBridge(latest.current.scope)?.initData??''},
    identity:()=>{const s=latest.current.clerk.session;return s?.status==='active'&&!s.currentTask?{userId:s.user.id,sessionId:s.id}:null},
    reverify:async id=>{const proof=await verifyRef.current(id);return proof&&'token'in proof?proof:null},
    connect:(loginMethod,loginSignal,atomicInitData)=>createProductionOwnerConnection({mode:'production',baseUrl:config.apiBaseUrl,contractSha256:config.contractSha256},fetch,{loginMethod,loginSignal,atomicInitData,stagingPilotEnabled:config.stagingPilotEnabled}),
  }));
  const state=useSyncExternalStore(runtime.subscribe,runtime.snapshot);
  useEffect(()=>{void runtime.resume();return()=>runtime.dispose()},[runtime]);
  useEffect(()=>runtime.observe(),[runtime,session?.id,session?.status,session?.currentTask,session?.user.id]);
  const active=session?.status==='active'&&!session.currentTask;
  if(state.phase==='ready'&&state.flow)return <AccountDeletionHost binding={runtime.deletionBinding()} enabled={config.deletionEnabled} cabinetDisplayId={state.flow?.snapshot().student?.displayId}>{actions=><StudentApp {...actions} stagingPilot={config.stagingPilotEnabled} studentFlow={state.flow!} mode="telegram" onEnter={async()=>runtime.cancel()} onLogout={()=>runtime.logout()}/>}</AccountDeletionHost>;
  return <main className="shell"><section className="card"><h1>Kabinetga kirish</h1>
    {state.notice&&<p role="status">{state.notice}</p>}
    {state.phase==='choose'?(active?<>
      <p>Tanlangan hisob: <strong>{session.user.primaryEmailAddress?.emailAddress||session.user.fullName||'Clerk hisobi'}</strong></p>
      <p>Shu hisobni hozirgi Telegram hisobingiz bilan bog‘lashni tasdiqlang.</p>
      <button type="button" onClick={()=>void runtime.confirm('link-telegram-account-v1')}>Shu hisob bilan davom etish</button>
      <button type="button" onClick={()=>{const selected=clerk.session;if(selected)void clerk.signOut({sessionId:selected.id}).catch(()=>runtime.cancel())}}>Boshqa hisobni tanlash</button>
    </>:<SignIn routing="hash" withSignUp oauthFlow="redirect" forceRedirectUrl={config.callbackUrl} signUpForceRedirectUrl={config.callbackUrl}/> ):<>
      <p role="status">{state.phase==='blocked'?'Telegram botida /start orqali yangidan oching.':'Kirish tekshirilmoqda…'}</p>
      {state.phase!=='blocked'&&<button type="button" onClick={()=>runtime.cancel()}>Bekor qilish</button>}
    </>}
  </section></main>;
}
