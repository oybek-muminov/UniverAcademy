// Existing-account entrance for the separate Ega (Owner) origin. No sign-up: only an already registered Clerk
// email can receive a code, and the server decides what that account may see.
import { createElement as h, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider, ClerkFailed, ClerkLoaded, ClerkLoading, useClerk, useSession, useSignIn } from '@clerk/react';

import '../../teacher-web/src/style.css';
import { ownerOrigin, ownerTitle } from './owner-route.mjs';
import { mountOwnerCabinet } from './owner-workspace.mjs';
import { requestOwnerEmailCode } from './email-code.mjs';

const unavailable = 'Kirish hozircha mavjud emas.';
const heading = body => h('section', { className: 'status-card' }, h('h1', null, ownerTitle + 'ga kirish'), body);
const message = value => h('p', { role: 'status' }, value);

function matchingPublishingKey(key) {
  if (typeof key !== 'string' || !/^pk_live_[A-Za-z0-9+/]+={0,2}$/.test(key)) return false;
  try { return atob(key.slice('pk_live_'.length)) === 'clerk.univeracademy.uz$'; }
  catch { return false; }
}

function SignedInCabinet({ sessionId, userId }) {
  const clerk = useClerk();
  const host = useRef(null);
  useLayoutEffect(() => {
    function currentSession() {
      const session = clerk.session;
      return session?.id === sessionId && session.user?.id === userId && session.status === 'active' && !session.currentTask ? session : null;
    }
    const identity = {
      current: () => currentSession() ? { userId, generation: sessionId } : null,
      subscribe(notify) {
        let active = Boolean(currentSession());
        return clerk.addListener(() => { const next = Boolean(currentSession()); if (next !== active) { active = next; notify(); } });
      },
      async signOut() {
        if (!currentSession()) throw new Error('Session changed');
        await clerk.signOut({ sessionId, redirectUrl: ownerOrigin + '/' });
      },
    };
    return mountOwnerCabinet(host.current, { origin: ownerOrigin, identity, getCurrentClerkToken: () => currentSession()?.getToken(), fetch: window.fetch.bind(window) });
  }, [clerk, sessionId, userId]);
  return h('div', { ref: host });
}

