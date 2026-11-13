import './verify-backend-targets.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLocalServer } from '../../../runtime/local-server.mjs';
import { syntheticLoginInput } from '../../../runtime/local-lab.mjs';
import { ids } from '../../../tests/backend/http-fixture.ts';
import { createProductionOwnerConnection } from '../src/production-connection.ts';
import { createTelegramBootstrap } from '../src/telegram-bootstrap.ts';
import { STUDENT_CONTRACT_SHA256 } from '../src/owner-client/student-client.ts';

// Node-only fixture key/answers stay in the approved Backend test dependency.
// Actual HTTP reaches a fresh loopback RAM listener. The reserved .test hostname
// is never resolved or contacted; this explicitly injected test transport maps it.
test('production bootstrap/owner client over loopback HTTP: register, timer, CAS clear/resume, submit, result/history, logout', async () => {
  const server = await startLocalServer();
  const baseUrl = 'https://api.example.test/api/v1';
  const calls = [];
  const runtime = createTelegramBootstrap({ apiBaseUrl: baseUrl, contractSha256: STUDENT_CONTRACT_SHA256,
    readBridge: () => ({ initData: syntheticLoginInput().init_data }),
    createConnection: config => createProductionOwnerConnection(config, async request => {
      assert.equal(new URL(request.url).origin, 'https://api.example.test');
      const original = request.clone();
      const url = new URL(request.url), loopback = new URL(server.baseUrl);
      url.protocol = loopback.protocol; url.host = loopback.host;
      const response = await fetch(new Request(url, request));
      calls.push({ request: original, status: response.status }); return response;
    }) });
  try {
    const flow = await runtime.start(); assert.equal(flow.state.screen, 'profile');
    await flow.register('Suniy', 'Production'); assert.equal(flow.state.screen, 'exams');
    assert.equal(flow.state.exams.length, 1); assert.equal(flow.state.exams[0].group, '');
    await flow.openExam(flow.state.exams[0]); await flow.start(); assert.equal(flow.state.screen, 'attempt');
    const attempt = flow.state.attempt, q = attempt.questions.find(question => question.id === ids.question);
    assert.ok(flow.remainingSeconds() > 0 && flow.remainingSeconds() <= 300);
    await flow.choose(q.id, ids.correct); assert.equal(flow.state.attempt.answers[q.id].revision, 1);
    await flow.choose(q.id, null); assert.equal(flow.state.attempt.answers[q.id].revision, 2);
    assert.equal(flow.state.attempt.answers[q.id].optionId, null);
    await flow.choose(q.id, ids.correct); await flow.reconcile();
    assert.equal(flow.state.attempt.id, attempt.id); assert.equal(flow.state.attempt.deadline, attempt.deadline);
    assert.equal(flow.state.attempt.answers[q.id].revision, 3);
    await flow.submit(); assert.equal(flow.state.screen, 'result');
    assert.deepEqual([flow.state.result.earned, flow.state.result.maximum, flow.state.result.percentage, flow.state.result.bonus],
      ['1.0', '2.0', '50.00', null]);
    await flow.showHistory(); assert.equal(flow.state.screen, 'history');
    assert.equal(flow.state.history[0].result.earned, '1.0'); assert.equal(flow.state.history[0].official, true);
    await runtime.logout(); assert.equal(runtime.getSnapshot().phase, 'logged_out'); assert.equal(runtime.getSnapshot().flow, null);
    assert(calls.every(call => call.status === 200));
    const logout = calls.find(call => call.request.url.endsWith('/auth/logout')).request;
    assert.equal(logout.headers.has('authorization'), false);
    assert.deepEqual(Object.keys(await logout.json()), ['refresh_token']);
    for (const { request } of calls) {
      assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error'); assert.equal(request.cache, 'no-store');
      if (request.method === 'POST' && /\/attempts(?:\/[^/]+\/submit)?$/.test(new URL(request.url).pathname))
        assert(request.headers.get('idempotency-key'));
    }
  } finally { runtime.dispose(); await server.close(); }
});
