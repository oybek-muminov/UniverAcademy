import { useEffect, useState, useSyncExternalStore } from 'react';
import type { createSignInController } from './sign-in-controller.ts';
import { StudentApp } from './student-app.tsx';

type Runtime = ReturnType<typeof createSignInController>;
export function CommonSignInView({ runtime, canContinue, telegramUrl }: {
  runtime: Runtime; canContinue: boolean; telegramUrl?: '/telegram' | 'https://t.me/univeracademybot';
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const [email, setEmail] = useState(''), [code, setCode] = useState('');
  useEffect(() => { if (state.step !== 'code') setCode(''); }, [state.step]);
  const reset = async () => { runtime.reset(); setCode(''); };
  const logout = async () => { try { await runtime.logout(); } catch { /* sanitized runtime notice */ } };
  if (state.step === 'ready' && state.flow)
    return <StudentApp studentFlow={state.flow} mode="telegram" onEnter={reset} onLogout={logout} />;
  const choosing = state.step === 'choose' || state.step === 'sending';
  return <main className="shell common-entry">
    <header className="brand"><span className="brand-mark" aria-hidden="true">U</span><span>UniverAcademy<small>O‘quvchi kabineti</small></span></header>
    <section className="card"><h1>{state.step === 'code' ? 'Emailni tasdiqlang'
      : state.step === 'browser_required' ? 'Brauzerda davom etish kerak' : 'Kabinetga kirish'}</h1>
      {state.notice && <p className="notice" role="alert">{state.notice}</p>}
      {choosing && <>
        <p>Google yoki email orqali kiring. Telegram ixtiyoriy.</p>
        {canContinue && <button className="primary" disabled={state.busy} onClick={() => void runtime.continueSession()}>Tasdiqlangan hisob bilan davom etish</button>}
        <button className="secondary" disabled={state.busy} onClick={() => void runtime.google()}>Google bilan davom etish</button>
        <form onSubmit={event => { event.preventDefault(); void runtime.sendCode(email); }}>
          <label htmlFor="sign-in-email">Email</label><input id="sign-in-email" type="email" autoComplete="email" required value={email}
            disabled={state.busy} onChange={event => setEmail(event.target.value)} />
          <button className="primary" disabled={state.busy}>Tasdiqlash kodini yuborish</button>
        </form>
        {telegramUrl && <p><a href={telegramUrl}>Telegram orqali kirish — ixtiyoriy</a></p>}
        <small>Hisoblarni bog‘lash hozircha mavjud emas.</small>
      </>}
      {state.step === 'code' && <>
        <p>{state.maskedEmail} manziliga yuborilgan kodni kiriting.</p>
        <form onSubmit={event => { event.preventDefault(); const value = code; setCode(''); void runtime.verifyCode(value); }}>
          <label htmlFor="sign-in-code">6 xonali kod</label><input id="sign-in-code" inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} />
          <button className="primary">Tekshirish va kirish</button>
        </form>
        <button className="text-button" onClick={() => void runtime.resend()}>Kodni qayta yuborish</button>
        <button className="text-button" onClick={() => void reset()}>Boshqa email kiritish</button>
      </>}
      {state.step === 'browser_required' && <>
        <p>Bu Telegram oynasida Google bilan kirish va tashqi brauzerdan qaytish hali ulanmagan. Email usulini tanlang.</p>
        <button className="secondary" onClick={() => void reset()}>Email orqali kirish</button>
      </>}
      {state.busy && <><p role="status">{state.step === 'authorizing' ? 'Kabinetga kirish tekshirilmoqda…' : 'Tasdiq kutilmoqda…'}</p>
        <button className="text-button" onClick={() => void reset()}>Bekor qilish</button></>}
      <div id="clerk-captcha" />
    </section>
  </main>;
}
