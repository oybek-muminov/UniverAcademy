import {createRoot} from 'react-dom/client';
import {useEffect,useMemo,useState,useSyncExternalStore} from 'react';
import {createRecoveryIndex,createPublicRecovery,createForgetRecovery} from './recovery.ts';
import type {RecoveryIndex} from './recovery.ts';
import type {Receipt} from './controller.ts';
import {createPublicRecoveryStatus} from './recovery-status-port.ts';
import {DeletionRecoveryPanel} from './recovery-panel.tsx';

// Separate pure configuration gate avoids importing any authentication bootstrap.
export function readRecoveryOrigin(env:Readonly<Record<string,unknown>>,pageOrigin:string) {
  const origin=(value:unknown)=>{
    if(typeof value!=='string'||/[\u0000-\u0020\\]/.test(value))throw Error('Missing configuration');
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Invalid configuration');
    return u.origin;
  };
  if(origin(env.VITE_MINI_APP_ORIGIN)!==origin(pageOrigin))throw Error('Origin mismatch');
  return origin(env.VITE_API_ORIGIN);
}
function SelectedRecovery({ticket,status,index,onForgot}:{ticket:Receipt;status:ReturnType<typeof createPublicRecoveryStatus>;index:RecoveryIndex;onForgot:()=>void}){
  const controller=useMemo(()=>createPublicRecovery({ticket,status,onCompleted:value=>index.markCompleted(value)}),[ticket,status,index]);
  const forget=useMemo(()=>createForgetRecovery(ticket,index,()=>controller.snapshot().phase==='completed'),[ticket,index,controller]);
  const state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
  const [confirming,setConfirming]=useState(false),[error,setError]=useState('');
  useEffect(()=>()=>controller.dispose(),[controller]);
  return <><DeletionRecoveryPanel controller={controller}/>
    {state.phase==='completed'&&(!confirming?<button type="button" onClick={()=>{forget.request();setConfirming(true);setError('')}}>Tekshiruv yozuvini unutish</button>:
      <section role="alertdialog" aria-label="Tekshiruv yozuvini unutish">
        <p>Faqat shu qurilmadagi tekshiruv yozuvi o‘chiriladi. Hisob yoki serverdagi ma’lumotlar o‘zgarmaydi.</p>
        <button type="button" onClick={()=>{try{if(forget.confirm())onForgot()}catch{setError('Yozuvni olib tashlab bo‘lmadi. Qayta urinishingiz yoki bekor qilishingiz mumkin.')}}}>Faqat lokal yozuvni unutish</button>
        <button type="button" onClick={()=>{forget.cancel();setConfirming(false);setError('')}}>Bekor qilish</button>
        <p role="status">{error}</p>
      </section>)}
  </>;
}
function RecoveryPage({initialTickets,status,index,initialUnreadableCount=0}:{initialTickets:Receipt[];initialUnreadableCount?:number;status:ReturnType<typeof createPublicRecoveryStatus>;index:RecoveryIndex}){
  const [unreadableCount,setUnreadableCount]=useState(initialUnreadableCount);
  const [tickets,setTickets]=useState(initialTickets),[selected,setSelected]=useState<number|null>(null),[error,setError]=useState('');
  const refresh=()=>{try{const available=index.readAvailable();setTickets(available.tickets);setUnreadableCount(available.unreadableCount);setSelected(null);setError('')}catch{setError('Saqlangan ro‘yxatni qayta o‘qib bo‘lmadi. Sahifani qayta oching.')}};
  if(selected!==null)return <main className="shell"><section className="card"><SelectedRecovery ticket={tickets[selected]!} status={status} index={index} onForgot={refresh}/><p role="status">{error}</p><button type="button" onClick={()=>setSelected(null)}>Ro‘yxatga qaytish</button></section></main>;
  return <main className="shell"><section className="card"><h1>O‘chirish natijasi</h1><p>Bu qurilmada saqlangan so‘rovni tanlang. U boshqa foydalanuvchiga tegishli bo‘lishi mumkin.</p>{unreadableCount>0&&<p role="alert">Ayrim saqlangan yozuvlarni o‘qib bo‘lmadi. Ular o‘chirilmagan. Quyida o‘qiladigan so‘rovlar ko‘rsatiladi.</p>}{tickets.length===0?<p role="status">{unreadableCount>0?'O‘qiladigan so‘rov topilmadi. Bu hisob o‘chirilganini bildirmaydi.':'Bu qurilmada saqlangan so‘rov topilmadi.'}</p>:tickets.map((_,i)=><button key={i} type="button" onClick={()=>setSelected(i)}>Saqlangan so‘rov {i+1}</button>)}</section></main>;
}
export function mountDeletionRecovery(root:HTMLElement,options:{env:Readonly<Record<string,unknown>>;pageOrigin:string;storage:()=>Storage}){
  const view=createRoot(root);
  try{
    const status=createPublicRecoveryStatus({apiOrigin:readRecoveryOrigin(options.env,options.pageOrigin)});
    const index=createRecoveryIndex(options.storage());
    const available=index.readAvailable();
    view.render(<RecoveryPage initialTickets={available.tickets} initialUnreadableCount={available.unreadableCount} status={status} index={index}/>);
  }catch{
    view.render(<main className="shell"><section className="card"><h1>O‘chirish natijasi</h1><p role="status">Saqlangan holatni hozir tekshirib bo‘lmadi. Bu hisob o‘chirilganini bildirmaydi.</p></section></main>);
  }
}
