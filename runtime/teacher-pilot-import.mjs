// Local import envelope; validated questions use the existing staff write schema.
import { randomUUID } from 'node:crypto';
import { fail } from '../supabase/functions/univeracademy-api/fault.ts';
import { writeDraftQuestion } from '../supabase/functions/univeracademy-api/staff-content.ts';
import { validate } from '../tests/backend/staff-fixture.ts';
import { validatePilotFormulas } from './teacher-local-ui/validate-formula.mjs';

const blocks = markdown => [{ type: 'text', markdown }];
export function cleanText(value, maximum, code = 'VALIDATION_ERROR') {
  if (typeof value !== 'string' || !value.trim() || [...value].length > maximum ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) fail(code, 422);
  return value.trim();
}
function exact(input, keys) {
  return input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => keys.includes(key));
}
export function verifyTeacherImage(state, staff, id) {
  const asset=state.pilot.media[id];
  if (!asset || asset.teacherPersonId!==staff.personId) fail('INVALID_TEST_FILE',422);
}
function importQuestion(input, index) {
  let question;
  if (exact(input, ['text','options','correctIndex'])) {
    if (!Array.isArray(input.options) || input.options.length !== 4 || !Number.isInteger(input.correctIndex) ||
        input.correctIndex < 0 || input.correctIndex > 3) fail('INVALID_TEST_FILE',422);
    const options = input.options.map(value => ({id:randomUUID(),blocks:blocks(cleanText(value,4000,'INVALID_TEST_FILE'))}));
    question = {id:randomUUID(),position:index+1,expected_revision:0,
      prompt_blocks:blocks(cleanText(input.text,4000,'INVALID_TEST_FILE')),options,correct_option_id:options[input.correctIndex].id,
      explanation_blocks:[]};
  } else {
    if (!input || typeof input !== 'object') fail('INVALID_TEST_FILE',422);
    const supplied = {...input,expected_revision:0};
    if (!validate('QuestionWrite',supplied) || new Set(supplied.options.map(o=>o.id)).size !== 4) fail('INVALID_TEST_FILE',422);
    const correct = supplied.options.findIndex(o=>o.id === supplied.correct_option_id);
    if (correct < 0) fail('INVALID_TEST_FILE',422);
    const options = supplied.options.map(o=>({...o,id:randomUUID()}));
    question = {...supplied,id:randomUUID(),options,correct_option_id:options[correct].id};
  }
  if (!validate('QuestionWrite', question)) fail('INVALID_TEST_FILE',422);
  return question;
}
export function importDraft(state, staff, input, now) {
  if (!exact(input,['title','duration_seconds','questions','instructions_blocks','grading_config']) ||
      !Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > 200) fail('INVALID_TEST_FILE',422);
  const title=cleanText(input.title,160,'INVALID_TEST_FILE'), duration=input.duration_seconds ?? 1800;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 86400) fail('INVALID_TEST_FILE',422);
  const id=randomUUID(), demo=randomUUID();
  const wire={id,demo_id:demo,version_no:1,duration_seconds:duration,
    instructions_blocks:input.instructions_blocks ?? blocks('Har bir savolga bitta javobni tanlang.'),
    status:'draft',revision:0,grading_config:input.grading_config ?? {individual_enabled:false}};
  if (!validate('Version',wire)) fail('INVALID_TEST_FILE',422);
  for (const block of wire.instructions_blocks) {
    if (block.type==='image') verifyTeacherImage(state,staff,block.asset_id);
  }
  const questions=input.questions.map(importQuestion);
  validatePilotFormulas(questions,wire.instructions_blocks);
  const positions=new Set();
  for (const q of questions) {
    if (positions.has(q.position) || wire.grading_config.individual_enabled && q.individual_points == null) fail('INVALID_TEST_FILE',422);
    positions.add(q.position);
  }
  const record={wire,subjectId:'physics',teacherPersonId:staff.personId,questionIds:[]};
  state.demos[demo]={title,subjectId:'physics'};
  state.versions[id]=record;
  for (const question of questions) {
    const q={...question,expected_revision:record.wire.revision};
    writeDraftQuestion(state,record,q,'pilot-question/'+id+'/'+q.id,JSON.stringify(q),staff.personId,now,assetId=>verifyTeacherImage(state,staff,assetId));
  }
  return record;
}
