import { useEffect, useState, useSyncExternalStore } from 'react';
import { StudentApp } from './student-app.tsx';
import { createCommonEntryDemo } from './common-entry-demo.ts';
import type { createCommonEntryPrototype } from './common-entry-prototype.ts';
import './common-entry-prototype.css';

type Runtime = ReturnType<typeof createCommonEntryPrototype>;
export function CommonEntryPreview({ runtime, httpReview = false }: { runtime: Runtime; httpReview?: boolean }) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const [email, setEmail] = useState('oquvchi@example.test');
  const [code, setCode] = useState('');
  useEffect(() => { if (state.step !== 'code') setCode(''); }, [state.step]);
  const reset = async () => { runtime.reset(); setCode(''); };
  const logout = async () => { try { await runtime.logout(); } catch { /* runtime owns sanitized status */ } };
  if (state.step === 'ready' && state.flow) return <>
    <p className="entry-demo-banner" role="status">{httpReview
      ? 'Lokal review · Sun’iy provider va RAM HTTP · PROVISIONAL / NOT ACCEPTED'
      : 'Lokal namuna · Haqiqiy Clerk/Google yoki test xizmatiga ulanmagan.'}</p>
    <StudentApp studentFlow={state.flow} mode="local_fixture" onEnter={reset} onLogout={logout} />
  </>;
  const choosing = state.step === 'choose' || state.step === 'sending';
  return <main className="shell entry-shell">
    <header className="brand"><span className="brand-mark" aria-hidden="true">U</span>
      <span>UniverAcademy<small>O‘quvchi kabineti</small></span><span className="demo-badge">Lokal prototip</span></header>
    <p className="sample-notice">Sun’iy sinov: Google ochilmaydi, email yuborilmaydi. Haqiqiy hisob ma’lumotini kiritmang.</p>
    <section className="card entry-card">
      <p className="eyebrow">Bilim sari bir qadam</p>
      <h1>{state.step === 'browser_required' ? 'Brauzerda davom etish kerak' : choosing ? 'Kabinetga kirish' : state.step === 'code' ? 'Emailni tasdiqlang' : 'Hisob ochilmoqda…'}</h1>
      {state.notice && <p className="notice" role="alert">{state.notice}</p>}
      {choosing && <>
        <p>Google yoki email bilan davom eting. Telegram shart emas.</p>
        <button type="button" className="secondary entry-google" disabled={state.busy} onClick={() => void runtime.google()}>
          <span className="entry-google-mark" aria-hidden="true">G</span>Google bilan davom etish</button>
        <div className="entry-divider"><span>yoki email orqali</span></div>
        <form onSubmit={event => { event.preventDefault(); void runtime.sendCode(email); }}>
          <label htmlFor="entry-email">Email</label><input id="entry-email" type="email" autoComplete="off" value={email}
            onChange={event => setEmail(event.target.value)} disabled={state.busy} required aria-describedby="entry-email-hint" />
          <small id="entry-email-hint">Namuna manzili: oquvchi@example.test</small>
          <button className="primary" disabled={state.busy}>{state.busy ? 'Namuna kodi tayyorlanmoqda…' : 'Kod bilan davom etish'}</button>
        </form>
        <p className="entry-optional">Telegram — ixtiyoriy</p><button className="secondary entry-telegram" disabled>Telegram bilan kirish · hali ulanmagan</button>
        <small className="entry-unlinked">Hisoblarni bog‘lash bu prototipda bajarilmaydi.</small>
      </>}
      {state.step === 'code' && <>
        <p>{state.maskedEmail} uchun namuna kodini kiriting.</p>
        <form onSubmit={event => { event.preventDefault(); const value = code; setCode(''); void runtime.verifyCode(value); }}>
          <label htmlFor="entry-code">6 xonali kod</label><input id="entry-code" className="entry-code" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value)} required aria-describedby="entry-code-hint" />
          <small id="entry-code-hint">Faqat namuna: 246810. Xat yuborilmagan.</small>
          <button className="primary">Tekshirish va kirish</button>
        </form>
        <button className="text-button" onClick={() => void runtime.resend()}>Yangi kod so‘rash</button>
        <button className="text-button" onClick={() => void reset()}>Boshqa email kiritish</button>
      </>}
      {state.step === 'browser_required' && <>
        <p>Google orqali kirish bu oynada sinalmagan. Tashqi brauzerga o‘tish va qaytish hali ulanmagan.</p>
        <button className="primary" disabled>Tashqi brauzerga o‘tish · ulanmagan</button>
        <button className="text-button" onClick={() => void reset()}>Email kodini tanlash</button>
      </>}
      {['verifying', 'authorizing'].includes(state.step) && <p role="status">{state.step === 'authorizing' ? 'Ilova ruxsati sun’iy javob bilan tekshirilmoqda…' : 'Tasdiq tekshirilmoqda…'}</p>}
      {state.busy && <button className="text-button" onClick={() => void reset()}>Bekor qilish</button>}
    </section>
    <footer><span>UniverAcademy</span><span>Har bir qadam — oldinga.</span></footer>
  </main>;
}
export function CommonEntryPrototypeApp() {
  const [runtime] = useState(() => createCommonEntryDemo());
  useEffect(() => () => runtime.dispose(), [runtime]);
  return <CommonEntryPreview runtime={runtime} />;
}
