// Authenticated caller owns a PostgreSQL transaction and the canonical person lock.
import { createHash, randomUUID } from 'node:crypto';
import { fail } from '../supabase/functions/univeracademy-api/fault.ts';
import { startAttempt, studentView, saveAnswer, submitAttempt } from '../supabase/functions/univeracademy-api/attempts.ts';
import { AttemptRows, decodePublished } from '../supabase/functions/univeracademy-api/storage/attempt-rows.ts';
import { canonicalPersonId } from '../supabase/functions/univeracademy-api/storage/trusted-server-context.ts';
import { blocksWire, candidateHalfUp2, studentPointsHalfUp1 } from '../supabase/functions/univeracademy-api/student-wire.ts';

export class CommittedAttemptError {
  constructor(error) { this.error = error; }
}
export function stagingOrdinaryScore(score) {
  return { earned:studentPointsHalfUp1(score.earned),maximum:studentPointsHalfUp1(score.maximum),percentage:candidateHalfUp2(score.percentage) };
}
const attemptRows = new AttemptRows();
function id(value) {
  if (!canonicalPersonId(value)) fail('VALIDATION_ERROR',422);
  return value;
}
const ask = (tx,text,values=[]) => tx.client.query({text,values});
function displayBlocks(blocks) {
  return blocks.filter(b=>b.type === 'text').map(b=>b.markdown).join(' ');
}
function projectAttempt(record, assignment) {
  const images = asset_id => ({asset_id,url:'/api/v1/student/pilot/media/'+asset_id,
    content_type:'image/png',expires_at:new Date(record.deadlineAt).toISOString()});
  const version = assignment.published;
  if (version.versionId !== record.published.versionId) fail('RESPONSE_INVARIANT_FAILED',500);
  const active=record.status==='in_progress';
  const questions=active ? record.questionOrder.map(({questionId,optionIds})=>{
    const source=assignment.contents[questionId];
    if (!source) fail('RESPONSE_INVARIANT_FAILED',500);
    const prompt_blocks=blocksWire(source.prompt,images);
    const options=optionIds.map(id=>{
      if (!source.options[id]) fail('RESPONSE_INVARIANT_FAILED',500);
      const blocks=blocksWire(source.options[id],images);
      return {id,text:displayBlocks(blocks),blocks};
    });
    return {id:questionId,text:displayBlocks(prompt_blocks),prompt_blocks,options};
  }) : [];
  return {id:record.id,status:record.status,deadlineAt:new Date(record.deadlineAt).toISOString(),questions,
    answers:active ? record.answers.map(a=>({questionId:a.questionId,optionId:a.selectedOptionId,revision:a.revision})) : []};
}
export async function runStagingAttempt(tx,actor,action,input,key) {
  const shapes={startAttempt:['assignmentId'],resumeAttempt:['attemptId'],submitAttempt:['attemptId'],
    saveAnswer:['attemptId','questionId','optionId','expectedRevision']};
  if (!(action in shapes) || Object.keys(input).sort().join(',')!==[...shapes[action]].sort().join(',')) fail('VALIDATION_ERROR',422);
  const person=actor.personId;
  const start=action==='startAttempt',saving=action==='saveAnswer',isRead=action==='resumeAttempt';
  let assignmentId;
  if (start) assignmentId=id(input.assignmentId);
  else {
    const row=(await ask(tx,'SELECT assignment_id FROM ua_private.attempts WHERE id=$1 AND person_id=$2',[id(input.attemptId),person])).rows[0];
    if (!row) fail('NOT_FOUND',404);
    assignmentId=row.assignment_id;
  }
  if (saving) {
    id(input.questionId);
    if (input.optionId!==null) id(input.optionId);
    if (!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0) fail('VALIDATION_ERROR',422);
  }
  const row=(await ask(tx,`SELECT a.record,a.demo_id,a.group_id,a.version_id,p.profile,m.epoch,m.active,m.affinity_group_id,
    g.grant_epoch,g.rostered FROM ua_private.assignments a JOIN ua_cabinet.group_requests own ON own.active_group_id=a.group_id
    JOIN ua_private.groups gr ON gr.id=a.group_id AND gr.status='active'
    JOIN ua_private.grants g ON g.assignment_id=a.id AND g.person_id=$2
    JOIN ua_private.memberships m ON m.person_id=$2 JOIN ua_private.people p ON p.id=$2
    WHERE a.id=$1 AND p.enabled AND 'student'=ANY(p.roles)
    FOR SHARE OF a,g,gr,m`,[assignmentId,person])).rows[0];
  if (!row) fail('NOT_FOUND',404);
  if (!row.active||!row.rostered||row.affinity_group_id!==row.group_id||String(row.epoch)!==String(row.grant_epoch)||row.record.cancelled)
    fail('EXAM_ACCESS_REVOKED',403);
  if (!row.profile?.registration_complete) fail('PROFILE_INCOMPLETE',409);
  const assignment=row.record, published=decodePublished(assignment.published);
  if (published.demoId!==row.demo_id||published.versionId!==row.version_id||assignment.admission.assignmentId!==assignmentId||
      assignment.admission.groupId!==row.group_id) fail('RESPONSE_INVARIANT_FAILED',500);
  const series=(await ask(tx,'SELECT current_attempt_id,generation FROM ua_private.exam_series WHERE person_id=$1 AND demo_id=$2 FOR UPDATE',[person,row.demo_id])).rows[0];
  const existing=series?await attemptRows.load(tx,person,series.current_attempt_id):null;
  if (!start && (!existing||existing.id!==input.attemptId)) fail('ATTEMPT_SUPERSEDED',409);
  const current=series&&{id:series.current_attempt_id,generation:Number(series.generation)};
  const clock=(await ask(tx,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now')).rows[0];
  const now=Number(clock.now);
  if (!Number.isSafeInteger(now)||now<tx.now) fail('SERVICE_UNAVAILABLE',503);
  const access={proofKind:'student_session',personId:person,enabled:true,assignmentIds:[assignmentId]};
  const receiptKey=person+'/cabinet/v1/'+createHash('sha256').update(key??'').digest('hex');
  const signature=JSON.stringify([action,...shapes[action].map(k=>input[k])]);
  const receipt=isRead?null:(await ask(tx,'SELECT payload,attempt_id FROM ua_private.command_receipts WHERE person_id=$1 AND key=$2',[person,receiptKey])).rows[0];
  let prior;
  if (receipt) {
    prior=JSON.parse(receipt.payload);
    if (prior.signature!==signature) fail('IDEMPOTENCY_CONFLICT',409);
    if (!existing || receipt.attempt_id!==existing.id) fail('ATTEMPT_SUPERSEDED',409);
  }
  let next, value;
  if (start) {
    next=prior?studentView(access,existing,current,now).record:startAttempt({access,admission:{...assignment.admission,
      activeGroupId:row.affinity_group_id,rostered:true,profileComplete:true,membershipEpoch:Number(row.epoch),grantEpoch:Number(row.grant_epoch)},
      published,existing,id:randomUUID(),confirmed:true,now});
  } else if (isRead) next=studentView(access,existing,current,now).record;
  else if (saving) {
    if (prior) {
      next=studentView(access,existing,current,now).record;
      value=prior.answer;
    } else {
      const result=saveAnswer(access,existing,current,input.questionId,{selected_option_id:input.optionId,expected_revision:input.expectedRevision},now);
      next=result.record;
      if (!result.response.ok) {
        await attemptRows.persist(tx,existing,next);
        return new CommittedAttemptError(result.response.error);
      }
      const answer=result.response.value;
      value={questionId:answer.questionId,optionId:answer.selectedOptionId,revision:answer.revision};
    }
  } else {
    next=submitAttempt(access,existing,current,now).record;
    value=stagingOrdinaryScore(next.ordinary);
  }
  if (existing) await attemptRows.persist(tx,existing,next);
  else {
    await attemptRows.insert(tx,next);
    await ask(tx,`INSERT INTO ua_private.exam_series(person_id,demo_id,id,current_attempt_id,generation,state_revision,normal_attempt_used,official_attempt_id,recovery_state,recovery_window)
      VALUES($1,$2,$3,$4,1,1,true,NULL,'none',NULL)`,[person,row.demo_id,randomUUID(),next.id]);
  }
  if (!isRead && !prior) await ask(tx,'INSERT INTO ua_private.command_receipts(person_id,key,payload,attempt_id) VALUES($1,$2,$3,$4)',[
    person,receiptKey,JSON.stringify({signature,...(saving?{answer:value}:{})}),next.id]);
  return value??projectAttempt(next,assignment);
}