function EmailCodeEntrance() {
  const { isLoaded, isSignedIn, session } = useSession();
  const { signIn } = useSignIn();
  const running = useRef(false), attemptId = useRef(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [challenge, setChallenge] = useState(null);
  if (!isLoaded) return heading(message('Kirish oynasi tayyorlanmoqda…'));
  if (isSignedIn && session?.status === 'active' && !session.currentTask && session.user?.id)
    return h(SignedInCabinet, { key: session.id + '/' + session.user.id, sessionId: session.id, userId: session.user.id });
  if (isSignedIn) return heading(message('Kirishni yakunlash uchun hisobingizda qo‘shimcha tasdiqlash kerak.'));
  if (!signIn || typeof signIn.emailCode?.sendCode !== 'function' || typeof signIn.emailCode?.verifyCode !== 'function' || typeof signIn.finalize !== 'function')
    return heading(message(unavailable));

  async function finish() {
    if (!attemptId.current || signIn.id !== attemptId.current) throw new Error();
    if (signIn.status === 'complete') {
      const { error } = await signIn.finalize({ navigate: () => {} });
      if (error) setNotice('Kirishni yakunlab bo‘lmadi.');
      return;
    }
    if (challenge === 'primary' && ['needs_client_trust', 'needs_second_factor'].includes(signIn.status) &&
        signIn.supportedSecondFactors?.some(factor => factor.strategy === 'email_code') && typeof signIn.mfa?.sendEmailCode === 'function') {
      const { error } = await signIn.mfa.sendEmailCode();
      if (!error) { setChallenge('secondary'); setNotice('Qo‘shimcha tasdiqlash kodini kiriting.'); return; }
    }
    setNotice('Kirishni yakunlash uchun qo‘shimcha tekshiruv kerak. Bu sahifada ushbu usul mavjud emas.');
  }

  async function submit(event) {
    event.preventDefault();
    if (running.current) return;
    const fields = new FormData(event.currentTarget);
    const email = fields.get('email'), code = fields.get('code');
    const field = event.currentTarget.elements.namedItem(challenge ? 'code' : 'email');
    if (challenge && field instanceof HTMLInputElement) field.value = '';
    if (challenge ? (typeof code !== 'string' || !code.trim()) : (typeof email !== 'string' || !email.trim() || email.trim().length > 254)) return;
    running.current = true; setBusy(true); setNotice('');
    try {
      if (!challenge) {
        attemptId.current = null;
        attemptId.current = await requestOwnerEmailCode(signIn, email.trim());
        if (field instanceof HTMLInputElement) field.value = '';
        setChallenge('primary');
        setNotice('Agar bu elektron pochta mavjud hisobga bog‘langan bo‘lsa, tasdiqlash kodi yuboriladi.');
        return;
      }
      if (!attemptId.current || signIn.id !== attemptId.current) { setNotice('Kod tasdiqlanmadi.'); return; }
      let result;
      if (challenge === 'primary' && signIn.status === 'needs_first_factor') result = await signIn.emailCode.verifyCode({ code: code.trim() });
      else if (challenge === 'secondary' && ['needs_client_trust', 'needs_second_factor'].includes(signIn.status) && typeof signIn.mfa?.verifyEmailCode === 'function')
        result = await signIn.mfa.verifyEmailCode({ code: code.trim() });
      if (!result || result.error) { setNotice('Kod tasdiqlanmadi.'); return; }
      await finish();
    } catch {
      setNotice(challenge ? 'Kirishni yakunlab bo‘lmadi.' : 'Kod so‘rovini bajarib bo‘lmadi. Birozdan so‘ng yana urinib ko‘ring.');
    } finally { running.current = false; setBusy(false); }
  }

  async function startAgain() {
    if (running.current || typeof signIn.reset !== 'function') return;
    running.current = true; setBusy(true);
    try {
      if (attemptId.current && signIn.id === attemptId.current) { const { error } = await signIn.reset(); if (error) throw new Error(); }
      attemptId.current = null; setChallenge(null); setNotice('');
    } catch { setNotice('Kirishni qayta boshlashning iloji bo‘lmadi.'); }
    finally { running.current = false; setBusy(false); }
  }

  if (challenge) return heading(h('form', { method: 'post', onSubmit: submit },
    h('label', null, 'Tasdiqlash kodi', h('input', { name: 'code', inputMode: 'numeric', autoComplete: 'one-time-code', required: true })),
    h('button', { type: 'submit', disabled: busy }, busy ? 'Tekshirilmoqda…' : 'Tasdiqlash'),
    h('button', { type: 'button', disabled: busy, onClick: startAgain }, 'Qayta boshlash'),
    message(notice)));
  return heading(h('form', { method: 'post', onSubmit: submit },
    h('p', null, 'Mavjud hisobingizga bog‘langan elektron pochtani kiriting (Google bilan kirgan pochta ham). Yangi hisob ochilmaydi.'),
    h('label', null, 'Elektron pochta', h('input', { name: 'email', type: 'email', autoComplete: 'username', required: true })),
    h('button', { type: 'submit', disabled: busy }, busy ? 'Tayyorlanmoqda…' : 'Kod yuborish'),
    message(notice)));
}

const mount = document.getElementById('app');
const key = import.meta.env.VITE_EGA_CLERK_PUBLISHABLE_KEY;
if (mount) {
  const root = createRoot(mount);
  document.title = 'UniverAcademy · ' + ownerTitle;
  // Closed unless the exact origin, the approval flag and the matching production key are all present.
  if (location.origin !== ownerOrigin || import.meta.env.VITE_EGA_EXISTING_EMAIL_SIGNIN_APPROVED !== 'true' ||
      import.meta.env.VITE_EGA_CABINET_ENABLED !== 'true' || !matchingPublishingKey(key)) {
    root.render(heading(message(unavailable)));
  } else {
    root.render(h(ClerkProvider, { publishableKey: key, prefetchUI: false, signInUrl: ownerOrigin + '/' },
      h(ClerkLoading, null, heading(message('Kirish oynasi tayyorlanmoqda…'))),
      h(ClerkFailed, null, heading(message(unavailable))),
      h(ClerkLoaded, null, h(EmailCodeEntrance))));
  }
}
