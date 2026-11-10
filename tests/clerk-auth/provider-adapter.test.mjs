import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, generateKeyPair } from "jose";
import { createClerkProviderAdapter, readClerkProductionAuthSettings } from "../../supabase/functions/univeracademy-api/clerk-provider.ts";
import { createClerkVerifier, requireLiveClerk } from "../../supabase/functions/univeracademy-api/clerk-auth.ts";
import { clerkFixture, issuer, uiOrigin, users, sids } from "./fixture.mjs";

const fault = status => error => error.status === status && !error.message.includes("private-provider-message");
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
async function fixture({ fresh = false, overrides = {} } = {}) {
  const f = await clerkFixture({ fresh }); f.activate(users.student, sids.first);
  const jwk = await exportJWK(f.pair.publicKey); jwk.kid = "clerk-synthetic-rsa";
  const wire = { jwks: { keys: [jwk] }, session: { id: sids.first, userId: users.student, status: "active",
    expireAt: f.store.time + 600_000, abandonAt: f.store.time + 300_000, actor: null },
    user: { id: users.student, banned: false, locked: false, deprovisioned: false } };
  const calls = { jwks: [], sessions: [], users: [] };
  const c = { issuer, authorizedParties: [uiOrigin], audience: { kind: "clerk_default_no_audience" },
    jwksCacheMs: 300_000, jwksCooldownMs: 0, timeoutMs: 1000, maxJwksBytes: 65_536, ...overrides };
  const bindings = { now: () => f.store.time,
    fetchJwks: async request => { calls.jwks.push(request); return json(wire.jwks); },
    getSession: async (id, options) => { calls.sessions.push({ id, signal: options.signal }); return structuredClone(wire.session); },
    getUser: async (id, options) => { calls.users.push({ id, signal: options.signal }); return structuredClone(wire.user); } };
  const adapter = createClerkProviderAdapter(c, bindings);
  const identity = { issuer, userId: users.student, sessionId: sids.first };
  const live = () => requireLiveClerk(identity, f.store.time, adapter.liveness);
  const connect = () => { Object.assign(f.deps, adapter); f.resetHandler(); };
  return { f, c, bindings, wire, calls, adapter, identity, live, connect, jwk };
}

test("production settings require explicit HTTPS issuer/azp/audience/limits and bindings; construction performs no I/O", async () => {
  const f = await fixture(); assert.equal(f.calls.jwks.length, 0); assert.equal(f.calls.sessions.length, 0);
  assert.deepEqual(readClerkProductionAuthSettings({ UA_CLERK_PROVIDER_SETTINGS: JSON.stringify(f.c) }), f.c);
  for (const value of [undefined, "{", "[]", "null"])
    assert.throws(() => readClerkProductionAuthSettings({ UA_CLERK_PROVIDER_SETTINGS: value }), fault(503));
  for (const change of [{ issuer: "http://clerk.example.com" }, { issuer: issuer + "/" }, { issuer: "https://localhost" },
    { authorizedParties: [] }, { authorizedParties: [uiOrigin, uiOrigin] }, { authorizedParties: ["*"] },
    { audience: undefined }, { audience: { kind: "required", value: "" } }, { audience: { kind: "clerk_default_no_audience", value: "ignored" } },
    { timeoutMs: 0 }, { jwksCacheMs: Infinity }, { jwksCooldownMs: 300_001 }, { maxJwksBytes: 1_048_577 }, { skipVerification: true }])
    assert.throws(() => createClerkProviderAdapter({ ...f.c, ...change }, f.bindings), fault(503));
  assert.throws(() => createClerkProviderAdapter(f.c, { ...f.bindings, getUser: undefined }), fault(503));
  assert.equal(f.calls.jwks.length, 0);
});

test("real jose signature validation uses only issuer-pinned public JWKS; no bearer/cookie/redirect and cached keys confer no liveness cache", async () => {
  const f = await fixture(), verify = createClerkVerifier(f.adapter.verifier);
  const proof = await verify(await f.f.sign({ headers: { jku: "https://attacker.invalid/keys" }, claims: { role: "owner", email: "same@example.invalid" } }));
  assert.equal(proof.userId, users.student); assert.equal(proof.sessionId, sids.first); assert.equal(proof.role, undefined);
  await verify(await f.f.sign()); assert.equal(f.calls.jwks.length, 1);
  const request = f.calls.jwks[0]; assert.equal(request.url, issuer + "/.well-known/jwks.json");
  assert.equal(request.method, "GET"); assert.equal(request.redirect, "error"); assert.equal(request.credentials, "omit"); assert.equal(request.cache, "no-store");
  assert.equal(request.headers.get("authorization"), null); assert.equal(request.headers.get("cookie"), null);
  assert.equal(await f.live(), f.wire.session.abandonAt); await f.live();
  assert.equal(f.calls.sessions.length, 2); assert.equal(f.calls.users.length, 2);
  f.wire.session.status = "revoked"; await assert.rejects(f.live(), fault(401));
});

