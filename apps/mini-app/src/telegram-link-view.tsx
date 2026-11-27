import type { ReactNode } from 'react';

// Presentation only. The page runs in a normal browser (Google works there); Telegram's confirmation is a separate step.
export type LinkPhase = 'disabled' | 'signin' | 'ready' | 'working' | 'done' | 'failed';
export function TelegramLinkView(props: { phase: LinkPhase; message?: string; recovery?: boolean; returnUrl: string; signIn?: ReactNode;
  onConfirm?: () => void; onRetry?: () => void; onSwitchAccount?: () => void }) {
  const { phase } = props;
  if (phase === 'disabled') return <main className="shell"><section className="card"><h1>Telegram bilan bog‘lash</h1>
    <p role="status">Bu sahifa hali yoqilmagan. Telegram botida /start bosing.</p></section></main>;
  if (phase === 'signin') return <main className="shell"><section className="card"><h1>Kabinetga kirish</h1>
    <p>{props.recovery ? 'Avval ishlatgan Google hisobingiz yoki emailingiz bilan kiring. Yangi kabinet ochilmaydi.' : 'Brauzerda Google yoki email orqali kiring. Keyin Telegram hisobingizni tasdiqlaysiz.'}</p></section>{props.signIn}</main>;
  if (phase === 'ready') return <main className="shell"><section className="card"><h1>Telegram hisobingizni tasdiqlang</h1>
    <p>Hisobingiz Telegram bilan bog‘lanadi. Telegram’da “Ruxsat berish” tugmasini bosing.</p>
    <button type="button" className="primary" onClick={props.onConfirm}>Telegram bilan tasdiqlash</button>
    <button type="button" className="text-button" onClick={props.onSwitchAccount}>Boshqa hisob bilan kirish</button></section></main>;
  if (phase === 'working') return <main className="shell"><section className="card"><h1>Tekshirilmoqda</h1><p role="status">Hisobingiz bog‘lanmoqda…</p></section></main>;
  if (phase === 'done') return <main className="shell"><section className="card"><h1>Tayyor</h1>
    <p role="status">{props.recovery ? 'Mavjud hisobingiz tasdiqlandi. Telegram’ga qayting va botda /start bosing.' : 'Hisobingiz Telegram bilan bog‘landi. Telegram’ga qayting va botda /start bosing.'}</p>
    <p><a className="primary" href={props.returnUrl}>Telegram’ga qaytish</a></p></section></main>;
  return <main className="shell"><section className="card"><h1>Bog‘lanmadi</h1>
    <p role="alert">{props.message || 'Tasdiqlash yakunlanmadi. Qaytadan urinib ko‘ring.'}</p>
    <button type="button" className="primary" onClick={props.onRetry}>Qayta urinish</button>
    {props.recovery && <button type="button" className="text-button" onClick={props.onSwitchAccount}>Avvalgi hisob bilan kirish</button>}</section></main>;
}
