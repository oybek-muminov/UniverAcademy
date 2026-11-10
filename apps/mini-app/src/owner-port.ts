import { createLocalStudentClient, createProductionStudentClient, STUDENT_CONTRACT_SHA256, StudentApiError, StudentClientProtocolError } from './owner-client/student-client.ts';
import type { StudentSchema, StudentClient } from './owner-client/student-client.ts';
import { createStudentTransport, StudentFailure } from './transport.ts';
import type { FailureKind } from './transport.ts';
import { createWireMap } from './wire-map.ts';
import type { StudentPort } from './flow.ts';

// Shared UI adapter. Backend owns all operations, DTOs and constructor guards.
// No server implementation, fixture identity or signing key is imported here.
type Client = StudentClient;
type View = { title: string; groupLabel: string; startAllowed: boolean };
export type OwnerPortOptions = {
  mode: 'local_fixture' | 'production'; contractSha256: string; baseUrl: string;
  loginMethod?: 'telegram' | 'clerk'; loginSignal?: AbortSignal;
  fetcher(request: Request): Promise<Response>; view(assignmentId: string, metadata?: StudentSchema['Meta']): View; assetUrl(value: string): string;
  now?: () => number;
  logoutReceiptPolicy?: { retentionMs: number; monotonicNow?: () => number };
};
export function createOwnerPort(options: OwnerPortOptions) {
  if (!['local_fixture', 'production'].includes(options.mode) || options.contractSha256 !== STUDENT_CONTRACT_SHA256) throw new Error('CONTRACT_HASH_MISMATCH');
  if (options.loginMethod !== undefined && !['telegram', 'clerk'].includes(options.loginMethod)) throw new Error('LOGIN_METHOD_INVALID');
  // Native browser fetch must not receive the options object as its receiver.
  const fetcher = options.fetcher;
  const mapper = createWireMap({ assetUrl: options.assetUrl });
  async function call<T>(action: (client: Client) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let retryAfterMs: number | null = null;
    // Per-operation context preserves Retry-After/abort without shared mutable
    // response state. Session refresh single-flight remains in StudentTransport.
    const requestTransport = async (request: Request) => {
        const reply = await fetcher(new Request(request, { signal, cache: 'no-store', credentials: 'omit', redirect: 'error' }));
        const retry = reply.headers.get('Retry-After');
        if (reply.status === 429 && retry) {
          const ms = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - (options.now?.() ?? Date.now());
          if (Number.isFinite(ms)) retryAfterMs = Math.max(0, ms);
        }
        if (signal && reply.ok && reply.status !== 200) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED', null, true);
        return reply;
      };
    const client = options.mode === 'production'
      ? createProductionStudentClient({ mode: 'production', contractSha256: options.contractSha256, baseUrl: options.baseUrl, transport: requestTransport })
      : createLocalStudentClient({ mode: 'local_fixture', contractSha256: options.contractSha256, baseUrl: options.baseUrl, transport: requestTransport });
    try { return await action(client); }
    catch (error) {
      if (error instanceof StudentApiError) {
        const kind: FailureKind = error.status === 401 ? 'auth' : error.status === 403 ? 'forbidden'
          : error.status === 404 ? 'missing' : error.status === 409 ? 'conflict' : error.status === 422 ? 'validation'
          : error.status === 429 ? 'limited' : error.status >= 500 ? 'temporary' : 'protocol';
        throw new StudentFailure(kind, error.code, retryAfterMs, error.status >= 500);
      }
      if (error instanceof StudentClientProtocolError) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED', null, true);
      throw error;
    }
  }
  function projectSession(value: StudentSchema['Session']) {
    if (value.token_type !== 'Bearer') throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
    return { access: value.access_token, refresh: value.refresh_token, expiresAt: Date.parse(value.expires_at), person: mapper.profile(value.profile).person };
  }
  const transport = createStudentTransport({
    // Only owner operations execute HTTP. The legacy route executor is disabled.
    origin: options.mode === 'production' ? options.baseUrl : 'https://local.invalid/api/v1', now: options.now,
    fetcher: async () => { throw new Error('Use Backend-owned client operations'); },
    logoutReceiptPolicy: options.logoutReceiptPolicy,
    sessions: {
      login: async raw => projectSession((await call(client => options.loginMethod === 'clerk'
        ? client.exchangeClerkSession(raw) : client.telegramLogin({ init_data: raw }), options.loginSignal)).data),
      rotate: async refresh => projectSession((await call(client => client.refresh({ refresh_token: refresh }))).data),
      logout: async (refresh, signal) => {
        const ack = (await call(client => client.logoutByRefresh({ refresh_token: refresh }), signal)).data;
        if (!ack || ack.ok !== true) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED', null, true);
      },
    },
  });
  const context = (assignmentId: string, metadata?: StudentSchema['Meta']) => ({ assignmentId, ...options.view(assignmentId, metadata) });
  const port: StudentPort = {
    profile: () => transport.withAccess(async access => mapper.profile((await call(client => client.me(access))).data)),
    register: (firstName, lastName) => transport.withAccess(async access =>
      mapper.profile((await call(client => client.updateProfile(access, { first_name: firstName, last_name: lastName }))).data), true),
    exams: () => transport.withAccess(async access => (await call(client => client.exams(access))).data.map(meta =>
      mapper.exam(meta, context(meta.assignment_id, meta)))),
    current: assignmentId => transport.withAccess(async access => {
      const meta = (await call(client => client.exam(access, assignmentId))).data;
      const attemptId = meta.series.current_attempt_id;
      return attemptId === null ? null : mapper.attempt((await call(client => client.resumeAttempt(access, attemptId))).data,
        { ...context(assignmentId, meta), attemptId });
    }),
    start: (assignmentId, key) => transport.withAccess(async access => {
      const attempt = (await call(client => client.startAttempt(access, assignmentId, { confirmed: true }, key))).data;
      return mapper.attempt(attempt, { ...context(assignmentId), attemptId: attempt.id });
    }, true),
    save: intent => transport.withAccess(async access => {
      const current = (await call(client => client.resumeAttempt(access, intent.attemptId))).data;
      if (current.assignment_id !== intent.assignmentId || current.generation !== intent.generation) throw new StudentFailure('conflict', 'ATTEMPT_SUPERSEDED');
      return mapper.answer((await call(client => client.saveAnswer(access, intent.attemptId, intent.questionId,
        { selected_option_id: intent.optionId, expected_revision: intent.expectedRevision }))).data, intent.questionId);
    }, true),
    submit: (attemptId, generation, key) => transport.withAccess(async access => {
      const current = (await call(client => client.resumeAttempt(access, attemptId))).data;
      if (current.generation !== generation) throw new StudentFailure('conflict', 'ATTEMPT_SUPERSEDED');
      const result = mapper.result((await call(client => client.submitAttempt(access, attemptId, key))).data, attemptId);
      if (result === null) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
    }, true),
    result: (assignmentId, attemptId) => transport.withAccess(async access => {
      const current = (await call(client => client.resumeAttempt(access, attemptId))).data;
      if (current.assignment_id !== assignmentId) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
      return mapper.result((await call(client => client.result(access, attemptId))).data, attemptId);
    }),
    history: assignmentId => transport.withAccess(async access =>
      mapper.history((await call(client => client.history(access, assignmentId))).data, context(assignmentId))),
  };
  return { port, auth: { login: transport.login, logout: transport.logout, person: transport.person,
    clear: transport.clear,
    logoutReceipt: transport.logoutReceipt, retryLogoutReceipt: transport.retryLogoutReceipt, cancelLogoutReceipt: transport.cancelLogoutReceipt } };
}
