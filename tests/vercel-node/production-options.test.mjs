import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import workers, { Worker } from "node:worker_threads";
import net from "node:net";
import { createProductionOptions } from "../../runtime/production-options.mjs";
import { ApiFault } from "../../supabase/functions/univeracademy-api/fault.ts";
import { withPublicCors } from "../../runtime/local-cors.mjs";

// Explicit synthetic inputs, never production policy or credential defaults.
const secret = "SYNTHETIC_PRIVATE_CANARY_DO_NOT_ECHO";
function prepared(profile = "native") {
  const calls = [];
  const forbidden = name => () => { calls.push(name); throw Error(secret); };
  class PreparedPool { connect = forbidden("pool.connect"); }
  const configuration = {
    mode: "production", storage: { kind: "postgres", pool: new PreparedPool() },
    sessionPolicy: { initDataMaxAgeSeconds: 121, futureSkewSeconds: 2, accessTtlMs: 31000,
      familyTtlMs: 93000, logoutTombstoneMs: 47000, identityCollisionAttempts: 3, newLogin: "revoke_previous" },
    numericPresentation: { policyId: "synthetic-explicit-policy", toFiniteNumber: forbidden("toFiniteNumber"),
      toDisplayString: forbidden("toDisplayString"), toStudentPointsDisplayString: forbidden("toStudentPointsDisplayString") },
    now: forbidden("now"),
  };
  if (profile === "native") {
    configuration.botToken = secret;
    configuration.staff = { domain: "first_test_relational", jwt: { issuer: "https://native.synthetic.invalid",
      audience: "synthetic-staff", algorithms: ["RS256", "ES256"], trustedKeys: forbidden("native.keys"), now: forbidden("native.now") },
      liveness: forbidden("native.liveness"), validate: forbidden("native.validate"), newAssignmentId: forbidden("native.newAssignmentId") };
  } else {
    configuration.clerk = { verifier: { issuer: "https://clerk.synthetic.invalid", authorizedParties: ["https://app.synthetic.invalid"],
      audience: { kind: "required", value: "synthetic-api" }, trustedKeys: forbidden("clerk.keys"), now: forbidden("clerk.now") },
      liveness: forbidden("clerk.liveness"), staff: { validate: forbidden("clerk.validate"), newAssignmentId: forbidden("clerk.newAssignmentId") } };
  }
  return { input: { apiOrigin: "https://api.synthetic.invalid", allowedOrigins: ["https://app.synthetic.invalid"], configuration }, calls, forbidden };
}
function unavailable(work) {
  assert.throws(work, error => {
    assert.ok(error instanceof ApiFault);
    assert.equal(error.code, "SERVICE_UNAVAILABLE"); assert.equal(error.status, 503);
    assert.equal(error.message, "SERVICE_UNAVAILABLE"); assert.equal(error.cause, undefined);
    assert.ok(![error.stack, JSON.stringify(error)].join(" ").includes(secret));
    return true;
  });
}

