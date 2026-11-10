import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { startClerkReviewServer, createClerkReviewLab } from "../../runtime/clerk-review-server.mjs";
import { createProductionStudentClient, StudentApiError, STUDENT_CONTRACT_SHA256,
  STUDENT_CONTRACT_VERSION, STUDENT_CONTRACT_REVIEW_STATUS } from "../../packages/api-client/student-client.ts";
import { staffIds, versionBody } from "../backend/staff-fixture.ts";

const load = createRequire(import.meta.url);
const { buildView } = load("../backend/validator/view-builder.cjs");
const { compileView } = load("../backend/validator/ajv-config.cjs");
const raw = readFileSync(new URL("../../contracts/clerk-review.openapi.json", import.meta.url));
const review = JSON.parse(raw);
const { ajv, validators } = compileView(buildView(raw).view);
function wire(name, value) {
  const validate = validators.get(name);
  assert.equal(validate(value), true, name + ": " + JSON.stringify(validate.errors));
  return value;
}

test("exchange-only review is pinned, all 206 schemas compile with strict formats, and existing staff/student payload contracts remain exact", () => {
  const base = JSON.parse(readFileSync(new URL("../../contracts/review-only.openapi.json", import.meta.url)));
  assert.equal(createHash("sha256").update(raw).digest("hex"), STUDENT_CONTRACT_SHA256);
  assert.equal(review.info.version, STUDENT_CONTRACT_VERSION);
  assert.equal(review['x-status'], STUDENT_CONTRACT_REVIEW_STATUS);
  assert.equal(review['x-status'], "PROVISIONAL / NOT ACCEPTED");
  assert.equal(validators.size, 206);
  assert.equal(ajv.opts.strict, true); assert.equal(ajv.opts.validateFormats, true);
  for (const [name, schema] of Object.entries(base.components.schemas)) {
    const expected = structuredClone(schema);
    if (name === "Error") expected.properties.error.properties.code.enum.push(...review['x-clerk-review'].added_student_error_codes);
    assert.deepEqual(review.components.schemas[name], expected, name);
  }
  assert.equal(review['x-clerk-review'].added_student_error_codes.length, 5);
  for (const [path, schema] of Object.entries(base.paths)) assert.deepEqual(review.paths[path], schema, path);
  assert.equal(Object.keys(review.paths).length, Object.keys(base.paths).length + 1);
  assert.deepEqual(review.paths['/auth/clerk'].post.security, [{ ClerkSessionBearer: [] }]);
  assert.equal(validators.get("ClerkExchangeRequest")({}), true);
  for (const value of [null, [], "", { token: "in-body" }, { roles: ["owner"] }])
    assert.equal(validators.get("ClerkExchangeRequest")(value), false);
  assert.equal(review.paths['/auth/telegram/link'], undefined);
});

test("existing production client exchange sends only bearer + empty JSON body, rejects stale pin and preserves safe errors without retries", async () => {
  const requests = [];
  const options = { mode: "production", contractSha256: STUDENT_CONTRACT_SHA256,
    baseUrl: "https://api.example.com/api/v1", transport: async request => {
      requests.push(request);
      return new Response(JSON.stringify({ error: { code: "CLERK_TOKEN_INVALID", message: "ignored raw error", request_id: "synthetic-request" } }), { status: 401 });
    } };
  assert.throws(() => createProductionStudentClient({ ...options, contractSha256: review['x-clerk-review'].base_openapi_sha256 }), /CONTRACT_HASH_MISMATCH/);
  const client = createProductionStudentClient(options);
  await assert.rejects(client.exchangeClerkSession("synthetic-clerk-proof"), error =>
    error instanceof StudentApiError && error.status === 401 && error.code === "CLERK_TOKEN_INVALID" && !error.message.includes("proof"));
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "https://api.example.com/api/v1/auth/clerk");
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-clerk-proof");
  assert.deepEqual(await request.json(), {});
  assert.equal(request.redirect, "error"); assert.equal(request.credentials, "omit"); assert.equal(request.cache, "no-store");
});

test("TCP listener preserves existing account, save revision and deadline across single-device login, then submit/result/history and body-only logout", async t => {
  let now = Date.now();
  const lab = await createClerkReviewLab({ now: () => now });
  const local = await startClerkReviewServer({ lab }); t.after(() => local.close());
  const client = lab.client(local.baseUrl), first = wire("SuccessSession", await client.exchangeClerkSession(await lab.sign())).data;
  assert.equal(first.profile.person_id, lab.ids.person);
  wire("SuccessProfile", await client.me(first.access_token));
  wire("SuccessMetaList", await client.exams(first.access_token));
  const attempt = wire("SuccessAttempt", await client.startAttempt(first.access_token, lab.ids.assignment, { confirmed: true }, "review-start-once")).data;
  const q = attempt.questions[0], selected = q.options[0].id;
  const ack = wire("SuccessAnswer", await client.saveAnswer(first.access_token, attempt.id, q.id, { selected_option_id: selected, expected_revision: 0 }));
  assert.equal(ack.data.revision, 1);
  const snapshot = structuredClone(lab.store.state.domain.student.attempts[attempt.id]);
  now += 100;
  lab.activate(lab.users.student, lab.sids.second);
  const second = wire("SuccessSession", await client.exchangeClerkSession(await lab.sign({ sessionId: lab.sids.second }))).data;
  await assert.rejects(client.me(first.access_token), error => error.status === 401);
  const resumed = wire("SuccessAttempt", await client.resumeAttempt(second.access_token, attempt.id)).data;
  assert.equal(resumed.deadline_at, attempt.deadline_at);
  assert.equal(resumed.answers[0].revision, 1); assert.equal(resumed.answers[0].selected_option_id, selected);
  assert.deepEqual(lab.store.state.domain.student.attempts[attempt.id], snapshot);
  const result = wire("SuccessStudentCompletedGradingResult", await client.submitAttempt(second.access_token, attempt.id, "review-submit-once"));
  assert.deepEqual(await client.submitAttempt(second.access_token, attempt.id, "review-submit-once"), result);
  wire("SuccessStudentGradingResult", await client.result(second.access_token, attempt.id));
  assert.ok(JSON.stringify(wire("SuccessHistory", await client.history(second.access_token, lab.ids.assignment))).includes(attempt.id));
  wire("SuccessAck", await client.logoutByRefresh({ refresh_token: second.refresh_token }));
  await assert.rejects(client.me(second.access_token), error => error.status === 401);
});

