import {useState,useSyncExternalStore} from 'react';
import {matchesCabinetConfirmation} from './confirmation.ts';
import type {DeletionController} from './controller.ts';

/** Auth host binds real verified identity and the reviewed API port. */
export function AccountDeletionPanel({controller,hideRequestButton=false,cabinetDisplayId}: {controller: DeletionController;hideRequestButton?:boolean;cabinetDisplayId?:string}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  if (state.phase === 'disabled' || (hideRequestButton && state.phase === 'idle')) return null;
  const confirming = state.phase === 'confirming';
  return <section aria-label="Hisobni o‘chirish">
    <h2>Hisobni o‘chirish</h2>
    {state.message && <p role="status">{state.message}</p>}
    {!hideRequestButton && ['idle', 'rejected'].includes(state.phase) && <button onClick={() => controller.request()}>Hisobni o‘chirish</button>}
    {confirming && <ConfirmDeletion key={cabinetDisplayId} controller={controller} cabinetDisplayId={cabinetDisplayId}/>}
    {state.phase === 'verifying' && <><p>Hisob egasini qayta tasdiqlang.</p><button onClick={() => controller.cancel()}>Bekor qilish</button></>}
    {state.phase === 'submitting' && <p role="status">So‘rov yuborilmoqda…</p>}
    {['pending', 'status_unavailable'].includes(state.phase) && <button onClick={() => void controller.refresh()}>Holatni qayta tekshirish</button>}
  </section>;
}

function ConfirmDeletion({controller,cabinetDisplayId}:{controller:DeletionController;cabinetDisplayId?:string}) {
  const [entered,setEntered]=useState('');
  const validId=typeof cabinetDisplayId==='string'&&/^[0-9]{10}$/.test(cabinetDisplayId);
  const matches=matchesCabinetConfirmation(cabinetDisplayId,entered);
  return <form className="deletion-confirmation" role="alertdialog" aria-labelledby="delete-confirm-title" aria-describedby="delete-confirm-warning" onSubmit={event=>{
    event.preventDefault();
    if(matchesCabinetConfirmation(cabinetDisplayId,entered))void controller.confirm('delete-account-v1');
  }}>
    <h2 id="delete-confirm-title">Hisobni o‘chirishni tasdiqlang</h2>
    <p id="delete-confirm-warning">Hisobingiz va unga bog‘liq shaxsiy natijalar o‘chiriladi. Buni qaytarib bo‘lmaydi. Telegram bog‘lanishi ajratiladi; keyin yangi hisob ochishingiz mumkin.</p>
    {validId ? <>
      <p>UniverAcademy ID: <strong>{cabinetDisplayId}</strong></p>
      <label htmlFor="delete-cabinet-id">Tasdiqlash uchun 10 xonali UniverAcademy ID raqamingizni kiriting</label>
      <input id="delete-cabinet-id" value={entered} onChange={event=>setEntered(event.target.value)} inputMode="numeric" autoComplete="off" pattern="[0-9]{10}" maxLength={10} required aria-describedby="delete-id-help"/>
      <small id="delete-id-help">Bu parol emas. Keyin hisob egasini Clerk orqali qayta tasdiqlaysiz.</small>
    </> : <p role="alert">UniverAcademy ID olinmadi. O‘chirishni davom ettirib bo‘lmaydi. Kabinetni qayta oching.</p>}
    <div className="account-action-row">
      <button type="button" className="secondary" onClick={()=>controller.cancel()}>Bekor qilish</button>
      <button type="submit" className="danger-button" disabled={!matches}>Tasdiqlayman, hisobimni o‘chirish</button>
    </div>
  </form>;
}