for (const profile of ["native", "clerk"]) test(`prepared ${profile} options preserve explicit values without executing bindings`, () => {
  const { input, calls } = prepared(profile), output = createProductionOptions(input);
  assert.deepEqual(output, input); assert.notEqual(output, input);
  assert.equal(output.configuration.storage.pool, input.configuration.storage.pool);
  assert.equal(output.configuration.now, input.configuration.now);
  assert.equal(Object.isFrozen(input.configuration.storage.pool), false);
  assert.equal(Object.isFrozen(input.configuration), false);
  assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.configuration));
  assert.deepEqual(calls, []);
});
test("custom native loader/flusher and resolver remain opaque prepared ports", () => {
  const { input, calls, forbidden } = prepared(), staff = input.configuration.staff;
  delete staff.domain; staff.load = forbidden("load"); staff.flush = forbidden("flush"); staff.resolvePersons = forbidden("resolvePersons");
  const result = createProductionOptions(input);
  assert.equal(result.configuration.staff.load, staff.load); assert.equal(result.configuration.staff.flush, staff.flush);
  assert.equal(result.configuration.staff.resolvePersons, staff.resolvePersons); assert.deepEqual(calls, []);
});
test("class pool prototype method is accepted without construction or connect", () => {
  const { input, calls, forbidden } = prepared();
  class Pool { connect() { return forbidden("prototype.connect")(); } }
  input.configuration.storage.pool = new Pool();
  assert.equal(createProductionOptions(input).configuration.storage.pool, input.configuration.storage.pool);
  assert.deepEqual(calls, []);
});
test("Clerk no-audience policy and optional explicit legacy Telegram binding are preserved", () => {
  const { input, calls } = prepared("clerk");
  input.configuration.clerk.verifier.audience = { kind: "clerk_default_no_audience" };
  input.configuration.botToken = secret;
  const result = createProductionOptions(input);
  assert.deepEqual(result.configuration.clerk.verifier.audience, { kind: "clerk_default_no_audience" });
  assert.equal(result.configuration.botToken, secret); assert.deepEqual(calls, []);
});
test("plain data may use null prototypes; omitted optional bindings are not invented", () => {
  const { input } = prepared("clerk"); Object.setPrototypeOf(input.configuration, null);
  const result = createProductionOptions(input);
  assert.ok(!Object.hasOwn(result.configuration, "botToken")); assert.ok(!Object.hasOwn(result.configuration, "staff"));
  assert.deepEqual(Object.keys(result).sort(), ["allowedOrigins", "apiOrigin", "configuration"]);
});
test("copied settings remain stable after caller mutation while pool and functions stay opaque", () => {
  for (const profile of ["native", "clerk"]) {
    const { input } = prepared(profile), output = createProductionOptions(input), config = input.configuration;
    input.allowedOrigins.push("https://later.synthetic.invalid"); input.apiOrigin = "https://later.synthetic.invalid";
    config.sessionPolicy.accessTtlMs = 1; config.numericPresentation.policyId = "changed";
    config.now = () => 1; config.storage.kind = "postgres_contract_double";
    if (profile === "native") config.staff.jwt.algorithms.push("HS256");
    else { config.clerk.verifier.authorizedParties.push("https://later.synthetic.invalid"); config.clerk.verifier.audience.value = "changed"; }
    assert.equal(output.apiOrigin, "https://api.synthetic.invalid"); assert.equal(output.allowedOrigins.length, 1);
    assert.equal(output.configuration.sessionPolicy.accessTtlMs, 31000);
    assert.equal(output.configuration.numericPresentation.policyId, "synthetic-explicit-policy");
    assert.equal(output.configuration.storage.kind, "postgres"); assert.notEqual(output.configuration.now, config.now);
    if (profile === "native") assert.deepEqual(output.configuration.staff.jwt.algorithms, ["RS256", "ES256"]);
    else { assert.equal(output.configuration.clerk.verifier.authorizedParties.length, 1); assert.equal(output.configuration.clerk.verifier.audience.value, "synthetic-api"); }
    output.configuration.storage.pool.runtimeState = "driver-owned";
    assert.equal(config.storage.pool.runtimeState, "driver-owned");
  }
});

for (const [name, change] of [
  ["mode missing", c => delete c.mode], ["local mode", c => c.mode = "local_contract"],
  ["unknown mode", c => c.mode = "staging"], ["storage missing", c => delete c.storage],
  ["contract double", c => c.storage.kind = "postgres_contract_double"], ["storage factory", c => c.storage = () => ({})],
  ["pool missing", c => delete c.storage.pool], ["pool factory", c => c.storage.pool = () => ({ connect() {} })],
  ["pool Promise", c => c.storage.pool = Promise.resolve({ connect() {} })], ["pool malformed", c => c.storage.pool = {}],
  ["clock missing", c => delete c.now], ["clock scalar", c => c.now = 1000],
  ["bot token missing", c => delete c.botToken], ["bot token empty", c => c.botToken = ""],
  ["staff missing", c => delete c.staff], ["staff validator missing", c => delete c.staff.validate],
  ["staff ID factory missing", c => delete c.staff.newAssignmentId], ["staff liveness missing", c => delete c.staff.liveness],
  ["JWT missing", c => delete c.staff.jwt], ["JWT issuer", c => c.staff.jwt.issuer = "http://issuer.synthetic.invalid"],
  ["JWT audience", c => c.staff.jwt.audience = ""], ["JWT algorithms missing", c => delete c.staff.jwt.algorithms],
  ["JWT algorithm empty", c => c.staff.jwt.algorithms = []], ["JWT symmetric algorithm", c => c.staff.jwt.algorithms = ["HS256"]],
  ["JWT keys missing", c => delete c.staff.jwt.trustedKeys], ["JWT clock missing", c => delete c.staff.jwt.now],
  ["resolver invalid", c => c.staff.resolvePersons = true], ["domain invalid", c => c.staff.domain = "fixture"],
  ["relational with loader", c => c.staff.load = () => ({})], ["relational with flusher", c => c.staff.flush = () => {}],
  ["custom loader missing", c => { delete c.staff.domain; c.staff.flush = () => {}; }],
  ["custom flusher missing", c => { delete c.staff.domain; c.staff.load = () => ({}); }],
  ["policy missing", c => delete c.sessionPolicy], ["policy new-login missing", c => delete c.sessionPolicy.newLogin],
  ["policy keep sessions", c => c.sessionPolicy.newLogin = "keep_previous"],
  ["policy family relationship", c => c.sessionPolicy.familyTtlMs = c.sessionPolicy.accessTtlMs - 1],
  ["policy zero max age", c => c.sessionPolicy.initDataMaxAgeSeconds = 0],
  ["policy zero access", c => c.sessionPolicy.accessTtlMs = 0],
  ["policy zero attempts", c => c.sessionPolicy.identityCollisionAttempts = 0],
  ["policy unsafe number", c => c.sessionPolicy.futureSkewSeconds = Number.MAX_SAFE_INTEGER + 1],
  ["policy negative tombstone", c => c.sessionPolicy.logoutTombstoneMs = -1],
  ["numeric presentation missing", c => delete c.numericPresentation],
  ["numeric policy missing", c => delete c.numericPresentation.policyId],
  ["numeric policy empty", c => c.numericPresentation.policyId = ""],
  ...["toFiniteNumber", "toDisplayString", "toStudentPointsDisplayString"].map(key => ["numeric " + key, c => delete c.numericPresentation[key]]),
]) test(`fails closed: ${name}`, () => {
  const { input, calls } = prepared(); change(input.configuration);
  unavailable(() => createProductionOptions(input)); assert.deepEqual(calls, []);
});

