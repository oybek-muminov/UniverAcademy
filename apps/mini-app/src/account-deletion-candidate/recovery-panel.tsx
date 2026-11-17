import {useSyncExternalStore} from 'react';
import type {createPublicRecovery} from './recovery.ts';
/** Mount on a PUBLIC route outside session/auth gates. Controller created once by
 * route host from an explicitly selected local index ticket, never URL parameters. */
export function DeletionRecoveryPanel({controller}:{controller:ReturnType<typeof createPublicRecovery>}) {
  const state=useSyncExternalStore(controller.subscribe,controller.snapshot,controller.snapshot);
  return <section aria-label="O‘chirish natijasi">
    <h1>O‘chirish natijasini tekshirish</h1>
    <p>Bu qurilmada saqlangan so‘rov holati tekshiriladi. Hisobga kirish talab qilinmaydi.</p>
    <p>Bu boshqa foydalanuvchining so‘rovi bo‘lishi mumkin. Hisob ma’lumotlari ko‘rsatilmaydi.</p>
    <p role="status">{state.message}</p>
    {state.phase!=='completed'&&<button type="button" disabled={state.phase==='checking'} onClick={()=>void controller.refresh()}>Natijani tekshirish</button>}
  </section>;
}
