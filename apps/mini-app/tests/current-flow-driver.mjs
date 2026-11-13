import { BACKEND_SOURCE_COMMIT } from './verify-backend-targets.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startContentPilotServer } from '../../../runtime/content-pilot-server.mjs';
import { publishContentPilot, assignContentPilot } from '../../../runtime/content-pilot-driver.mjs';
import { ungroupedLaunch } from '../../../runtime/ungrouped-fixture.mjs';
import { ids } from '../../../tests/backend/http-fixture.ts';
import { staffIds } from '../../../tests/backend/staff-fixture.ts';

// Node-only owner operations and proofs. The browser receives student launches
// and safe HTTP-derived IDs only. Backend files are read/imported, never edited.
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = new URL(`../test-results/current-flow-${Date.now()}/`, import.meta.url);
await mkdir(evidence, { recursive: true });

for (const width of [320, 390, 1280]) {
  const backend = await startContentPilotServer({ port: 0 });
  let vite, child, exited, assignmentWork, controlError;
  let releaseAssignment, cancelAssignment;
  const gate = new Promise((resolve, reject) => { releaseAssignment = resolve; cancelAssignment = reject; });
  gate.catch(() => {}); // Observe cleanup cancellation even before the owner reaches the gate.
  const audit = [], reports = [];
  try {
    assert.equal(backend.run.publishedVersionSeeded, false);
    assert.equal(backend.lab.store.state.versions[ids.version], undefined);
    vite = await createServer({ root, mode: 'local_fixture', server: {
      host: '127.0.0.1', port: 5208, strictPort: true,
      proxy: { '/api/v1': { target: new URL(backend.baseUrl).origin } },
    } });
    await vite.listen();
    const launch = () => ungroupedLaunch(backend.run).initData;
    const config = { url: 'http://127.0.0.1:5208/', width, runId: backend.run.run_id,
      initData: [launch(), launch(), launch()], groupId: backend.run.fixture.groupId,
      seedVersionIds: [ids.version], answerLabel: backend.run.fixture.answerLabel,
      expectedDisplay: backend.run.fixture.expectedDisplay,
      screenshotDir: fileURLToPath(new URL(`width-${width}/`, evidence)) };
    child = spawn('python3', ['-B', fileURLToPath(new URL('current-flow-browser.py', import.meta.url))],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    exited = new Promise(resolve => {
      child.once('error', error => { controlError = error; resolve(-1); });
      child.once('close', code => resolve(code));
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    send(config);
    let published, assignment;
    async function staffTransport(url, options) {
      const path = new URL(url).pathname;
      // Pause the owner's combined membership/assignment driver between its two
      // HTTP operations, so the real browser can observe membership-only emptiness.
      if (options.method === 'POST' && path.endsWith('/admin/assignments')) {
        send({ stage: 'membership_added', confirmed: true, runId: config.runId,
          personId: backend.run.fixture.studentId, groupId: config.groupId,
          demoId: published.demo_id, publishedVersionId: published.id,
          durationSeconds: published.duration_seconds });
        await gate;
      }
      const response = await fetch(url, options);
      const body = await response.clone().json();
      audit.push({ method: options.method, path, status: response.status });
      if (options.method === 'POST' && path.endsWith('/admin/assignments') && response.status === 201)
        assignment = body.data;
      return response;
    }
    for await (const line of createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      assert.equal(message.runId, config.runId);
      assert.equal(message.personId, backend.run.fixture.studentId);
      if (message.stage === 'await_staff_publication') {
        assert(!published && !assignmentWork, 'DUPLICATE_PUBLICATION_STAGE');
        published = await publishContentPilot(backend.run, staffTransport);
        assert.equal(published.status, 'published');
        assert.notEqual(published.id, ids.version);
        assert.equal(published.duration_seconds, 420);
        // Errors are observed immediately; an async hook cannot orphan a rejection.
        assignmentWork = assignContentPilot(backend.run, published, staffTransport).then(ack => {
          assert.equal(ack.confirmed, true);
          assert.equal(assignment.id, ack.assignmentId);
          assert.equal(assignment.version_id, published.id);
          send({ stage: 'assignment_added', confirmed: true, runId: config.runId,
            personId: backend.run.fixture.studentId, groupId: config.groupId,
            assignmentId: assignment.id, publishedVersionId: published.id });
        }).catch(error => { controlError = error; child.kill(); });
      } else if (message.stage === 'await_assignment') {
        assert(published && assignmentWork && !assignment, 'ASSIGNMENT_STAGE_ORDER');
        assert.equal(message.membership_observed, true);
        assert.equal(message.exams_empty, true);
        releaseAssignment();
      } else if (message.stage === 'complete') {
        assert.equal(message.status, 'PASS'); reports.push(message);
      } else throw new Error('UNKNOWN_BROWSER_STAGE');
    }
    const code = await exited;
    if (code !== 0) throw new Error(`BROWSER_CURRENT_FLOW_FAILED:${width}:${stderr}`);
    await assignmentWork;
    if (controlError) throw controlError;
    assert.equal(reports.length, 1);
    assert.deepEqual(backend.lab.store.state.audit.map(row => row.actorId),
      [staffIds.teacher, staffIds.teacher, staffIds.teacher, staffIds.teacher, staffIds.admin, staffIds.admin]);
    process.stdout.write(JSON.stringify({ ...reports[0], backendCommit: BACKEND_SOURCE_COMMIT,
      publishedVersionId: published.id, assignmentId: assignment.id,
      staffActors: { authoringAndPublish: 'approved Teacher', membershipAndAssignment: 'scoped Admin' },
      staffHttp: audit, browserAndBackendSameEnvironment: true }) + '\n');
  } finally {
    cancelAssignment(new Error('SCENARIO_CLOSED'));
    if (child && child.exitCode === null) child.kill();
    if (exited) await exited;
    if (assignmentWork) await assignmentWork;
    if (vite) await vite.close();
    await backend.close();
  }
}