for (const [name, change] of [
  ["ambiguous native staff", c => c.staff = prepared().input.configuration.staff],
  ["staff missing", c => delete c.clerk.staff], ["staff validator missing", c => delete c.clerk.staff.validate],
  ["staff ID factory missing", c => delete c.clerk.staff.newAssignmentId], ["verifier missing", c => delete c.clerk.verifier],
  ["liveness missing", c => delete c.clerk.liveness], ["issuer localhost", c => c.clerk.verifier.issuer = "https://localhost"],
  ["issuer with path", c => c.clerk.verifier.issuer += "/path"], ["parties empty", c => c.clerk.verifier.authorizedParties = []],
  ["parties duplicate", c => c.clerk.verifier.authorizedParties.push(c.clerk.verifier.authorizedParties[0])],
  ["party wildcard", c => c.clerk.verifier.authorizedParties = ["https://*.synthetic.invalid"]],
  ["keys missing", c => delete c.clerk.verifier.trustedKeys], ["clock missing", c => delete c.clerk.verifier.now],
  ["audience missing", c => delete c.clerk.verifier.audience],
  ["audience undecided", c => c.clerk.verifier.audience = { kind: "automatic" }],
  ["audience empty", c => c.clerk.verifier.audience.value = ""],
  ["no-audience ambiguous", c => c.clerk.verifier.audience = { kind: "clerk_default_no_audience", value: "unexpected" }],
  ["legacy token invalid", c => c.botToken = 7],
]) test(`Clerk fails closed: ${name}`, () => {
  const { input, calls } = prepared("clerk"); change(input.configuration);
  unavailable(() => createProductionOptions(input)); assert.deepEqual(calls, []);
});

for (const [name, change] of [
  ["origin missing", i => delete i.apiOrigin], ["origin HTTP", i => i.apiOrigin = "http://api.synthetic.invalid"],
  ["origin credentials", i => i.apiOrigin = "https://user:pass@api.synthetic.invalid"],
  ["origin path", i => i.apiOrigin += "/path"], ["origins missing", i => delete i.allowedOrigins],
  ["origins wildcard", i => i.allowedOrigins = ["*"]], ["origins localhost", i => i.allowedOrigins = ["https://127.0.0.1"]],
  ["configuration missing", i => delete i.configuration], ["unknown root binding", i => i.factory = () => ({})],
  ["unknown config binding", i => i.configuration.secretKey = secret],
]) test(`public/private boundary rejects ${name}`, () => {
  const { input, calls } = prepared(); change(input);
  unavailable(() => createProductionOptions(input)); assert.deepEqual(calls, []);
});