test("TCP exchange creates a fresh ungrouped student, keeps linking blocked and allows currently authorized parallel staff", async t => {
  const local = await startClerkReviewServer(); t.after(() => local.close());
  const { lab } = local, client = lab.client(local.baseUrl), token = await lab.sign(lab.actors.fresh);
  const before = lab.snapshot();
  for (const [body, status] of [[{ person_id: lab.ids.person }, 422], [null, 422], ["{", 400]]) {
    const response = await fetch(local.baseUrl + "/auth/clerk", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    assert.equal(response.status, status); wire("Error", await response.json()); assert.deepEqual(lab.store.state, before);
  }
  const session = wire("SuccessSession", await client.exchangeClerkSession(token)).data;
  assert.notEqual(session.profile.person_id, lab.ids.person); assert.equal(session.profile.registration_complete, false);
  assert.equal(session.profile.active_group_id, null); assert.deepEqual(session.profile.roles, ["student"]);
  assert.equal(lab.store.state.domain.student.people[session.profile.person_id].telegramId, null);
  wire("SuccessProfile", await client.updateProfile(session.access_token, { first_name: "Synthetic", last_name: "New" }));
  assert.deepEqual((await client.exams(session.access_token)).data, []);
  const link = await fetch(local.baseUrl + "/auth/telegram/link", { method: "POST", headers: { authorization: "Bearer " + await lab.sign(lab.actors.fresh) }, body: "{}" });
  assert.equal(link.status, 409); assert.equal((await link.json()).error.code, "IDENTITY_LINK_POLICY_UNRESOLVED");
  lab.activate(lab.users.admin, lab.sids.admin);
  const staff = await fetch(local.baseUrl + `/admin/versions/${staffIds.draft}`, { method: "PATCH", headers: { authorization: "Bearer " + await lab.sign({ userId: lab.users.admin, sessionId: lab.sids.admin }), "content-type": "application/json", "idempotency-key": "review-staff-default-deny" }, body: JSON.stringify(versionBody()) });
  assert.equal(staff.status, 200);
});

test("TCP F1 regression: revoked provider denies401, deleted binding/unmarked origin denies503 without new proofs; no synthetic control routes or CORS bypass", async t => {
  const origin = "http://127.0.0.1:5198";
  const local = await startClerkReviewServer({ allowedOrigins: [origin] }); t.after(() => local.close());
  const { lab } = local, client = lab.client(local.baseUrl), session = (await client.exchangeClerkSession(await lab.sign())).data;
  assert.equal((await fetch(local.baseUrl + "/__fixture/proof", { headers: { authorization: "Bearer " + session.access_token } })).status, 404);
  const familyId = Object.keys(lab.store.state.familyBindings)[0];
  lab.live.get(lab.sids.first).status = "revoked";
  const deny = async status => {
    const before = lab.snapshot();
    for (const [path, method, body, token] of [["/me", "GET", undefined, session.access_token], ["/auth/refresh", "POST", { refresh_token: session.refresh_token }, undefined]]) {
      const response = await fetch(local.baseUrl + path, { method, headers: { origin, ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      const value = wire("Error", await response.json()); assert.equal(value.data, undefined);
    }
    assert.deepEqual(lab.store.state, before);
  };
  await deny(401); delete lab.store.state.familyBindings[familyId]; await deny(503);
  delete lab.store.state.domain.student.families[familyId].authProvider; await deny(503);
  const before = lab.snapshot();
  const preflight = await fetch(local.baseUrl + "/auth/clerk", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "Authorization, Content-Type" } });
  assert.equal(preflight.status, 204); assert.deepEqual(lab.store.state, before);
  assert.equal((await fetch(local.baseUrl + "/auth/clerk", { method: "POST", headers: { origin: "http://127.0.0.1:9999" }, body: "{}" })).status, 403);
  const unauthenticated = await fetch(local.baseUrl + "/__fixture/proof");
  assert.equal(unauthenticated.status, 401); assert.equal((await unauthenticated.json()).data, undefined);
  assert.deepEqual(lab.store.state, before);
});
