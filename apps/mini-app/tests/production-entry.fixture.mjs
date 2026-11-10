// Test-only entry composition. All requests end at synthetic in-memory Responses.
// The pinned production constructor and real connection composition are used. No real SDK/API.
import { mountTelegramEntry } from '../src/production-entry.tsx';
import { createProductionOwnerConnection } from '../src/production-connection.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
import packet from './fixtures/wire.json';
import '../src/style.css';
const scenario = new URL(location.href).searchParams.get('scenario') ?? 'registered';
const data = key => {
  const value = structuredClone(packet.cases[key].data);
  for (const question of value.questions ?? []) for (const block of question.prompt_blocks ?? [])
    if (block.type === 'image') block.asset.url = 'https://api.example.test/assets/synthetic-diagram.png';
  return value;
};
const audit = []; window.syntheticAudit = audit;
let readyCount = 0, registered = scenario !== 'profile', reads = 0, active = null;
const bridge = { initData: 'query_id=synthetic-entry&hash=synthetic-bridge-value',
  ready() { if (this !== bridge) throw new Error('Receiver lost'); readyCount++; if (scenario === 'sdk_error') throw new Error('synthetic-SECRET-hook-error'); } };
Object.defineProperty(bridge, 'initDataUnsafe', { get() { throw new Error('Unsafe identity read'); } });
if (scenario !== 'missing_sdk') window.Telegram = { WebApp: bridge };
window.syntheticReadyCount = () => readyCount;
const env = { VITE_MINI_APP_ORIGIN: 'https://app.invalid', VITE_API_ORIGIN: 'https://api.example.test',
  VITE_STUDENT_CONTRACT_SHA256: STUDENT_CONTRACT_SHA256 };
const ok = value => new Response(JSON.stringify({ data: value }), { status: 200 });
const fail = (status, code) => new Response(JSON.stringify({ error: { code, message: 'synthetic-SECRET-error',
  request_id: '00000000-0000-4000-8000-000000000099' } }), { status });
const stamp = () => new Date().toISOString();
const profile = () => data(registered ? 'profileRegistered' : 'profileIncomplete');
const transport = async request => {
  const path = new URL(request.url).pathname.slice('/api/v1'.length), method = request.method;
  const body = method === 'GET' || !request.body ? null : JSON.parse(await request.text());
  audit.push({ path, method, authorized: request.headers.has('authorization'), credentials: request.credentials,
    cache: request.cache, redirect: request.redirect, mode: request.mode, key: !!request.headers.get('idempotency-key'),
    exactRaw: path === '/auth/telegram' ? body.init_data === bridge.initData : null });
  if (path === '/auth/telegram') return ok({ token_type: 'Bearer', access_token: 'synthetic-entry-access',
    refresh_token: 'synthetic-entry-refresh', expires_at: new Date(Date.now() + 60000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 120000).toISOString(), profile: profile() });
  if (path === '/auth/logout') return ok({ ok: true });
  if (path === '/me' && method === 'PATCH') { registered = true; return ok(profile()); }
  if (path === '/me') {
    if (scenario === 'retry' && reads++ === 0) return fail(503, 'SERVICE_UNAVAILABLE');
    return ok(profile());
  }
  if (path === '/exams' && scenario === 'revoked' && reads++ > 0) return fail(401, 'SESSION_REVOKED');
  const meta = () => { const value = data('examOpen'); if (active) value.series = active.series; return value; };
  if (path === '/exams') return ok([meta()]);
  if (path === '/exams/' + packet.context.assignmentId) return ok(meta());
  if (path === `/exams/${packet.context.assignmentId}/attempts`) {
    active = data('in_progress'); active.answers = []; active.started_at = active.server_now = stamp();
    active.deadline_at = new Date(Date.now() + 720000).toISOString(); return ok(active);
  }
  if (path === '/attempts/' + packet.context.attemptId) { active.server_now = stamp(); return ok(active); }
  if (path.includes('/answers/')) {
    const previous = active.answers[0]?.revision ?? 0;
    if (body.expected_revision !== previous) return fail(409, 'REVISION_CONFLICT');
    const saved = data('savedAnswer'); saved.selected_option_id = body.selected_option_id;
    saved.revision = previous + 1; saved.saved_at = stamp(); active.answers = [saved]; return ok(saved);
  }
  if (path.endsWith('/submit')) {
    const finished = data('submitted'); finished.started_at = active.started_at; finished.deadline_at = active.deadline_at;
    active = finished; return ok(data('ordinaryResult'));
  }
  if (path.endsWith('/result')) return ok(data('ordinaryResult'));
  if (path.endsWith('/history')) return ok(data('historyCompleted'));
  throw new Error('Unexpected synthetic request');
};
const createConnection = config => createProductionOwnerConnection(config, transport);
const mounted = mountTelegramEntry(document.getElementById('root'), {
  env, pageOrigin: location.origin, scope: window, createConnection,
});
window.syntheticUnmount = () => mounted.unmount();