test("factories, Promises, thenables, accessors, proxies and coercion hooks are never evaluated", () => {
  let effects = 0;
  const hook = () => { effects++; throw Error(secret); };
  for (const replacement of [undefined, null, hook, Promise.resolve({}), { then: hook }, new Proxy({}, { ownKeys: hook, get: hook })]) {
    unavailable(() => createProductionOptions(replacement));
    const { input } = prepared(); input.configuration = replacement;
    unavailable(() => createProductionOptions(input));
  }
  for (const field of ["configuration", "allowedOrigins", "apiOrigin"]) {
    const { input } = prepared(); Object.defineProperty(input, field, { get: hook });
    unavailable(() => createProductionOptions(input));
  }
  for (const destination of ["apiOrigin", "clerkIssuer", "pool", "arrayIndex", "policy"]) {
    const { input } = prepared(destination === "clerkIssuer" ? "clerk" : "native");
    if (destination === "apiOrigin") input.apiOrigin = { toString: hook };
    if (destination === "clerkIssuer") input.configuration.clerk.verifier.issuer = { toString: hook };
    if (destination === "pool") Object.defineProperty(input.configuration.storage.pool, "connect", { get: hook });
    if (destination === "arrayIndex") Object.defineProperty(input.allowedOrigins, "0", { get: hook });
    if (destination === "policy") Object.defineProperty(input.configuration.sessionPolicy, "accessTtlMs", { get: hook });
    unavailable(() => createProductionOptions(input));
  }
  assert.equal(effects, 0);
});
test("partial arrays, extended arrays, symbols and non-data configuration records fail closed", () => {
  const cases = [i => i.allowedOrigins = Array(1), i => i.allowedOrigins.extra = secret,
    i => i.configuration[Symbol("private")] = secret, i => Object.setPrototypeOf(i.configuration, { inherited: true })];
  for (const change of cases) { const { input } = prepared(); change(input); unavailable(() => createProductionOptions(input)); }
});
function preparedArray(kind, length = 1) {
  const fixture = prepared(kind === "clerk parties" ? "clerk" : "native"), values = Array.from({ length }, (_, index) =>
    kind === "native algorithms" ? (index % 2 ? "ES256" : "RS256") : `https://app${index}.synthetic.invalid`);
  if (kind === "public origins") fixture.input.allowedOrigins = values;
  else if (kind === "native algorithms") fixture.input.configuration.staff.jwt.algorithms = values;
  else fixture.input.configuration.clerk.verifier.authorizedParties = values;
  return { ...fixture, values };
}
const arrayKinds = ["public origins", "native algorithms", "clerk parties"];
for (const kind of arrayKinds) test(`array keys: canonical indexes 0, 1 and 10 remain valid for ${kind}`, () => {
  const { input, values, calls } = preparedArray(kind, 11);
  assert.deepEqual(Reflect.ownKeys(values), [...Array.from({ length: 11 }, (_, index) => String(index)), "length"]);
  const result = createProductionOptions(input);
  const copied = kind === "public origins" ? result.allowedOrigins : kind === "native algorithms" ?
    result.configuration.staff.jwt.algorithms : result.configuration.clerk.verifier.authorizedParties;
  assert.deepEqual(copied, values); assert.notEqual(copied, values); assert.deepEqual(calls, []);
});
for (const key of ["00", "01", "+0", "-0", "0.0", "0e0", " 0", "0 ", "0\n", "0\r", "0\r\n", "0\u2028", "0\u2029", "0\nx", "0\0", "-1", "4294967295"])
  test(`array keys: extra noncanonical own key ${JSON.stringify(key)} is rejected`, () => {
    for (const kind of arrayKinds) {
      const { input, values, calls } = preparedArray(kind);
      Object.defineProperty(values, key, { value: secret, enumerable: true, configurable: true });
      assert.ok(Object.hasOwn(values, key)); assert.equal(values.length, 1);
      unavailable(() => createProductionOptions(input)); assert.deepEqual(calls, []);
    }
  });