test("signature/issuer/azp/audience/expiry/pending/impersonation remain enforced and an unknown key can rotate through the same pinned transport", async () => {
  const f = await fixture(), verify = createClerkVerifier(f.adapter.verifier);
  for (const claims of [{ iss: "https://other.example.invalid" }, { azp: "https://other.example.invalid" }, { aud: "unexpected" },
    { exp: Math.floor(f.f.store.time / 1000) }, { sts: "pending" }, { act: { sub: users.other } }, { sub: users.student + "\n" }])
    await assert.rejects(verify(await f.f.sign({ claims })), fault(401));
  const other = await generateKeyPair("RS256");
  await assert.rejects(verify(await f.f.sign({ privateKey: other.privateKey })), fault(401));
  const jwk = await exportJWK(other.publicKey); jwk.kid = "rotated-public-key"; f.wire.jwks = { keys: [jwk] };
  assert.equal((await verify(await f.f.sign({ privateKey: other.privateKey, headers: { kid: jwk.kid } }))).userId, users.student);
  assert.equal(f.calls.jwks.length, 2);
  f.wire.jwks = { keys: [f.jwk] };
  const required = createClerkProviderAdapter({ ...f.c, audience: { kind: "required", value: "reviewed-api" } }, f.bindings);
  await assert.rejects(createClerkVerifier(required.verifier)(await f.f.sign()), fault(401));
  await createClerkVerifier(required.verifier)(await f.f.sign({ claims: { aud: "reviewed-api" } }));
});

test("JWKS status/redirect/mime/JSON/size/private-key faults fail503 and never fall back to arbitrary key material", async () => {
  for (const response of [() => new Response("upstream", { status: 500 }), () => new Response(null, { status: 302, headers: { location: "https://attacker.invalid" } }),
    () => new Response("{}", { headers: { "content-type": "text/plain" } }), () => new Response("{", { headers: { "content-type": "application/json" } }),
    () => json({ keys: [] }), () => json({ keys: [{ kty: "oct", k: "private-provider-message" }] }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "999999" } }),
    () => json({ huge: "x".repeat(70_000) })]) {
    const f = await fixture(); f.bindings.fetchJwks = async () => response();
    await assert.rejects(createClerkVerifier(f.adapter.verifier)(await f.f.sign()), fault(503));
  }
  const f = await fixture(); f.bindings.fetchJwks = async () => { throw Error("private-provider-message"); };
  await assert.rejects(createClerkVerifier(f.adapter.verifier)(await f.f.sign()), fault(503));
});

test("current provider session/user identity, enabled flags and expiry boundaries deny401; missing or malformed security fields deny503", async () => {
  const f = await fixture();
  for (const patch of [{ status: "pending" }, { status: "ended" }, { actor: { sub: users.other } }, { id: sids.second }, { userId: users.other },
    { expireAt: f.f.store.time - 1 }, { expireAt: f.f.store.time }, { abandonAt: f.f.store.time }]) {
    const before = structuredClone(f.wire.session); Object.assign(f.wire.session, patch); await assert.rejects(f.live(), fault(401)); f.wire.session = before;
  }
  for (const patch of [{ banned: true }, { locked: true }, { deprovisioned: true }, { id: users.other }]) {
    const before = structuredClone(f.wire.user); Object.assign(f.wire.user, patch); await assert.rejects(f.live(), fault(401)); f.wire.user = before;
  }
  for (const field of ["banned", "locked", "deprovisioned"]) {
    delete f.wire.user[field]; await assert.rejects(f.live(), fault(503)); f.wire.user[field] = false;
  }
  for (const patch of [{ expireAt: "123" }, { abandonAt: null }, { actor: undefined, id: undefined }]) {
    const before = structuredClone(f.wire.session); Object.assign(f.wire.session, patch); await assert.rejects(f.live(), fault(503)); f.wire.session = before;
  }
  f.wire.session.abandonAt = f.f.store.time + 1; assert.equal(await f.live(), f.f.store.time + 1);
});

