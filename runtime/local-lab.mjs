import { createStudentHttpHandler } from "../supabase/functions/univeracademy-api/student-http.ts";
import { TransactionFixture, botKey, ids, signedInitData, testNumbers }
  from "../tests/backend/http-fixture.ts";

export const LOCAL_CANDIDATE_POLICY = Object.freeze({
  initDataMaxAgeSeconds: 300, futureSkewSeconds: 30,
  accessTtlMs: 900_000, familyTtlMs: 43_200_000, logoutTombstoneMs: 86_400_000,
  identityCollisionAttempts: 4, newLogin: "revoke_previous",
});

export function syntheticLoginInput() {
  return { init_data: signedInitData(4_000_000_001, crypto.randomUUID(), Date.now()) };
}

export function createSyntheticPhysicsLab() {
  // ponytail: reuse the tested RAM fixture/global lock; durable scoped DB remains pending.
  const store = new TransactionFixture(Date.now);
  const assignment = store.state.assignments[ids.assignment];
  assignment.admission.opensAt = Date.now() - 60_000;
  assignment.admission.closesAt = Date.now() + 3_600_000;
  assignment.published.durationMs = 300_000;
  assignment.title = "Fizika — faqat sintetik lokal test";
  assignment.instructions = [{ type: "text", markdown:
    "Ikki sun’iy savol. Bitta urinish; ma’lumot faqat RAMda. Bu haqiqiy imtihon emas." }];
  store.state.people[ids.person].profile.registration_complete = false;
  const prompts = [
    ["Massasi 2 kg jism 3 m/s² tezlanadi. Kuch qancha?", ["6 N", "4 N", "5 N", "8 N"]],
    ["Jism 20 metrni 4 soniyada bosib o‘tdi. O‘rtacha tezlik qancha?", ["5 m/s", "4 m/s", "6 m/s", "8 m/s"]],
  ];
  for (const [i, question] of assignment.published.questions.entries()) {
    assignment.contents[question.id] = {
      prompt: [{ type: "text", markdown: prompts[i][0] }],
      options: Object.fromEntries(question.optionIds.map((id, j) =>
        [id, [{ type: "text", markdown: prompts[i][1][j] }]])),
    };
  }
  const numericPresentation = Object.freeze({ ...testNumbers,
    policyId: "APPROVED_STUDENT_POINTS_HALF_UP1_PERCENTAGE2_CANDIDATE" });
  const handler = createStudentHttpHandler({ transactions: store, botToken: botKey,
    sessionPolicy: LOCAL_CANDIDATE_POLICY, numericPresentation });
  return { store, handler };
}
