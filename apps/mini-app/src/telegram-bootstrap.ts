import { StudentFlow } from './flow.ts';
import type { StudentPort } from './flow.ts';
import { asFailure, failureMessage, StudentFailure } from './transport.ts';
import { STUDENT_CONTRACT_SHA256 } from './owner-client/student-client.ts';

export type TelegramBridge = { readonly initData?: string; ready?(): void };
export type StudentConnection = {
  port: StudentPort;
  auth: { login(rawInitData: string): Promise<string>; logout(): Promise<void>; person(): string | null };
};
type Phase = 'idle' | 'opening' | 'ready' | 'needs_launch' | 'logged_out' | 'error';
type Snapshot = Readonly<{ phase: Phase; flow: StudentFlow | null; notice: string; errorCode: string | null }>;

// SDK identity/roles/initDataUnsafe are deliberately never inspected or trusted.
// The official SDK must already be provided by an approved host integration.
export function readTelegramBridge(scope: unknown): TelegramBridge | undefined {
  if (!scope || typeof scope !== 'object') return;
  const telegram = (scope as { Telegram?: unknown }).Telegram;
  if (!telegram || typeof telegram !== 'object') return;
  const bridge = (telegram as { WebApp?: unknown }).WebApp;
  return bridge && typeof bridge === 'object' ? bridge as TelegramBridge : undefined;
}