test("provider404 normalizes to401, credential/rate-limit/server/transport faults to503 without logging provider messages", async () => {
  for (const name of ["getSession", "getUser"]) for (const status of [404, 401, 403, 429, 500]) {
    const f = await fixture(); f.bindings[name] = async () => { throw Object.assign(Error("private-provider-message"), { status }); };
    await assert.rejects(f.live(), fault(status === 404 ? 401 : 503));
  }
});

test("bounded provider reads and JWKS timeout fail503; post-read clock catches session expiry and clock regression", async () => {
  for (const name of ["getSession", "getUser", "fetchJwks"]) {
    const f = await fixture({ overrides: { timeoutMs: 20 } });
    f.bindings[name] = async (_id, options) => { const signal = options?.signal ?? _id.signal; await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); return undefined; };
    const work = name === "fetchJwks" ? createClerkVerifier(f.adapter.verifier)(await f.f.sign()) : f.live();
    await assert.rejects(work, fault(503));
  }
  const stream = await fixture({ overrides: { timeoutMs: 20 } }); let cancelled = false;
  stream.bindings.fetchJwks = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"keys":')); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } });
  await assert.rejects(createClerkVerifier(stream.adapter.verifier)(await stream.f.sign()), fault(503));
  assert.equal(cancelled, true);
  const f = await fixture(), at = f.f.store.time;
  f.bindings.getUser = async () => { f.f.store.time = f.wire.session.abandonAt; return f.wire.user; };
  await assert.rejects(requireLiveClerk(f.identity, at, f.adapter.liveness), fault(401));
  f.f.store.time = at; f.bindings.getUser = async () => { f.f.store.time--; return f.wire.user; };
  await assert.rejects(requireLiveClerk(f.identity, at, f.adapter.liveness), fault(503));
});

test("adapter integrates with the F1-protected handler: new nullable-Telegram identity, replay/failed-login rollback and deleted binding stay closed", async () => {
  const f = await fixture({ fresh: true }); f.connect();
  const token = await f.f.sign(), first = await f.f.exchange(token); assert.equal(first.status, 200);
  const session = first.json.data, person = f.f.store.state.domain.student.people[session.profile.person_id];
  assert.equal(person.telegramId, null); assert.deepEqual(session.profile.roles, ["student"]); assert.equal(session.profile.active_group_id, null);
  const before = f.f.snapshot(); assert.equal((await f.f.exchange(token)).status, 409); assert.deepEqual(f.f.store.state, before);
  const saved = f.wire.user; f.wire.user = { ...saved, locked: true };
  assert.equal((await f.f.exchange(await f.f.sign())).status, 401); assert.deepEqual(f.f.store.state, before); f.wire.user = saved;
  assert.equal((await f.f.client.me(session.access_token)).data.person_id, person.profile.person_id);
  f.wire.session.status = "revoked"; await assert.rejects(f.f.client.me(session.access_token), fault(401));
  const family = Object.keys(f.f.store.state.familyBindings)[0]; delete f.f.store.state.familyBindings[family];
  const missing = f.f.snapshot(); await assert.rejects(f.f.client.me(session.access_token), fault(503));
  assert.equal((await f.f.call("POST", "/auth/refresh", { refresh_token: session.refresh_token })).status, 503); assert.deepEqual(f.f.store.state, missing);
});

test("provider-backed login retains saved answers/revision/deadline and old-session fencing; failed provider reads preserve the current family", async () => {
  const f = await fixture(); f.connect();
  const first = (await f.f.exchange(await f.f.sign())).json.data;
  const { ids } = await import("../backend/http-fixture.ts");
  const attempt = (await f.f.client.startAttempt(first.access_token, ids.assignment, { confirmed: true }, "provider-start-once")).data;
  const q = attempt.questions[0]; await f.f.client.saveAnswer(first.access_token, attempt.id, q.id, { selected_option_id: q.options[0].id, expected_revision: 0 });
  const saved = structuredClone(f.f.store.state.domain.student.attempts[attempt.id]), state = f.f.snapshot();
  const get = f.bindings.getSession; f.bindings.getSession = async () => { throw Error("private-provider-message"); };
  assert.equal((await f.f.exchange(await f.f.sign())).status, 503); assert.deepEqual(f.f.store.state, state); f.bindings.getSession = get;
  f.wire.session.id = sids.second;
  const next = await f.f.exchange(await f.f.sign({ sessionId: sids.second })); assert.equal(next.status, 200);
  assert.deepEqual(f.f.store.state.domain.student.attempts[attempt.id], saved);
  const resumed = (await f.f.client.resumeAttempt(next.json.data.access_token, attempt.id)).data;
  assert.equal(resumed.deadline_at, attempt.deadline_at); assert.equal(resumed.answers[0].revision, 1);
  await assert.rejects(f.f.client.me(first.access_token), fault(401));
  f.wire.session.id = sids.first; assert.equal((await f.f.exchange(await f.f.sign())).json.error.code, "CLERK_SESSION_SUPERSEDED");
});

