import { createUngroupedLab } from "./ungrouped-lab.mjs";
import { id } from "../tests/backend/http-fixture.ts";
import { staffIds } from "../tests/backend/staff-fixture.ts";

// Staff-side synthetic authoring plan. Never returned to the student browser.
export function contentPilotPlan() {
  // Equal exact weights keep the one-answer fixture expectation stable even
  // when the server shuffles question order for the student.
  const questions = ["0.125", "0.125"].map((points, index) => ({
    id: id(300 + index), position: index + 1, expected_revision: 3 + index,
    prompt_blocks: [{ type: "text", markdown: `Yangi sintetik fizika ${index + 1}` }],
    options: [0, 1, 2, 3].map((n) => ({ id: id(600 + index * 4 + n),
      blocks: [{ type: "text", markdown: `Yangi ${"ABCD"[n]}` }] })),
    correct_option_id: id(600 + index * 4), individual_points: points,
    explanation_blocks: [{ type: "text", markdown: "Faqat sintetik staff izohi" }],
  }));
  return { questions, metadata: { expected_revision: 5, duration_seconds: 420,
    instructions_blocks: [{ type: "text", markdown: "HTTP orqali nashr qilingan yangi sintetik test." }],
    grading_config: { individual_enabled: true } },
    publish: { expected_revision: 6, reason: "Local synthetic HTTP publication" } };
}

export function createContentPilotLab(options = {}) {
  const lab = createUngroupedLab(options), state = lab.store.state;
  const draft = state.versions[staffIds.draft];
  draft.questionIds = [];
  state.versions = { [staffIds.draft]: draft };
  state.student.assignments = {}; // No ready assignment/template or seed published version.
  state.demos = { [draft.wire.demo_id]: { title: "Fizika — yangi HTTP publish sinovi", subjectId: "physics" } };
  lab.run = { ...lab.run, mode: "LOCAL_CONTENT_PILOT_SYNTHETIC_ONLY",
    fixture: { ...lab.run.fixture, versionId: staffIds.draft, answerLabel: "Yangi A",
      expectedDisplay: { earned_points: "0.1", max_points: "0.3", percentage: "50.00" } },
    publishedVersionSeeded: false, demoAndEmptyDraftSeeded: true };
  return lab;
}
