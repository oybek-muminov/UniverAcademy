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
const coded=(code:string)=>Object.assign(Error(code),{code});
/** Clerk's own answer becomes a short code (e.g. CLERK_FORM_IDENTIFIER_NOT_FOUND);
 * its "network_error" stays a connection problem. */
function clerkFailure(error:unknown,step:string):Error{
  const e=error as {code?:unknown;errors?:{code?:unknown}[]}|null;
  if(e&&e.code==='network_error')return coded('network_error');
  const code=Array.isArray(e?.errors)&&typeof e.errors[0]?.code==='string'?e.errors[0].code:'';
  return coded('CLERK_'+step+(code?'_'+code:''));
}
// signIn.create({strategy:'ticket'}) + setActive, deliberately not the ticket() shortcut
// (clerk/javascript#8219). Each step reports its own code on failure.
export async function signInWithTicket(clerk:Clerk,ticket:string):Promise<string>{
  try{if(clerk.session)await clerk.signOut();}catch(error){throw clerkFailure(error,'SIGN_OUT');}
  const signIn=clerk.client?.signIn;
  if(!signIn)throw coded('CLERK_NOT_READY');
  let attempt;try{attempt=await signIn.create({strategy:'ticket',ticket});}catch(error){throw clerkFailure(error,'TICKET');}
  if(attempt.status!=='complete'||!attempt.createdSessionId)throw coded('CLERK_TICKET_'+String(attempt.status??'INCOMPLETE'));
  try{await clerk.setActive({session:attempt.createdSessionId});}catch(error){throw clerkFailure(error,'SET_ACTIVE');}
  const session=clerk.session;
  if(!session||session.id!==attempt.createdSessionId||session.status!=='active'||session.currentTask)throw coded('CLERK_SESSION_NOT_ACTIVE');
  let token;try{token=await session.getToken({skipCache:true});}catch(error){throw clerkFailure(error,'TOKEN');}
  if(!token)throw coded('CLERK_NO_TOKEN');
  return token;
}
const ErrorCode=({code}:{code:string})=>code?<p className="error-code">Xato kodi: {code}</p>:null;

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
      {!busy&&<ErrorCode code={state.errorCode}/>}
    </form></main>;
  }
  return <main className="shell"><section className="card"><p className="eyebrow">UniverAcademy</p><h1>O‘quvchi kabineti</h1>
    <p role={state.phase==='blocked'?'alert':'status'}>{state.phase==='blocked'?state.notice:'Kabinet ochilmoqda…'}</p>
    {state.phase==='blocked'&&<ErrorCode code={state.errorCode}/>}
  </section></main>;
}