async function holdUserReply(f, operation, at, change = () => {}) {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { entered = resolve; });
  const previous = f.bindings.getUser;
  f.bindings.getUser = async (...args) => { entered(); await gate; return previous(...args); };
  const pending = operation(); await waiting;
  f.f.store.time = at; change(); release();
  try { return await pending; } finally { f.bindings.getUser = previous; }
}
for (const [boundary, offset, status] of [["before", -1, 200], ["equal", 0, 401], ["after", 1, 401]]) {
  test(`timing: ${boundary} JWT/provider expiry after delayed reply; new profile/proofs and old-family preservation`, async () => {
    for (const fresh of [true, false]) for (const deadline of ["jwt", "expireAt", "abandonAt"]) {
      const f = await fixture({ fresh }); f.connect();
      const old = fresh ? undefined : (await f.f.exchange(await f.f.sign())).json.data;
      const initial = f.f.store.time, expires = initial + 1000;
      f.wire.session.id = sids.second;
      if (deadline !== "jwt") f.wire.session[deadline] = expires;
      const claims = deadline === "jwt" ? { exp: expires / 1000 } : {};
      const token = await f.f.sign({ sessionId: sids.second, claims });
      const before = f.f.snapshot(), commits = f.f.store.events.filter(x => x === "commit").length;
      const reply = await holdUserReply(f, () => f.f.exchange(token), expires + offset);
      assert.equal(reply.status, status, JSON.stringify({ fresh, deadline, boundary, status: reply.status, error: reply.json.error?.code, hasData: !!reply.json.data }));
      if (status === 401) {
        assert.equal(reply.json.data, undefined); assert.deepEqual(f.f.store.state, before);
        assert.equal(f.f.store.events.filter(x => x === "commit").length, commits);
        if (old) {
          f.wire.session.id = sids.first; f.wire.session.expireAt = initial + 600_000; f.wire.session.abandonAt = initial + 300_000;
          assert.equal((await f.f.client.me(old.access_token)).data.person_id, old.profile.person_id);
        }
      } else {
        assert.equal(Date.parse(reply.json.data.expires_at) > expires + offset, true);
        if (old) await assert.rejects(f.f.client.me(old.access_token), fault(401));
      }
    }
  });
}

test("timing: delayed user response rechecks account flags and mapping without consuming proof or revoking the old family", async () => {
  for (const change of [f => { f.wire.user.banned = true; }, f => { f.wire.user.locked = true; },
    f => { f.wire.user.deprovisioned = true; }, f => { f.wire.user.id = users.other; }]) {
    const f = await fixture(); f.connect();
    const old = (await f.f.exchange(await f.f.sign())).json.data;
    f.wire.session.id = sids.second;
    const token = await f.f.sign({ sessionId: sids.second }), before = f.f.snapshot();
    const reply = await holdUserReply(f, () => f.f.exchange(token), f.f.store.time + 1, () => change(f));
    assert.equal(reply.status, 401); assert.equal(reply.json.data, undefined); assert.deepEqual(f.f.store.state, before);
    f.wire.session.id = sids.first; f.wire.user = { id: users.student, banned: false, locked: false, deprovisioned: false };
    assert.equal((await f.f.client.me(old.access_token)).data.person_id, old.profile.person_id);
  }
});

