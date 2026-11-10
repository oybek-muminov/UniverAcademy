import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { contentPilotPlan } from "./content-pilot-lab.mjs";

function staffCall(run, transport) {
  const url = new URL(run.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/api/v1" ||
      url.search || url.hash || url.username || url.password) throw Error("LOOPBACK_API_ONLY");
  return async (method, path, body, step, role, expected) => {
    const reply = await transport(run.baseUrl + path, { method, headers: {
      authorization: "Bearer " + role, "content-type": "application/json",
      "idempotency-key": `content:${run.run_id}:${step}` }, body: JSON.stringify(body) });
    const json = await reply.json();
    if (reply.status !== expected) throw Error(`STAFF_STEP_FAILED:${step}:${reply.status}:${json.error?.code ?? "UNKNOWN"}`);
    return json.data;
  };
}

export async function publishContentPilot(run, transport = fetch) {
  const call = staffCall(run, transport), plan = contentPilotPlan(), path = `/admin/versions/${run.fixture.versionId}`;
  // Commands retain their original CAS payloads across retries; receipt replay
  // returns the current Version without turning publication into a draft edit.
  for (const q of plan.questions) await call("PUT", `${path}/questions/${q.id}`, q,
    `question:${q.id}`, "synthetic-teacher-proof", 200);
  await call("PATCH", path, plan.metadata, "metadata", "synthetic-teacher-proof", 200);
  const version = await call("POST", `${path}/publish`, plan.publish, "publish", "synthetic-teacher-proof", 200);
  if (version.status !== "published" || version.id !== run.fixture.versionId || version.demo_id !== run.fixture.demoId)
    throw Error("SYNTHETIC_PUBLISHED_VERSION_MISMATCH");
  return version;
}

export async function assignContentPilot(run, publishedVersion, transport = fetch) {
  if (publishedVersion.status !== "published" || publishedVersion.id !== run.fixture.versionId ||
      publishedVersion.demo_id !== run.fixture.demoId) throw Error("HTTP_PUBLISHED_VERSION_REQUIRED");
  const call = staffCall(run, transport), f = run.fixture;
  await call("PUT", `/admin/groups/${f.groupId}/members`, { student_id: f.studentId, status: "active",
    ...run.membership }, "membership", "synthetic-admin-proof", 200);
  const assignment = await call("POST", "/admin/assignments", { demo_id: publishedVersion.demo_id,
    version_id: publishedVersion.id, group_id: f.groupId, ...run.schedule,
    timezone: "Asia/Tashkent", review_policy: "teacher_approval", student_ids: [f.studentId], reminder_lead_seconds: null },
    "assignment", "synthetic-admin-proof", 201);
  if (assignment.id !== f.assignmentId || assignment.version_id !== publishedVersion.id)
    throw Error("SYNTHETIC_ASSIGNMENT_VERSION_MISMATCH");
  return { stage: "staff_added", confirmed: true, assignmentId: assignment.id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const run = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const published = await publishContentPilot(run);
    console.log(JSON.stringify({ ...await assignContentPilot(run, published), publishedVersionId: published.id }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