test("array keys: trailing-line-terminator accessors are rejected without reading them", () => {
  let reads = 0;
  for (const kind of arrayKinds) for (const key of ["0\n", "0\r", "0\r\n", "0\u2028", "0\u2029"]) {
    const { input, values, calls } = preparedArray(kind);
    Object.defineProperty(values, key, { get() { reads++; throw Error(secret); }, enumerable: true });
    unavailable(() => createProductionOptions(input)); assert.deepEqual(calls, []);
  }
  assert.equal(reads, 0);
});
test("array keys: array proxies are rejected without executing traps", () => {
  let traps = 0;
  for (const kind of arrayKinds) {
    const fixture = preparedArray(kind), trap = () => { traps++; throw Error(secret); };
    const proxy = new Proxy(fixture.values, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    if (kind === "public origins") fixture.input.allowedOrigins = proxy;
    else if (kind === "native algorithms") fixture.input.configuration.staff.jwt.algorithms = proxy;
    else fixture.input.configuration.clerk.verifier.authorizedParties = proxy;
    unavailable(() => createProductionOptions(fixture.input)); assert.deepEqual(fixture.calls, []);
  }
  assert.equal(traps, 0);
});
test("assembly makes no network or Worker calls; tripwires have positive calibration", () => {
  const original = { fetch: globalThis.fetch, Worker: workers.Worker, connect: net.connect, createConnection: net.createConnection };
  const calls = [];
  const tripwire = name => function () { calls.push(name); throw Error("OFFLINE_TRIPWIRE"); };
  try {
    globalThis.fetch = tripwire("fetch"); workers.Worker = tripwire("Worker");
    net.connect = tripwire("net.connect"); net.createConnection = tripwire("net.createConnection"); syncBuiltinESMExports();
    assert.throws(() => globalThis.fetch("https://never.invalid"), /OFFLINE_TRIPWIRE/);
    assert.throws(() => new Worker("never-created"), /OFFLINE_TRIPWIRE/);
    assert.throws(() => net.connect(1), /OFFLINE_TRIPWIRE/);
    assert.throws(() => net.createConnection(1), /OFFLINE_TRIPWIRE/);
    assert.deepEqual(calls, ["fetch", "Worker", "net.connect", "net.createConnection"]); calls.length = 0;
    for (const profile of ["native", "clerk"]) {
      const fixture = prepared(profile); createProductionOptions(fixture.input); assert.deepEqual(fixture.calls, []);
    }
    assert.deepEqual(calls, []);
  } finally { globalThis.fetch = original.fetch; workers.Worker = original.Worker; net.connect = original.connect;
    net.createConnection = original.createConnection; syncBuiltinESMExports(); }
});
test("assembly never logs configuration on success or failure", () => {
  const names = ["log", "info", "warn", "error", "debug", "trace"], originals = new Map(names.map(name => [name, console[name]]));
  const calls = [];
  try {
    for (const name of names) console[name] = () => { calls.push(name); };
    console.log(secret); assert.deepEqual(calls, ["log"]); calls.length = 0;
    createProductionOptions(prepared().input); createProductionOptions(prepared("clerk").input);
    const { input } = prepared(); input.configuration.storage = { password: secret };
    unavailable(() => createProductionOptions(input)); assert.deepEqual(calls, []);
  } finally { for (const [name, method] of originals) console[name] = method; }
});
test("public OPTIONS success remains separate from private API readiness", async () => {
  const { input } = prepared(); delete input.configuration;
  unavailable(() => createProductionOptions(input));
  // Exercise the existing pure CORS seam, not a replacement configured factory.
  // Full Vercel factory integration requires its locked jose dependency separately.
  let calls = 0;
  const cors = withPublicCors(async () => { calls++; return new Response(null, { status: 503 }); }, input.allowedOrigins);
  const options = await cors(new Request(input.apiOrigin + "/api/v1/me", { method: "OPTIONS", headers: {
    origin: input.allowedOrigins[0], "access-control-request-method": "GET", "access-control-request-headers": "authorization" } }));
  assert.equal(options.status, 204); assert.equal(calls, 0);
  const api = await cors(new Request(input.apiOrigin + "/api/v1/me", { headers: { origin: input.allowedOrigins[0] } }));
  assert.equal(api.status, 503); assert.equal(calls, 1);
});
test("explicit empty browser allowlist denies browser origins without inventing an auth profile", async () => {
  const { input } = prepared(); input.allowedOrigins = [];
  const result = createProductionOptions(input); assert.deepEqual(result.allowedOrigins, []);
  let calls = 0; const cors = withPublicCors(async () => { calls++; return new Response(null); }, result.allowedOrigins);
  const response = await cors(new Request(result.apiOrigin + "/api/v1/me", { headers: { origin: "https://app.synthetic.invalid" } }));
  assert.equal(response.status, 403); assert.equal(calls, 0);
});
test("new assembler has only pure imports and no default entry or environment binding", () => {
  const source = readFileSync(new URL("../../runtime/production-options.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";/gm)].map(match => match[1]);
  assert.deepEqual(imports, ["node:util", "../supabase/functions/univeracademy-api/fault.ts",
    "../supabase/functions/univeracademy-api/student-state.ts", "./local-cors.mjs"]);
  assert.ok(!/process\.env|\bfetch\s*\(|new\s+Worker\b|createClerkSdkBindings|createVercelNodeEntrypoint/.test(source));
});
