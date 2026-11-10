import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLocalOwnerPort } from '../src/local-owner-port.ts';
import { createProductionOwnerConnection } from '../src/production-connection.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';
const packet = JSON.parse(readFileSync(new URL('./fixtures/wire.json', import.meta.url), 'utf8'));
const data = key => structuredClone(packet.cases[key].data);
const config = { mode: 'production', baseUrl: 'https://api.example.test/api/v1', contractSha256: STUDENT_CONTRACT_SHA256 };
function harness(meta = data('examOpen'), asset = 'https://api.example.test/assets/synthetic.png') {
  const calls = [];
  const connection = createProductionOwnerConnection(config, async request => {
    const path = new URL(request.url).pathname.slice(7); calls.push(request);
    let value;
    if (path === '/auth/telegram') value = { token_type: 'Bearer', access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh', expires_at: new Date(Date.now() + 60000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 120000).toISOString(), profile: data('profileRegistered') };
    else if (path === '/exams') value = [meta];
    else if (path.endsWith('/attempts')) {
      value = data('in_progress');
      for (const q of value.questions) for (const block of q.prompt_blocks) if (block.type === 'image') block.asset.url = asset;
    } else throw new Error('Unexpected synthetic request');
    return new Response(JSON.stringify({ data: value }));
  });
  return { connection, calls };
}
async function exam(meta) { const h = harness(meta); await h.connection.auth.login('synthetic-launch'); return (await h.connection.port.exams())[0]; }

test('actual production connection uses Backend constructor/flags and server title without inventing a group', async () => {
  const h = harness(); await h.connection.auth.login('synthetic-raw-launch');
  const projected = (await h.connection.port.exams())[0];
  assert.equal(projected.title, data('examOpen').title); assert.equal(projected.group, ''); assert(projected.canStart);
  assert.deepEqual(await h.calls[0].clone().json(), { init_data: 'synthetic-raw-launch' });
  for (const request of h.calls) {
    assert.equal(new URL(request.url).origin, 'https://api.example.test');
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error'); assert.equal(request.cache, 'no-store'); assert.equal(request.mode, 'cors');
  }
  assert(!h.calls[0].headers.has('authorization')); assert(h.calls[1].headers.has('authorization'));
});
test('normal start affordance follows server admission and normal-use metadata', async () => {
  for (const admission of ['scheduled', 'closed', 'cancelled']) {
    const meta = data('examOpen'); meta.admission_status = admission; assert.equal((await exam(meta)).canStart, false);
  }
  const used = data('examOpen'); used.series.normal_attempt_used = true; assert.equal((await exam(used)).canStart, false);
});
test('recovery start affordance uses only server snapshot window, including closed original admission', async () => {
  const meta = data('examClosed'); meta.series = data('ready').series;
  meta.server_now = meta.series.recovery.opens_at; assert.equal((await exam(meta)).canStart, true);
  meta.server_now = meta.series.recovery.closes_at; assert.equal((await exam(meta)).canStart, false);
  meta.server_now = '2000-01-01T00:00:00Z'; assert.equal((await exam(meta)).canStart, false);
});
test('same configured API media maps while an unreviewed external media origin fails closed', async () => {
  const h = harness(); await h.connection.auth.login('synthetic-launch'); await h.connection.port.exams();
  assert.equal((await h.connection.port.start(packet.context.assignmentId, 'synthetic-start')).questions.length, 1);
  const bad = harness(undefined, 'https://unreviewed.example.test/synthetic.png');
  await bad.connection.auth.login('synthetic-launch');
  await assert.rejects(bad.connection.port.start(packet.context.assignmentId, 'synthetic-start'), e => e.code === 'MEDIA_ORIGIN_NOT_CONFIGURED');
});
test('production connection rejects local_fixture mode rather than falling back to local constructor', () => {
  assert.throws(() => createProductionOwnerConnection({ ...config, mode: 'local_fixture' }, async () => { throw new Error('NO_IO'); }), e => e.code === 'PRODUCTION_CLIENT_MODE_REQUIRED');
});

test('local UI adapter keeps its own runtime local_fixture mode boundary', () => {
  assert.throws(() => createLocalOwnerPort({ ...config, mode: 'production', fetcher: async () => { throw new Error('NO_IO'); } }), /CONTRACT_HASH_MISMATCH/);
});
