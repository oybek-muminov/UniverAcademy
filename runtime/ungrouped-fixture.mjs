import { signedInitData, ids, id } from "../tests/backend/http-fixture.ts";
import { staffIds } from "../tests/backend/staff-fixture.ts";
import { isProtectedNextMidnight } from "../supabase/functions/univeracademy-api/pilot-provisioning.ts";

export const UNGROUPED = Object.freeze({ studentId: ids.other, telegramId: 4_000_000_002,
  groupId: staffIds.targetGroup, assignmentId: id(60), demoId: ids.demo, versionId: ids.version,
  answerLabel: "Sintetik A", expectedDisplay: Object.freeze({ earned_points: "1.0", max_points: "2.0", percentage: "50.00" }) });

export function ungroupedSchedule(now) {
  // The fixture explicitly selects today's Tashkent date; the API never invents a classroom close.
  const opensAt = Math.floor(now / 1000) * 1000;
  let closesAt = Math.ceil((opensAt + 1) / 3_600_000) * 3_600_000;
  const end = closesAt + 25 * 3_600_000;
  while (closesAt < end && !isProtectedNextMidnight(opensAt, closesAt, "Asia/Tashkent")) closesAt += 3_600_000;
  if (closesAt === end) throw Error("SYNTHETIC_SCHEDULE_UNAVAILABLE");
  return { opens_at: new Date(opensAt).toISOString(), closes_at: new Date(closesAt).toISOString() };
}

export function ungroupedLaunch(run, { url = "http://127.0.0.1:5198/", width = 390,
  screenshotDir = "/tmp/ua-ungrouped-evidence", now = Date.now() } = {}) {
  const browser = new URL(url);
  if (browser.protocol !== "http:" || browser.hostname !== "127.0.0.1" || !Number.isSafeInteger(width) || width <= 0) throw Error("LOCAL_BROWSER_ARGUMENTS_REQUIRED");
  return { url, width, initData: signedInitData(UNGROUPED.telegramId, crypto.randomUUID(), now),
    assignmentId: run.fixture.assignmentId, answerLabel: run.fixture.answerLabel,
    expectedDisplay: run.fixture.expectedDisplay, screenshotDir };
}