test("timing: opaque refresh/access cannot use a pre-provider captured transaction clock", async () => {
  for (const [boundary, offset, status] of [["before", -1, 200], ["equal", 0, 401], ["after", 1, 401]]) for (const operation of ["refresh", "access"]) {
    const f = await fixture(); f.connect(); const session = (await f.f.exchange(await f.f.sign())).json.data;
    const expires = f.f.store.time + 1000, family = Object.keys(f.f.store.state.familyBindings)[0];
    if (operation === "refresh") f.f.store.state.domain.student.families[family].expiresAt = expires;
    else for (const access of Object.values(f.f.store.state.domain.student.access)) access.expiresAt = expires;
    const before = f.f.snapshot();
    const run = () => operation === "refresh" ? f.f.call("POST", "/auth/refresh", { refresh_token: session.refresh_token }) : f.f.call("GET", "/me", undefined, session.access_token);
    const reply = await holdUserReply(f, run, expires + offset);
    assert.equal(reply.status, status, JSON.stringify({ boundary, operation, status: reply.status, error: reply.json.error?.code, hasData: !!reply.json.data }));
    if (status === 401) { assert.equal(reply.json.data, undefined); assert.deepEqual(f.f.store.state, before); }
  }
});

test("timing: linking remains blocked409 before exp and denies401 at/after exp, with no login/link side effects", async () => {
  for (const offset of [-1, 0, 1]) {
    const f = await fixture(); f.connect(); await f.f.exchange(await f.f.sign());
    const expires = f.f.store.time + 1000, token = await f.f.sign({ claims: { exp: expires / 1000 } });
    const before = f.f.snapshot();
    const reply = await holdUserReply(f, () => f.f.call("POST", "/auth/telegram/link", {}, token), expires + offset);
    assert.equal(reply.status, offset < 0 ? 409 : 401); assert.equal(reply.json.data, undefined); assert.deepEqual(f.f.store.state, before);
  }
});

test("timing: staff JWT expiry after provider read denies before scope work; a live authorized parallel session succeeds", async () => {
  const { staffIds, versionBody } = await import("../backend/staff-fixture.ts");
  for (const offset of [-1, 0, 1]) {
    const f = await fixture(); f.connect(); f.wire.session.id = sids.admin; f.wire.session.userId = users.admin; f.wire.user.id = users.admin;
    const expires = f.f.store.time + 1000, token = await f.f.sign({ userId: users.admin, sessionId: sids.admin, claims: { exp: expires / 1000 } });
    const before = f.f.snapshot();
    const reply = await holdUserReply(f, () => f.f.call("PATCH", `/admin/versions/${staffIds.draft}`, versionBody(), token, { "idempotency-key": "timing-staff" }), expires + offset);
    assert.equal(reply.status, offset < 0 ? 200 : 401);
    if(offset>=0)assert.deepEqual(f.f.store.state, before);
  }
});

test("timing: returned session state is revalidated after a delayed user reply; no stale active-state decision", async () => {
  for (const change of [f => { f.wire.session.status = "revoked"; }, f => { f.wire.session.actor = { sub: users.other }; },
    f => { f.wire.session.userId = users.other; }, f => { f.wire.session.id = sids.first; }]) {
    const f = await fixture(); f.connect(); const old = (await f.f.exchange(await f.f.sign())).json.data;
    f.wire.session.id = sids.second; f.bindings.getSession = async () => f.wire.session;
    const token = await f.f.sign({ sessionId: sids.second }), before = f.f.snapshot();
    const reply = await holdUserReply(f, () => f.f.exchange(token), f.f.store.time + 1, () => change(f));
    assert.equal(reply.status, 401); assert.equal(reply.json.data, undefined); assert.deepEqual(f.f.store.state, before);
    f.wire.session = { id: sids.first, userId: users.student, status: "active", expireAt: f.f.store.time + 600_000, abandonAt: f.f.store.time + 300_000, actor: null };
    assert.equal((await f.f.client.me(old.access_token)).data.person_id, old.profile.person_id);
  }
});

test("timing: server clock regression after provider reply fails503 without state/proof mutation", async () => {
  const f = await fixture(); f.connect(); const before = f.f.snapshot();
  const token = await f.f.sign();
  const reply = await holdUserReply(f, () => f.f.exchange(token), f.f.store.time - 1);
  assert.equal(reply.status, 503); assert.equal(reply.json.data, undefined); assert.deepEqual(f.f.store.state, before);
});

test("timing: an exchange body cannot select linking purpose or canonical account", async () => {
  const f = await fixture({ fresh: true }); f.connect(); const token = await f.f.sign(), before = f.f.snapshot();
  for (const body of [{ purpose: "link" }, { mode: "link", person_id: "claimed" }]) {
    const reply = await f.f.exchange(token, body); assert.equal(reply.status, 422); assert.deepEqual(f.f.store.state, before);
  }
});
