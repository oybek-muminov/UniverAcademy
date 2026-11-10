import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ungroupedLaunch } from "./ungrouped-fixture.mjs";

export async function addUngroupedStudent(run, transport = fetch) {
  const url = new URL(run.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/api/v1" || url.search || url.hash || url.username || url.password)
    throw Error("LOOPBACK_API_ONLY");
  const call = async (method, path, body, step, token, expected) => {
    const reply = await transport(run.baseUrl + path, { method, headers: { authorization: "Bearer " + token,
      "content-type": "application/json", "idempotency-key": `ungrouped:${run.run_id}:${step}` }, body: JSON.stringify(body) });
    const json = await reply.json();
    if (reply.status !== expected) throw Error(`STAFF_STEP_FAILED:${step}:${reply.status}:${json.error?.code ?? "UNKNOWN"}`);
    return json.data;
  };
  const f = run.fixture;
  await call("PUT", `/admin/groups/${f.groupId}/members`, { student_id: f.studentId,
    status: "active", ...run.membership }, "membership", "synthetic-admin-proof", 200);
  const assignment = await call("POST", "/admin/assignments", { demo_id: f.demoId, version_id: f.versionId,
    group_id: f.groupId, ...run.schedule, timezone: "Asia/Tashkent", review_policy: "teacher_approval",
    student_ids: [f.studentId], reminder_lead_seconds: null }, "assignment", "synthetic-admin-proof", 201);
  if (assignment.id !== f.assignmentId) throw Error("SYNTHETIC_ASSIGNMENT_ID_MISMATCH");
  return { stage: "staff_added", confirmed: true, assignmentId: assignment.id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, runPath, browserUrl, width, screenshotDir] = process.argv.slice(2);
    const run = JSON.parse(readFileSync(runPath, "utf8"));
    const result = action === "launch" ? ungroupedLaunch(run, { url: browserUrl, width: width ? Number(width) : 390,
      ...(screenshotDir ? { screenshotDir } : {}) }) : action === "staff-add" ? await addUngroupedStudent(run) : null;
    if (!result) throw Error("ACTION_MUST_BE_LAUNCH_OR_STAFF_ADD");
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
