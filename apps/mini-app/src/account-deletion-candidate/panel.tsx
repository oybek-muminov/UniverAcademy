import {useSyncExternalStore} from 'react';
import type {DeletionController} from './controller.ts';

/** Auth host binds real verified identity and the reviewed API port. */
export function AccountDeletionPanel({controller,hideRequestButton=false}: {controller: DeletionController;hideRequestButton?:boolean}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  if (state.phase === 'disabled' || (hideRequestButton && state.phase === 'idle')) return null;
  const confirming = state.phase === 'confirming';
  return <section aria-label="Hisobni o‘chirish">
    <h2>Hisobni o‘chirish</h2>
    {state.message && <p role="status">{state.message}</p>}
    {!hideRequestButton && ['idle', 'rejected'].includes(state.phase) && <button onClick={() => controller.request()}>Hisobni o‘chirish</button>}
    {confirming && <div role="alertdialog" aria-label="Hisobni o‘chirishni tasdiqlang">
      <p>Hisobingiz va unga bog‘liq shaxsiy natijalar o‘chiriladi. Buni qaytarib bo‘lmaydi. Telegram bog‘lanishi ajratiladi; keyin yangi hisob ochishingiz mumkin.</p>
      <button onClick={() => controller.cancel()}>Bekor qilish</button>
      <button onClick={() => void controller.confirm('delete-account-v1')}>Tasdiqlayman, hisobimni o‘chirish</button>
    </div>}
    {state.phase === 'verifying' && <><p>Hisob egasini qayta tasdiqlang.</p><button onClick={() => controller.cancel()}>Bekor qilish</button></>}
    {state.phase === 'submitting' && <p role="status">So‘rov yuborilmoqda…</p>}
    {['pending', 'status_unavailable'].includes(state.phase) && <button onClick={() => void controller.refresh()}>Holatni qayta tekshirish</button>}
  </section>;
}
