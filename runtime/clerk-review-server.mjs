import { pathToFileURL } from "node:url";
import { startLocalServer } from "./local-server.mjs";
import { withLocalCors } from "./local-cors.mjs";
import { clerkFixture, users, sids } from "../tests/clerk-auth/fixture.mjs";
import { ids } from "../tests/backend/http-fixture.ts";
import { createLocalStudentClient, STUDENT_CONTRACT_SHA256 } from "../packages/api-client/student-client.ts";

// Synthetic fixture only: real verifier with ephemeral RSA keys + RAM liveness.
// There are no proof-issuing/control HTTP routes or real provider credentials.
export async function createClerkReviewLab({ now = Date.now } = {}) {
  const fixture = await clerkFixture({ now });
  const at = now();
  for (const assignment of Object.values(fixture.store.state.domain.student.assignments)) {
    assignment.admission.opensAt = at - 60_000;
    assignment.admission.closesAt = at + 3_600_000;
  }
  fixture.activate(users.student, sids.first);
  const actors = { existing: { userId: users.student, sessionId: sids.first },
    fresh: { userId: users.other, sessionId: "sess_FreshUngroupedB2" } };
  fixture.activate(actors.fresh.userId, actors.fresh.sessionId); // No identity mapping: new ungrouped student on exchange.
  return { ...fixture, ids, users, sids, actors, status: "PROVISIONAL / NOT ACCEPTED",
    client(baseUrl) {
      return createLocalStudentClient({ mode: "local_fixture", contractSha256: STUDENT_CONTRACT_SHA256,
        baseUrl, transport: request => fetch(request, { redirect: "error", credentials: "omit", cache: "no-store" }) });
    } };
}

export async function startClerkReviewServer({ port = 0, lab, allowedOrigins = [] } = {}) {
  lab ??= await createClerkReviewLab();
  const listener = await startLocalServer({ port, lab: {
    handler: withLocalCors(request => lab.handler(request), allowedOrigins),
  } });
  return { ...listener, lab };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const local = await startClerkReviewServer({ port: Number(process.argv[2] ?? 8797), allowedOrigins: process.argv.slice(3) });
  console.log(JSON.stringify({ status: "PROVISIONAL / NOT ACCEPTED", baseUrl: local.baseUrl,
    syntheticClerk: true, realProvider: false, durableDB: false, proofRoutes: false }));
  const stop = async () => { await local.close(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
