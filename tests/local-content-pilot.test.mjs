import { test } from "node:test";
import assert from "node:assert/strict";
import { createContentPilotLab, contentPilotPlan } from "../runtime/content-pilot-lab.mjs";
import { startContentPilotServer } from "../runtime/content-pilot-server.mjs";
import { publishContentPilot, assignContentPilot } from "../runtime/content-pilot-driver.mjs";
import { createLocalStudentClient, STUDENT_CONTRACT_SHA256 } from "../packages/api-client/student-client.ts";
import { ungroupedLaunch } from "../runtime/ungrouped-fixture.mjs";
import { id, ids } from "./backend/http-fixture.ts";
import { validate, staffIds } from "./backend/staff-fixture.ts";
import { seriesKey } from "../supabase/functions/univeracademy-api/student-state.ts";

async function scenario(t) {
  let time = Date.now();
  const lab = createContentPilotLab({ now: () => time }), local = await startContentPilotServer({ lab });
  t.after(() => local.close());
  const client = createLocalStudentClient({ mode: "local_fixture", contractSha256: STUDENT_CONTRACT_SHA256,
    baseUrl: local.baseUrl, transport: (request) => fetch(request) });
  const launch = ungroupedLaunch(local.run, { now: time });
  const session = (await client.telegramLogin({ init_data: launch.initData })).data;
  await client.updateProfile(session.access_token, { first_name: "Yangi", last_name: "Sintetik" });
  async function call(method, path, body, key = crypto.randomUUID(), role = "synthetic-admin-proof") {
    const response = await fetch(local.baseUrl + path, { method, headers: { authorization: "Bearer " + role,
      "content-type": "application/json", "idempotency-key": key }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (response.status >= 400) assert.ok(validate("Error", json), JSON.stringify(json));
    return { status: response.status, json };
  }
  const fixture = local.run.fixture;
  const memberBody = { student_id: fixture.studentId, status: "active", ...local.run.membership };
  const member = () => call("PUT", `/admin/groups/${fixture.groupId}/members`, memberBody, "new-content-pilot-member");
  const assignmentBody = (version) => ({ demo_id: version.demo_id, version_id: version.id, group_id: fixture.groupId,
    ...local.run.schedule, timezone: "Asia/Tashkent", review_policy: "teacher_approval",
    student_ids: [fixture.studentId], reminder_lead_seconds: null });
  return { ...local, client, call, launch, token: session.access_token, fixture, member, memberBody, assignmentBody,
    publish: () => publishContentPilot(local.run),
    assign: (version, key = "new-content-pilot-assignment") => call("POST", "/admin/assignments", assignmentBody(version), key),
    admin: () => lab.store.state.staff["synthetic-admin"],
    state: () => lab.store.state,
    setTime: (value) => { time = value; }, now: () => time };
}

test("new HTTP publication, scoped Admin assignment, save/clear/resume/submit/result/history use no seed published version", async (t) => {
  const f = await scenario(t);
  assert.equal(f.launch.answerLabel, f.fixture.answerLabel);
  assert.deepEqual(f.launch.expectedDisplay, f.fixture.expectedDisplay);
  assert.deepEqual(Object.keys(f.state().student.assignments), []);
  assert.equal(f.state().versions[ids.version], undefined); // old ready version30 is absent
  assert.deepEqual((await f.client.exams(f.token)).data, []);
  const published = await f.publish();
  assert.equal(published.id, staffIds.draft); assert.notEqual(published.id, ids.version);
  assert.equal(published.status, "published"); assert.equal(published.revision, 7);
  assert.equal(published.duration_seconds, 420);
  assert.deepEqual(Object.keys(f.state().student.assignments), []);
  assert.deepEqual(await assignContentPilot(f.run, published),
    { stage: "staff_added", confirmed: true, assignmentId: f.fixture.assignmentId });
  const assigned = f.state().student.assignments[f.fixture.assignmentId];
  assert.equal(assigned.published.versionId, published.id);
  assert.equal(assigned.published.durationMs, 420000);
  const exams = (await f.client.exams(f.token)).data;
  assert.equal(exams.length, 1); assert.equal(exams[0].version_id, published.id);
  assert.equal(exams[0].title, "Fizika — yangi HTTP publish sinovi");
  const meta = (await f.client.exam(f.token, f.fixture.assignmentId)).data;
  assert.equal(meta.version_id, published.id); assert.equal(meta.duration_seconds, 420);
  assert.deepEqual(meta.instructions_blocks, published.instructions_blocks);
  const attempt = (await f.client.startAttempt(f.token, f.fixture.assignmentId, { confirmed: true }, "new-publish-start")).data;
  assert.equal(Date.parse(attempt.deadline_at) - Date.parse(attempt.started_at), 420000);
  const question = attempt.questions.find((q) => q.id === id(300));
  assert.equal(question.prompt_blocks[0].markdown, "Yangi sintetik fizika 1");
  const correct = question.options.find((o) => o.blocks[0].markdown === "Yangi A");
  const first = (await f.client.saveAnswer(f.token, attempt.id, question.id,
    { selected_option_id: correct.id, expected_revision: 0 })).data;
  assert.equal(first.revision, 1);
  await assert.rejects(f.client.saveAnswer(f.token, attempt.id, question.id,
    { selected_option_id: null, expected_revision: 0 }), (error) => error.status === 409);
  assert.equal((await f.client.saveAnswer(f.token, attempt.id, question.id,
    { selected_option_id: null, expected_revision: 1 })).data.revision, 2);
  assert.equal((await f.client.saveAnswer(f.token, attempt.id, question.id,
    { selected_option_id: correct.id, expected_revision: 2 })).data.revision, 3);
  const resumed = (await f.client.resumeAttempt(f.token, attempt.id)).data;
  assert.equal(resumed.deadline_at, attempt.deadline_at); assert.equal(resumed.answers[0].revision, 3);
  const result = (await f.client.submitAttempt(f.token, attempt.id, "new-publish-submit")).data;
  assert.deepEqual(result.ordinary.display, f.fixture.expectedDisplay);
  assert.equal(result.statistical_bonus, null);
  assert.deepEqual((await f.client.result(f.token, attempt.id)).data, result);
  assert.deepEqual((await f.client.history(f.token, f.fixture.assignmentId)).data.attempts[0].score, result);
  assert.deepEqual(f.state().student.attempts[attempt.id].ordinary.earned, { numerator: 1n, denominator: 8n });
  assert.deepEqual(f.state().student.attempts[attempt.id].ordinary.maximum, { numerator: 1n, denominator: 4n });
  assert.equal(f.state().student.attempts[attempt.id].published.versionId, published.id);
  assert.deepEqual(f.state().audit.map((a) => a.actorId),
    [staffIds.teacher, staffIds.teacher, staffIds.teacher, staffIds.teacher, staffIds.admin, staffIds.admin]);
  for (const field of ["correct_option_id", "correctOptionId", "individual_points", "publishedSnapshot",
    "numerator", "denominator", "synthetic-admin-proof", "synthetic-teacher-proof", "explanation_blocks"])
    assert.ok(!JSON.stringify({ published, exams, meta, attempt, resumed, result }).includes(field), field);
});

test("Admin A remains independent of roster, with current capability/group/subject and revoked-replay checks on the new publication", async (t) => {
  const f = await scenario(t), published = await f.publish();
  assert.equal((await f.member()).status, 200);
  f.admin().capabilities.manage_roster = false;
  const before = structuredClone(f.state());
  assert.equal((await f.member()).json.error.code, "CAPABILITY_REQUIRED");
  assert.deepEqual(f.state(), before);
  for (const field of ["group_ids", "subject_ids"]) {
    const saved = [...f.admin().scope[field]]; f.admin().scope[field] = [];
    const current = structuredClone(f.state());
    assert.equal((await f.assign(published)).status, 404); assert.deepEqual(f.state(), current);
    f.admin().scope[field] = saved;
  }
  f.admin().capabilities.manage_content = false;
  assert.equal((await f.assign(published)).json.error.code, "CAPABILITY_REQUIRED");
  f.admin().capabilities.manage_content = true;
  assert.equal((await f.assign(published)).status, 201);
  for (const [change, status] of [
    [(a) => { a.capabilities.manage_content = false; }, 403],
    [(a) => { a.scope.subject_ids = []; }, 404],
    [(a) => { a.approved = false; }, 403],
  ]) {
    const saved = structuredClone(f.admin()); change(f.admin()); const current = structuredClone(f.state());
    assert.equal((await f.assign(published)).status, status); assert.deepEqual(f.state(), current);
    f.state().staff["synthetic-admin"] = saved;
  }
  const readonly = await scenario(t), version = await readonly.publish();
  readonly.admin().capabilities.manage_content = false; // roster-only Admin
  assert.equal((await readonly.member()).status, 200);
  assert.equal((await readonly.assign(version)).json.error.code, "CAPABILITY_REQUIRED");
});

test("new content routes retain Owner/approved-subject Teacher scope while Admin A grants assignment only", async (t) => {
  const f = await scenario(t), q = contentPilotPlan().questions[0];
  const path = `/admin/versions/${f.fixture.versionId}`, before = structuredClone(f.state());
  for (const [method, url, body] of [["PUT", `${path}/questions/${q.id}`, q],
    ["POST", `${path}/publish`, { expected_revision: 3, reason: "synthetic" }]])
    assert.equal((await f.call(method, url, body)).status, 503);
  assert.deepEqual(f.state(), before);
  f.state().staff["synthetic-teacher"].approvedSubjectIds = [];
  assert.equal((await f.call("PUT", `${path}/questions/${q.id}`, q, "teacher-new-question", "synthetic-teacher-proof")).status, 404);
  assert.equal(f.state().audit.length, 0);
});

test("same-key publication/assignment retries use immutable snapshots and do not reapply authored changes", async (t) => {
  const f = await scenario(t), published = await f.publish();
  const responses = await Promise.all([assignContentPilot(f.run, published), assignContentPilot(f.run, published)]);
  assert.deepEqual(responses[0], responses[1]); assert.equal(f.state().audit.length, 6);
  assert.deepEqual(await f.publish(), published); assert.equal(f.state().audit.length, 6);
  const record = f.state().versions[published.id], assigned = f.state().student.assignments[f.fixture.assignmentId];
  const pinned = structuredClone(assigned);
  record.questions[id(300)].prompt_blocks[0].markdown = "Unpublished internal draft edit";
  assert.deepEqual(record.publishedSnapshot.questions[0].prompt_blocks[0].markdown, "Yangi sintetik fizika 1");
  assert.deepEqual(assigned, pinned);
  const q = { ...contentPilotPlan().questions[0], expected_revision: 7 };
  assert.equal((await f.call("PUT", `/admin/versions/${published.id}/questions/${q.id}`, q,
    "after-new-publish-question", "synthetic-teacher-proof")).json.error.code, "VERSION_FROZEN");
  const current = structuredClone(f.state());
  assert.equal((await f.call("POST", "/admin/assignments", { ...f.assignmentBody(published), reminder_lead_seconds: 10 },
    `content:${f.run.run_id}:assignment`)).json.error.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(f.state(), current);
});

test("publish/assignment race never exposes a draft or partial snapshot; identical assignment can retry after publish", async (t) => {
  const f = await scenario(t), plan = contentPilotPlan(), path = `/admin/versions/${f.fixture.versionId}`;
  await f.member();
  for (const q of plan.questions) assert.equal((await f.call("PUT", `${path}/questions/${q.id}`, q,
    `race-question-${q.id}`, "synthetic-teacher-proof")).status, 200);
  assert.equal((await f.call("PATCH", path, plan.metadata, "race-metadata", "synthetic-teacher-proof")).status, 200);
  const draft = structuredClone(f.state().versions[f.fixture.versionId].wire);
  assert.equal((await f.assign(draft)).json.error.code, "VERSION_FROZEN");
  assert.deepEqual(Object.keys(f.state().student.assignments), []);
  const [publication, assignment] = await Promise.all([
    f.call("POST", `${path}/publish`, plan.publish, "race-publish", "synthetic-teacher-proof"), f.assign(draft),
  ]);
  assert.equal(publication.status, 200); assert.ok([201, 409].includes(assignment.status));
  const retry = await f.assign(publication.json.data); assert.equal(retry.status, 201);
  assert.equal(retry.json.data.version_id, publication.json.data.id);
  assert.equal(Object.keys(f.state().student.assignments).length, 1);
  assert.equal(f.state().student.assignments[retry.json.data.id].published.questions.length, 2);
  assert.equal(f.state().audit.filter((a) => a.action === "assignment_create").length, 1);
});

test("assignment commit failure rolls back snapshot/grants; lost ACK retries recover exactly one committed assignment", async (t) => {
  const f = await scenario(t), published = await f.publish();
  assert.equal((await f.call("PUT", `/admin/groups/${f.fixture.groupId}/members`, f.memberBody,
    `content:${f.run.run_id}:membership`)).status, 200);
  const before = structuredClone(f.state()); f.lab.store.failNextCommit = true;
  assert.equal((await f.assign(published)).status, 503); assert.deepEqual(f.state(), before);
  let lost = false;
  await assert.rejects(assignContentPilot(f.run, published, async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/admin/assignments") && !lost) { lost = true; throw Error("SYNTHETIC_ACK_LOSS"); }
    return response;
  }), /SYNTHETIC_ACK_LOSS/);
  const current = structuredClone(f.state());
  assert.equal((await assignContentPilot(f.run, published)).confirmed, true);
  assert.deepEqual(f.state(), current); assert.equal(Object.keys(f.state().student.assignments).length, 1);
  assert.equal(f.state().audit.filter((a) => a.action === "assignment_create").length, 1);
});

test("newly published active attempt blocks transfer before deadline, expires at equality and keeps answers/result/history", async (t) => {
  const f = await scenario(t), published = await f.publish(); await assignContentPilot(f.run, published);
  const attempt = (await f.client.startAttempt(f.token, f.fixture.assignmentId, { confirmed: true }, "transfer-new-start")).data;
  const q = attempt.questions.find((q) => q.id === id(300));
  await f.client.saveAnswer(f.token, attempt.id, q.id, { selected_option_id: id(600), expected_revision: 0 });
  const move = { to_group_id: ids.group, expected_membership_revision: 1, reason: "Synthetic new publish transfer" };
  f.setTime(Date.parse(attempt.deadline_at) - 1);
  const before = structuredClone(f.state());
  assert.equal((await f.call("POST", `/admin/students/${f.fixture.studentId}/transfer`, move,
    "new-active-transfer")).json.error.code, "ACTIVE_EXAM_OR_RECOVERY");
  assert.deepEqual(f.state(), before);
  f.setTime(Date.parse(attempt.deadline_at));
  assert.equal((await f.call("POST", `/admin/students/${f.fixture.studentId}/transfer`,
    { ...move, expected_membership_revision: 0 }, "new-expiry-stale-cas")).json.error.code, "STATE_REVISION_CONFLICT");
  assert.equal(f.state().student.attempts[attempt.id].status, "expired");
  assert.equal(f.state().memberships[f.fixture.studentId].affinityGroupId, f.fixture.groupId);
  assert.equal((await f.call("POST", `/admin/students/${f.fixture.studentId}/transfer`, move,
    "new-active-transfer")).status, 200);
  const stored = f.state().student.attempts[attempt.id];
  assert.equal(stored.status, "expired"); assert.equal(stored.deadlineAt, Date.parse(attempt.deadline_at));
  assert.equal(stored.answers[0].selectedOptionId, id(600));
  const result = (await f.client.result(f.token, attempt.id)).data;
  assert.deepEqual(result.ordinary.display, f.fixture.expectedDisplay);
  assert.deepEqual((await f.client.history(f.token, f.fixture.assignmentId)).data.attempts[0].score, result);
});

test("unstarted future recovery on the new published test is cancelled by transfer while exact history and receipt replay survive", async (t) => {
  const f = await scenario(t), published = await f.publish(); await assignContentPilot(f.run, published);
  const attempt = (await f.client.startAttempt(f.token, f.fixture.assignmentId, { confirmed: true }, "new-recovery-start")).data;
  await f.client.saveAnswer(f.token, attempt.id, id(300), { selected_option_id: id(600), expected_revision: 0 });
  const result = (await f.client.submitAttempt(f.token, attempt.id, "new-recovery-submit")).data;
  const sk = seriesKey(f.fixture.studentId, published.demo_id), series = f.state().student.series[sk];
  // Existing recovery HTTP activation is not implemented. Only this server-side
  // test fixture seeds an unstarted permission, not a new product/API right.
  const window = { opensAt: f.now() + 1000, closesAt: f.now() + 100000, durationMs: 420000 };
  series.recoveryState = "ready"; series.recovery = structuredClone(window);
  f.state().recoveryAssignments[sk] = f.fixture.assignmentId;
  const stored = structuredClone(f.state().student.attempts[attempt.id]);
  const move = { to_group_id: ids.group, expected_membership_revision: 1, reason: "Synthetic ready recovery transfer" };
  const transfer = () => f.call("POST", `/admin/students/${f.fixture.studentId}/transfer`, move, "new-ready-transfer");
  assert.equal((await transfer()).status, 200);
  assert.equal(f.state().student.series[sk].recoveryState, "none");
  assert.equal(f.state().student.series[sk].recovery, null);
  assert.deepEqual(f.state().recoveryRevocations[0].window, window);
  assert.deepEqual(f.state().student.attempts[attempt.id], stored);
  assert.deepEqual((await f.client.result(f.token, attempt.id)).data, result);
  assert.deepEqual((await f.client.history(f.token, f.fixture.assignmentId)).data.attempts[0].score, result);
  const after = structuredClone(f.state()); assert.equal((await transfer()).status, 200); assert.deepEqual(f.state(), after);
});

test("start/transfer race for the newly published assignment has one serialized winner and no migrated running attempt", async (t) => {
  const f = await scenario(t), published = await f.publish(); await assignContentPilot(f.run, published);
  const [start, move] = await Promise.all([
    f.call("POST", `/exams/${f.fixture.assignmentId}/attempts`, { confirmed: true }, "new-race-start", f.token),
    f.call("POST", `/admin/students/${f.fixture.studentId}/transfer`, { to_group_id: ids.group,
      expected_membership_revision: 1, reason: "Synthetic start-transfer race" }, "new-race-transfer"),
  ]);
  if (start.status === 200) {
    assert.equal(move.status, 409); assert.equal(move.json.error.code, "ACTIVE_EXAM_OR_RECOVERY");
    assert.equal(f.state().student.attempts[start.json.data.id].groupId, f.fixture.groupId);
    assert.equal(f.state().memberships[f.fixture.studentId].affinityGroupId, f.fixture.groupId);
  } else {
    assert.equal(move.status, 200); assert.ok([403, 404].includes(start.status));
    assert.equal(Object.keys(f.state().student.attempts).length, 0);
    assert.equal(f.state().memberships[f.fixture.studentId].affinityGroupId, ids.group);
  }
});

test("missing authoritative demo metadata or mismatched published identity cannot create a grant or substitute old content", async (t) => {
  const f = await scenario(t), published = await f.publish(); await f.member();
  const demo = f.state().demos[published.demo_id]; delete f.state().demos[published.demo_id];
  const missing = structuredClone(f.state());
  assert.equal((await f.assign(published)).status, 503); assert.deepEqual(f.state(), missing);
  f.state().demos[published.demo_id] = demo;
  f.state().versions[published.id].publishedSnapshot.test.versionId = ids.version;
  const mismatched = structuredClone(f.state());
  assert.equal((await f.assign(published)).json.error.code, "RESPONSE_INVARIANT_FAILED");
  assert.deepEqual(f.state(), mismatched);
  assert.equal(Object.keys(f.state().student.assignments).length, 0);
  assert.equal(Object.keys(f.state().student.grants[f.fixture.studentId]).length, 0);
});
