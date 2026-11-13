import './verify-backend-targets.mjs';
import { createSyntheticPhysicsLab } from '../../../runtime/local-lab.mjs';
import { ids } from '../../../tests/backend/http-fixture.ts';
import { parseIndividualQuestionPoints } from '../../../supabase/functions/univeracademy-api/individual-points.ts';

// Test-only RAM setup. No Backend source/policy is changed. The owner's exact
// question parser supplies one synthetic published question; its server grades it.
export function numericLab(input) {
  const lab = createSyntheticPhysicsLab();
  const assignment = lab.store.state.assignments[ids.assignment];
  assignment.instructions = [{ type: 'text', markdown: 'Bitta sun’iy savol. Raqam ko‘rinishi sinovi.' }];
  const published = assignment.published;
  published.individualEnabled = true;
  const question = published.questions.find(question => question.id === ids.question);
  published.questions = [{ ...question, individualPoints: parseIndividualQuestionPoints(input) }];
  return lab;
}
