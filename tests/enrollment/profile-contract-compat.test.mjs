import test from "node:test";
import assert from "node:assert/strict";
import { clerkFixture, sids, users, uiOrigin } from "../clerk-auth/fixture.mjs";
import { createProductionStudentClient, STUDENT_CONTRACT_SHA256 } from "../../packages/api-client/student-client.ts";
import { createProductionTelegramAtomicClient, TELEGRAM_ATOMIC_CONTRACT_SHA256 } from "../../packages/api-client/telegram-atomic-client.ts";
import { studentResponse } from "../../supabase/functions/univeracademy-api/student-response.ts";
import { createTelegramClerkEntryHttp } from "../../runtime/telegram-clerk-entry-http.mjs";

const baseUrl = "https://api.example.com/api/v1";
const canonicalId = "0100000001";

function checkProfile(profile, current) {
  const common = ["person_id", "first_name", "last_name", "roles", "registration_complete", "active_group_id"];
  const id = current ? "univeracademy_id" : "qadam_id";
  assert.deepEqual(Object.keys(profile).sort(), [...common, id].sort());
  assert.equal(profile[id], canonicalId);
}

test("an existing session moves between old and current clients without changing the ID", async () => {
  const f = await clerkFixture();
  f.activate(users.student, sids.first);
  const old = await f.handler(new Request(baseUrl + "/auth/clerk", {
    method: "POST", headers: { authorization: "Bearer " + await f.sign(), "content-type": "application/json" }, body: "{}"
  }));
  assert.equal(old.status, 200);
  assert.equal(old.headers.get("vary"), "Accept");
  const { data: session } = await old.json();
  checkProfile(session.profile, false);
  const client = createProductionStudentClient({ mode: "production", baseUrl, contractSha256: STUDENT_CONTRACT_SHA256, transport: f.handler });
  const { data: edited } = await client.updateProfile(session.access_token, { first_name: "Dilnoza", last_name: "Saidova" });
  checkProfile(edited, true);
  const refreshed = await f.handler(new Request(baseUrl + "/auth/refresh", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  }));
  assert.equal(refreshed.status, 200);
  const { data: next } = await refreshed.json();
  checkProfile(next.profile, false);
  assert.equal(next.profile.first_name, "Dilnoza");
  assert.equal(next.profile.person_id, edited.person_id);
  checkProfile((await client.me(next.access_token)).data, true);
});

test("atomic Telegram entry negotiates the exact Profile shape with the client", async () => {
  const f = await clerkFixture();
  f.activate(users.student, sids.first);
  const { data: session } = await f.client.exchangeClerkSession(await f.sign());
  const handler = createTelegramClerkEntryHttp({ enabled: true, verifier: f.verifier, allowedOrigins: [uiOrigin],
    entry: { enter: async () => session } });
  const payload = { init_data: "signed-telegram-fixture", confirmation: "link-telegram-account-v1" };
  const token = await f.sign({ claims: { fva: [0, -1] } });
  const old = await handler(new Request(baseUrl + "/auth/telegram/entry", { method: "POST",
    headers: { authorization: "Bearer " + token, accept: "application/json", "content-type": "application/json", origin: uiOrigin },
    body: JSON.stringify(payload) }));
  assert.equal(old.status, 200);
  assert.equal(old.headers.get("vary"), "Origin, Accept");
  checkProfile((await old.json()).data.profile, false);
  const client = createProductionTelegramAtomicClient({ mode: "production", baseUrl, contractSha256: TELEGRAM_ATOMIC_CONTRACT_SHA256,
    transport: async request => {
      const headers = new Headers(request.headers);
      headers.set("origin", uiOrigin);
      const response = await handler(new Request(request, { headers }));
      assert.match(response.headers.get("content-type"), /profile=univeracademy-id-v2/);
      return response;
    } });
  checkProfile((await client.enter(token, payload)).data.profile, true);
});

// Typical generators include plain JSON for Error responses in the same Accept list.
test("a generated client can advertise both JSON representations", async () => {
  const profile = { univeracademy_id: canonicalId };
  for (const [accept, current] of [
    ['application/json; profile="univeracademy-id-v2", application/json', true],
    ["application/json, application/json; profile=univeracademy-id-v2;q=0.2", false],
    ["application/json; profile=univeracademy-id-v2;q=0", false],
    ["*/*", false]
  ]) {
    const request = new Request(baseUrl + "/me", { headers: { accept } });
    const { data } = await studentResponse(request, profile).json();
    assert.deepEqual(data, { [current ? "univeracademy_id" : "qadam_id"]: canonicalId });
  }
});