export function createTelegramBootstrap(options: {
  apiBaseUrl: string;
  contractSha256: string;
  readBridge(): TelegramBridge | undefined;
  // Backend must supply its reviewed production constructor. Never relabel the
  // local_fixture client or substitute a loopback/relative endpoint here.
  createConnection(config: { mode: 'production'; baseUrl: string; contractSha256: string }): StudentConnection;
}) {
  let api: URL;
  try { api = new URL(options.apiBaseUrl); }
  catch { throw new StudentFailure('protocol', 'API_ENDPOINT_INVALID'); }
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash
      || api.pathname.replace(/\/$/, '') !== '/api/v1')
    throw new StudentFailure('protocol', 'API_ENDPOINT_INVALID');
  if (options.contractSha256 !== STUDENT_CONTRACT_SHA256)
    throw new StudentFailure('protocol', 'CONTRACT_HASH_MISMATCH');
  if (typeof options.createConnection !== 'function')
    throw new StudentFailure('protocol', 'PRODUCTION_CONNECTION_REQUIRED');

  const config = Object.freeze({ mode: 'production' as const,
    baseUrl: api.origin + '/api/v1', contractSha256: options.contractSha256 });
  const listeners = new Set<() => void>();
  // Document-lifetime fingerprints only; never retain raw launch data in a store.
  const attemptedLaunches = new Set<string>();
  const authContexts = new WeakSet<object>();
  let connection: StudentConnection | null = null;
  let epoch = 0, disposed = false;
  let opening: Promise<StudentFlow> | null = null;
  let readyBridge: TelegramBridge | undefined;
  let snapshot: Snapshot = Object.freeze({ phase: 'idle', flow: null, notice: '', errorCode: null });

  function update(value: Snapshot) {
    snapshot = Object.freeze(value);
    for (const notify of listeners) notify();
  }
  function check(generation: number) {
    if (disposed || generation !== epoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED');
  }
  function safeFailure(error: unknown) { return asFailure(error); }
  function freshConnection() {
    let value: StudentConnection;
    try { value = options.createConnection(config); }
    catch { throw new StudentFailure('protocol', 'PRODUCTION_CONNECTION_UNAVAILABLE'); }
    if (!value?.auth || ['login', 'logout', 'person'].some(key =>
      typeof (value.auth as unknown as Record<string, unknown>)[key] !== 'function')
      || !value.port || ['profile', 'register', 'exams', 'current', 'start', 'save', 'submit', 'result', 'history'].some(key =>
        typeof (value.port as unknown as Record<string, unknown>)[key] !== 'function'))
      throw new StudentFailure('protocol', 'PRODUCTION_CONNECTION_UNAVAILABLE');
    if (authContexts.has(value.auth) || value.auth.person() !== null)
      throw new StudentFailure('protocol', 'PRODUCTION_CONNECTION_REUSED');
    authContexts.add(value.auth);
    return value;
  }

  function start(): Promise<StudentFlow> {
    if (disposed) return Promise.reject(new StudentFailure('auth', 'BOOTSTRAP_DISPOSED'));
    if (opening) return opening; // Only login/bootstrap joins; no global request lock.
    const readyFlow = snapshot.flow;
    if (readyFlow && snapshot.phase === 'ready' && readyFlow.state.student?.person === connection?.auth.person())
      return Promise.resolve(readyFlow);
    const generation = ++epoch;
    let target: StudentFlow | null = null;
    let task: Promise<StudentFlow>;
    task = (async () => {
      let active = connection;
      if (!active?.auth.person()) {
        const raw = options.readBridge()?.initData;
        if (typeof raw !== 'string' || !raw.trim()) throw new StudentFailure('auth', 'TELEGRAM_LAUNCH_REQUIRED');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
        check(generation);
        const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (attemptedLaunches.has(fingerprint)) throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED');
        active = freshConnection();
        connection = active;
        target = new StudentFlow(active.port);
        target.patch({ busy: true });
        update({ phase: 'opening', flow: target, notice: '', errorCode: null });
        attemptedLaunches.add(fingerprint); // Before any ambiguous HTTP login outcome.
        await active.auth.login(raw); // Exact SDK string; verification belongs to the server.
        check(generation);
      } else {
        // Initial profile/list retry can reuse an existing RAM session without
        // replaying initData. A full reload has no persisted proof to restore.
        target = new StudentFlow(active.port);
        target.patch({ busy: true });
        update({ phase: 'opening', flow: target, notice: '', errorCode: null });
      }
      const student = await active.port.profile();
      check(generation);
      if (!student || student.person !== active.auth.person())
        throw new StudentFailure('protocol', 'PROFILE_SESSION_MISMATCH');
      const exams = student.registrationComplete ? await active.port.exams() : [];
      check(generation);
      target!.patch({ student, exams, screen: student.registrationComplete ? 'exams' : 'profile', busy: false });
      update({ phase: 'ready', flow: target!, notice: '', errorCode: null });
      return target!;
    })().catch(error => {
      if (disposed || generation !== epoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED');
      const failure = safeFailure(error);
      target?.fail(failure);
      update({ phase: failure.kind === 'auth' ? 'needs_launch' : 'error', flow: target,
        notice: failureMessage(failure), errorCode: failure.code });
      throw failure;
    }).finally(() => {
      if (generation === epoch) target?.patch({ busy: false });
      if (opening === task) opening = null;
    });
    opening = task;
    return task;
  }

  function logout(): Promise<void> {
    if (disposed) return Promise.reject(new StudentFailure('auth', 'BOOTSTRAP_DISPOSED'));
    const retired = connection;
    connection = null; opening = null;
    const generation = ++epoch;
    // Retire the whole old flow immediately. Late profile/register/save callbacks
    // can only mutate the old, no-longer-visible flow, never a new login's UI.
    update({ phase: 'logged_out', flow: null, notice: 'Server tasdig‘i kutilmoqda.', errorCode: null });
    if (!retired) {
      const failure = new StudentFailure('auth', 'LOGOUT_PROOF_REQUIRED');
      update({ ...snapshot, notice: failureMessage(failure), errorCode: failure.code });
      return Promise.reject(failure);
    }
    // Eager invocation captures that connection's proof. A synchronous hook
    // failure is part of the returned observed promise, not an orphan rejection.
    const sent = new Promise<void>(resolve => resolve(retired.auth.logout()));
    return sent.then(() => {
      check(generation);
      update({ phase: 'logged_out', flow: null, notice: 'Server sessiya yopilganini tasdiqladi.', errorCode: null });
    }).catch(error => {
      if (disposed || generation !== epoch) throw new StudentFailure('auth', 'ACCESS_SUPERSEDED');
      const failure = safeFailure(error);
      update({ phase: 'logged_out', flow: null, notice: failureMessage(failure), errorCode: failure.code });
      throw failure;
    });
  }

  return {
    start, logout,
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    ready() {
      if (disposed) return false;
      try {
        const bridge = options.readBridge();
        if (!bridge || typeof bridge.ready !== 'function') return false;
        if (bridge !== readyBridge) { bridge.ready(); readyBridge = bridge; }
        return true;
      } catch { throw new StudentFailure('protocol', 'TELEGRAM_BRIDGE_UNAVAILABLE'); }
    },
    // Disposal conceals local state; it never claims server logout or calls a bot.
    dispose() {
      disposed = true; epoch++; connection = null; opening = null;
      update({ phase: 'logged_out', flow: null, notice: '', errorCode: null }); listeners.clear();
    },
  };
}
