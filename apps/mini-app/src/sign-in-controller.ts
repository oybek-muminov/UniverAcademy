import { StudentFlow } from './flow.ts';
import type { StudentPort } from './flow.ts';

// Provider evidence is distinct from the Backend-owned opaque app session.
export type SignInEvidence = { proof: string };
export type SignInProvider = {
  google(): Promise<SignInEvidence>;
  current?(): Promise<SignInEvidence>;
  cancel?(): void;
  signOut?(appLogout: Promise<unknown>): Promise<void>;
  sendCode(email: string): Promise<{ challenge: string }>;
  verifyCode(challenge: string, code: string): Promise<SignInEvidence>;
};
export class EntryFailure extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
type Step = 'choose' | 'sending' | 'code' | 'verifying' | 'authorizing' | 'ready' | 'browser_required';
export type SignInSnapshot = Readonly<{ step: Step; busy: boolean; maskedEmail: string; notice: string; flow: StudentFlow | null }>;
const messages: Record<string, string> = {
  INVALID_EMAIL: 'Email manzilini tekshiring.',
  INVALID_CODE: 'Kod mos kelmadi. Qayta tekshiring.',
  CODE_EXPIRED: 'Kod muddati tugagan. Yangi kod so‘rang.',
  RATE_LIMITED: 'Biroz kutib, qayta urinib ko‘ring.',
  CANCELLED: 'Google bilan kirish bekor qilindi.',
  VERIFICATION_REQUIRED: 'Qo‘shimcha tasdiqlash kerak. Kirish usulini qayta tanlang.',
  POPUP_BLOCKED: 'Brauzer kirish oynasini to‘sdi. Oynaga ruxsat berib, qayta urinib ko‘ring.',
  AUTH_CLEANUP_PENDING: 'Oldingi kirish amali yakunlanmoqda. Biroz kutib qayta urinib ko‘ring.',
  PROVIDER_UNAVAILABLE: 'Kirish xizmati javob bermadi. Keyinroq qayta urinib ko‘ring.',
  FRESH_PROOF_REQUIRED: 'Kirishni yangidan tasdiqlang. Oldingi tasdiq takror yuborilmadi.',
  APP_DENIED: 'Kabinetga kirish huquqi tasdiqlanmadi. Ma’lumotlar ochilmadi.',
  PROFILE_MISMATCH: 'Hisob mosligi tasdiqlanmadi. Yangidan kirib ko‘ring.',
};
export function createSignInController(options: {
  context: 'browser' | 'telegram_webview'; provider: SignInProvider;
  validateEmail?(email: string): boolean; invalidEmailMessage?: string;
  authorize(evidence: SignInEvidence): Promise<{ person: string; port: StudentPort }>;
  retire?(): Promise<'confirmed' | 'unconfirmed' | 'none'>;
}) {
  let state: SignInSnapshot = Object.freeze({ step: 'choose', busy: false, maskedEmail: '', notice: '', flow: null });
  const listeners = new Set<() => void>();
  let epoch = 0, disposed = false, challenge: string | null = null, email = '';
  let pending: Promise<void> | null = null;
  function update(value: Partial<SignInSnapshot>) {
    if (disposed) return;
    state = Object.freeze({ ...state, ...value }); listeners.forEach(notify => notify());
  }
  function check(generation: number) { if (disposed || generation !== epoch) throw new EntryFailure('SUPERSEDED'); }
  function clearLocal() {
    epoch++; pending = null; challenge = null; email = '';
    update({ step: 'choose', busy: false, maskedEmail: '', notice: '', flow: null });
  }
  function retire() {
    // Eager invocation invalidates the old connection before any late callback.
    return new Promise<'confirmed' | 'unconfirmed' | 'none'>(resolve => resolve(options.retire?.() ?? 'none'));
  }
  function retireAll() {
    options.provider.cancel?.();
    const app = retire();
    const sdk = new Promise<void>(resolve => resolve(options.provider.signOut?.(app)));
    return Promise.allSettled([app, sdk]).then(([receipt, provider]) => {
      if (receipt.status === 'rejected') throw receipt.reason;
      if (provider.status === 'rejected') throw new EntryFailure(receipt.value === 'confirmed'
        ? 'PROVIDER_LOGOUT_UNCONFIRMED' : 'LOGOUT_UNCONFIRMED');
      return receipt.value;
    });
  }
  function reset() { clearLocal(); return retireAll().then(() => {}, () => {}); }
  async function logout() {
    clearLocal(); const generation = epoch;
    try {
      const receipt = await retireAll(); check(generation);
      update({ notice: receipt === 'confirmed' ? 'Server sessiya yopilganini tasdiqladi.'
        : receipt === 'unconfirmed' ? 'Kirish bekor qilindi. Server holati tasdiqlanmagan; yangidan kiring.' : '' });
    } catch (error) {
      check(generation); update({ notice: error instanceof EntryFailure && error.code === 'PROVIDER_LOGOUT_UNCONFIRMED'
        ? 'Server sessiya yopilganini tasdiqladi. Kirish xizmatidagi chiqish tasdiqlanmadi.'
        : 'Sessiya lokal yopildi. Server tasdig‘i kelmadi; yangidan kiring.' }); throw error;
    }
  }
  function run(step: Step, failureStep: Step, action: (generation: number) => Promise<void>): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    const generation = ++epoch;
    update({ step, busy: true, notice: '', flow: null });
    const task = (async () => { await action(generation); })().catch(error => {
      if (disposed || generation !== epoch) return;
      void retire().catch(() => {}); // Rejected bootstrap cannot retain an app proof.
      const code = error instanceof EntryFailure ? error.code : 'UNCONFIRMED';
      const expired = code === 'CODE_EXPIRED';
      if (expired) { challenge = null; email = ''; }
      const nextStep = expired || (failureStep === 'code' && !challenge) ? 'choose' : failureStep;
      update({ step: nextStep, notice: messages[code] ?? 'Tasdiq kelmadi. Keyinroq qayta urinib ko‘ring.', flow: null });
    }).finally(() => {
      if (!disposed && generation === epoch) update({ busy: false });
      if (pending === task) pending = null;
    });
    pending = task; return task;
  }
  async function finish(evidence: SignInEvidence, generation: number) {
    check(generation);
    if (!evidence || typeof evidence.proof !== 'string' || !evidence.proof) throw new EntryFailure('APP_DENIED');
    challenge = null; email = '';
    update({ step: 'authorizing', maskedEmail: '' });
    // A provider success alone cannot open the existing student UI.
    const authorization = await options.authorize(evidence); check(generation);
    const student = await authorization.port.profile(); check(generation);
    if (!student || student.person !== authorization.person) throw new EntryFailure('PROFILE_MISMATCH');
    const exams = student.registrationComplete ? await authorization.port.exams() : []; check(generation);
    const flow = new StudentFlow(authorization.port, undefined, undefined, 'clerk');
    flow.patch({ student, exams, screen: student.registrationComplete ? 'exams' : 'profile' });
    challenge = null; email = '';
    update({ step: 'ready', maskedEmail: '', notice: '', flow });
  }
  function google(): Promise<void> {
    if (disposed || state.step === 'ready') return Promise.resolve();
    if (pending) return pending;
    if (options.context === 'telegram_webview') {
      update({ step: 'browser_required', notice: '', flow: null }); return Promise.resolve();
    }
    challenge = null; email = ''; update({ maskedEmail: '' });
    return run('verifying', 'choose', async generation => {
      const evidence = await options.provider.google(); check(generation); await finish(evidence, generation);
    });
  }
  function continueSession(): Promise<void> {
    if (disposed || state.step === 'ready' || !options.provider.current) return Promise.resolve();
    return run('verifying', 'choose', async generation => {
      const evidence = await options.provider.current!(); check(generation); await finish(evidence, generation);
    });
  }
  function sendCode(value: string): Promise<void> {
    if (disposed || state.step === 'ready') return Promise.resolve();
    if (pending) return pending;
    const normalized = value.trim().toLowerCase();
    if (!(options.validateEmail ?? (email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))(normalized)) {
      update({ notice: options.invalidEmailMessage ?? messages.INVALID_EMAIL }); return Promise.resolve();
    }
    email = normalized; challenge = null;
    update({ maskedEmail: normalized[0] + '***@' + normalized.split('@')[1] });
    return run('sending', 'choose', async generation => {
      const sent = await options.provider.sendCode(normalized); check(generation);
      if (!sent || typeof sent.challenge !== 'string' || !sent.challenge) throw new EntryFailure('UNCONFIRMED');
      challenge = sent.challenge; update({ step: 'code' });
    });
  }
  function verifyCode(code: string): Promise<void> {
    if (disposed || state.step === 'ready') return Promise.resolve();
    if (pending) return pending;
    if (!challenge || state.step !== 'code') return Promise.resolve();
    if (!/^\d{6}$/.test(code)) { update({ notice: messages.INVALID_CODE }); return Promise.resolve(); }
    const current = challenge;
    return run('verifying', 'code', async generation => {
      const evidence = await options.provider.verifyCode(current, code); check(generation); await finish(evidence, generation);
    });
  }
  return {
    snapshot: () => state, subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    google, continueSession, sendCode, verifyCode, resend: () => email ? sendCode(email) : Promise.resolve(), reset, logout,
    // Disposal retires captured contexts; it cannot claim an unknown server ACK.
    dispose() { reset(); disposed = true; listeners.clear(); },
  };
}
