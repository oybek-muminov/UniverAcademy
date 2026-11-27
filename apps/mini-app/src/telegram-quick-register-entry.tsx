import {AccountDeletionHost} from './account-deletion-candidate/host.tsx';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useClerk} from '@clerk/react';
import type {CommonEntryConfig} from './common-production-runtime.ts';
import {createProductionOwnerConnection} from './production-connection.ts';
import {readTelegramBridge} from './telegram-bootstrap.ts';
import {createQuickRegisterRuntime} from './telegram-quick-register-runtime.ts';
import {createTelegramRegisterClient,readTelegramNamePrefill} from './telegram-register-client.ts';
import {StudentApp} from './student-app.tsx';
import {ChannelRequiredCard} from './channel-required.tsx';

type Clerk=ReturnType<typeof useClerk>;
/** One-time ticket sign-in, invisible to the student. Any previous Clerk
 * session in this Telegram window is signed out first so the ticket account
 * is the only active one. Returns a fresh (uncached) Clerk token. */
export async function signInWithTicket(clerk:Clerk,ticket:string):Promise<string>{
  if(clerk.session)await clerk.signOut();
  const signIn=clerk.client?.signIn;
  if(!signIn)throw Error('Clerk client unavailable');
  const attempt=await signIn.create({strategy:'ticket',ticket});
  if(attempt.status!=='complete'||!attempt.createdSessionId)throw Error('Ticket sign-in incomplete');
  await clerk.setActive({session:attempt.createdSessionId});
  const session=clerk.session;
  if(!session||session.id!==attempt.createdSessionId||session.status!=='active'||session.currentTask)throw Error('Session not active');
  const token=await session.getToken({skipCache:true});
  if(!token)throw Error('No token');
  return token;
}

export function QuickTelegramEntry({config,scope}:{config:CommonEntryConfig;scope:unknown}){
  const clerk=useClerk();
  const latest=useRef({clerk,scope});latest.current={clerk,scope};
  const [prefill]=useState(()=>readTelegramNamePrefill(scope));
  const [firstName,setFirstName]=useState(prefill.firstName),[lastName,setLastName]=useState(prefill.lastName);
  const [runtime]=useState(()=>{
    const client=createTelegramRegisterClient({baseUrl:config.apiBaseUrl,transport:request=>fetch(request)});
    return createQuickRegisterRuntime({
      readLaunch:()=>{if(!config.telegramEnabled)throw Error('Telegram disabled');return readTelegramBridge(latest.current.scope)?.initData??'';},
      register:input=>client.register(input),
      signInWithTicket:ticket=>signInWithTicket(latest.current.clerk,ticket),
      connect:(loginMethod,loginSignal,atomicInitData)=>createProductionOwnerConnection({mode:'production',baseUrl:config.apiBaseUrl,contractSha256:config.contractSha256},fetch,{loginMethod,loginSignal,atomicInitData,stagingPilotEnabled:config.stagingPilotEnabled}),
    });
  });
  const state=useSyncExternalStore(runtime.subscribe,runtime.snapshot);
  useEffect(()=>{void runtime.resume();return()=>runtime.dispose();},[runtime]);
  if(state.phase==='ready'&&state.flow)return <AccountDeletionHost binding={runtime.deletionBinding()} enabled={config.deletionEnabled} cabinetDisplayId={state.flow.snapshot().student?.displayId}>{actions=><StudentApp {...actions} stagingPilot={config.stagingPilotEnabled} studentFlow={state.flow!} mode="telegram" onEnter={async()=>runtime.reset()} onLogout={()=>runtime.logout()}/>}</AccountDeletionHost>;
  if(state.phase==='channel_required')return <main className="shell"><ChannelRequiredCard/></main>;
  if(state.phase==='name'||state.phase==='registering'){
    const busy=state.phase==='registering';
    return <main className="shell"><form className="card" onSubmit={event=>{event.preventDefault();void runtime.submit({firstName,lastName});}}>
      <p className="eyebrow">UniverAcademy</p>
      <h1>Ism va familiyangiz</h1>
      <p>Kabinetingizni ochish uchun ismingizni tekshiring va «Davom etish»ni bosing.</p>
      <label htmlFor="quick-first-name">Ism</label>
      <input id="quick-first-name" value={firstName} onChange={e=>setFirstName(e.target.value)} required maxLength={64} autoComplete="given-name" placeholder="Masalan, Aziz" disabled={busy}/>
      <label htmlFor="quick-last-name">Familiya</label>
      <input id="quick-last-name" value={lastName} onChange={e=>setLastName(e.target.value)} required maxLength={64} autoComplete="family-name" placeholder="Masalan, Karimov" disabled={busy}/>
      {state.notice&&<p className="notice" role="alert">{state.notice}</p>}
      <button className="primary" type="submit" disabled={busy||!firstName.trim()||!lastName.trim()}>
        {busy?'Kabinet tayyorlanmoqda…':state.notice?'Qayta urinish':'Davom etish'}
      </button>
      {busy&&<p role="status">Kabinet tayyorlanmoqda…</p>}
    </form></main>;
  }
  return <main className="shell"><section className="card"><p className="eyebrow">UniverAcademy</p><h1>O‘quvchi kabineti</h1>
    <p role={state.phase==='blocked'?'alert':'status'}>{state.phase==='blocked'?state.notice:'Kabinet ochilmoqda…'}</p>
  </section></main>;
}
