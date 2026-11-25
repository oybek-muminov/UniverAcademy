import { studentDirectoryPageSize } from './teacher-student-directory.mjs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fail} from '../supabase/functions/univeracademy-api/fault.ts';
import {parseTeacherTestText} from './teacher-pilot-text-import.mjs';
import {cleanText,editableDraft,requireEditable} from './teacher-pilot-import.mjs';
import {query,need,needId,groupView,createDraft,saveDraft,publish,assign,preview,ownedTest,requireOwnedTest} from './teacher-staging-content.mjs';
import {dashboard,expireVisible} from './teacher-staging-dashboard.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const actions={teacher:new Set(['dashboard','previewText','availableStudents','createGroup','addMember','removeMember','createInvite','sendInvite','importTest','readDraft','updateDraft','previewTest','publishTest','assignTest','readMedia','putMedia','requestAccountDeletion']),
 student:new Set(['dashboard','acceptInvite','startAttempt','saveAnswer','submitAttempt','resumeAttempt','readMedia']),admin:new Set(['dashboard','approveGroup']),owner:new Set(['dashboard'])};
const attemptActions=new Set(['startAttempt','saveAnswer','submitAttempt','resumeAttempt']);
function canonical(v){return JSON.stringify(v,(_,x)=>x && typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);}
async function actorFor(tx,{personId,role}){
  if(!Object.hasOwn(actions,role))fail('FORBIDDEN',403);
  needId(personId);
  if(role==='student'){
    const p=(await query(tx,'SELECT enabled,roles,profile,univeracademy_id FROM ua_private.people_registration WHERE id=$1',[personId]))[0];
    if(!p?.enabled||!p.roles.includes(role))fail('FORBIDDEN',403);
    if(!p.profile.registration_complete)fail('PROFILE_INCOMPLETE',409);
    return {personId,role,roles:p.roles,enabled:true,profile:p.profile,cabinetId:p.univeracademy_id};
  }
  if(role==='owner'){
    const [profile]=await query(tx,`SELECT p.profile->>'first_name' AS first_name,p.profile->>'last_name' AS last_name
      FROM ua_private.people_registration p JOIN ua_private.staff_access a ON a.person_id=p.id
      WHERE p.id=$1 AND p.enabled AND 'owner'=ANY(p.roles) AND a.approved FOR SHARE OF a`,[personId]);
    if(!profile)fail('FORBIDDEN',403);
    return {personId,role,profile};
  }
  // The current request still locks each live authorization row, including subject and group grants.
  const s=(await query(tx,`WITH staff AS MATERIALIZED (
      SELECT p.id,p.roles,p.profile,p.univeracademy_id,a.all_groups,a.all_subjects
      FROM ua_private.people_registration p JOIN ua_private.staff_access a ON a.person_id=p.id
      WHERE p.id=$1 AND p.enabled AND $2=ANY(p.roles) AND a.approved AND ($2<>'admin' OR a.manage_roster)
      FOR SHARE OF a
    )
    SELECT s.roles,s.profile,s.univeracademy_id,s.all_groups,s.all_subjects,
      EXISTS(SELECT 1 FROM ua_private.staff_audit WHERE actor_id=s.id AND action='requestAccountDeletion') AS deletion_requested,
      ARRAY(SELECT subject_id FROM ua_private.teacher_subject_approvals WHERE person_id=s.id AND approved AND revoked_at_ms IS NULL ORDER BY subject_id FOR SHARE) AS approved_subjects,
      ARRAY(SELECT group_id FROM ua_private.staff_group_scope WHERE person_id=s.id AND revoked_at_ms IS NULL ORDER BY group_id FOR SHARE) AS group_ids,
      ARRAY(SELECT subject_id FROM ua_private.staff_subject_scope WHERE person_id=s.id AND revoked_at_ms IS NULL ORDER BY subject_id FOR SHARE) AS subject_ids
    FROM staff s`,[personId,role]))[0];
  if(!s)fail('FORBIDDEN',403);
  const actor={personId,role,roles:s.roles,enabled:true,approved:true,profile:s.profile,cabinetId:s.univeracademy_id,deletionRequested:s.deletion_requested,
    approvedSubjectIds:s.approved_subjects,scope:{all_groups:s.all_groups,all_subjects:s.all_subjects,group_ids:s.group_ids,subject_ids:s.subject_ids}};
  if(role==='teacher'&&!actor.approvedSubjectIds.length)fail('FORBIDDEN',403);
  return actor;
}
function subjectFor(actor,id){
  if(id===undefined && actor.approvedSubjectIds.length!==1)fail('SUBJECT_REQUIRED',422);
  const subject=id??actor.approvedSubjectIds[0];
  if(!actor.approvedSubjectIds.includes(subject))fail('FORBIDDEN',403);return subject;
}
// A request and its canonical group share one ID. Only legacy rows can remain pending
// across transactions. Never recreate a scope or change the status of an existing group.
async function activatePending(tx,teacherId,subjectIds,activatedBy,groupId=null){
  return query(tx,`WITH pending AS MATERIALIZED (
      SELECT id,teacher_id FROM ua_cabinet.group_requests
      WHERE teacher_id=$1 AND subject_id=ANY($2::text[]) AND active_group_id IS NULL
        AND ($3::uuid IS NULL OR id=$3) ORDER BY id FOR UPDATE
    ), created AS (
      INSERT INTO ua_private.groups(id,revision,status) SELECT id,1,'active' FROM pending RETURNING id
    ), scoped AS (
      INSERT INTO ua_private.staff_group_scope(person_id,group_id,revoked_at_ms)
      SELECT p.teacher_id,c.id,NULL FROM created c JOIN pending p ON p.id=c.id RETURNING group_id
    )
    UPDATE ua_cabinet.group_requests r SET active_group_id=r.id,approved_by=$4
    FROM scoped s WHERE r.id=s.group_id RETURNING r.*,'active' AS status`,
    [teacherId,subjectIds,groupId,activatedBy]);
}
async function group(tx,id,actor,{requireActive=true,recoverPending=false}={}){
  const g=need(await query(tx,'SELECT * FROM ua_cabinet.group_requests WHERE id=$1 FOR UPDATE',[needId(id)]));
  if(actor.role==='teacher'&&(g.teacher_id!==actor.personId||!actor.approvedSubjectIds.includes(g.subject_id)))fail('NOT_FOUND',404);
  if(actor.role==='admin'&&!actor.scope.all_groups&&!actor.scope.subject_ids.includes(g.subject_id))fail('NOT_FOUND',404);
  if(!g.active_group_id){
    if(recoverPending&&actor.role==='teacher'){
      const activated=need(await activatePending(tx,actor.personId,[g.subject_id],actor.personId,g.id));
      actor.scope.group_ids.push(g.id);
      return activated;
    }
    if(requireActive)fail('GROUP_PENDING',409);
    return {...g,status:'pending'};
  }
  if(actor.role==='teacher'&&!actor.scope.group_ids.includes(g.id)){
    // An older client may have activated the same request while the owner was signing in.
    need(await query(tx,`SELECT 1 FROM ua_private.staff_group_scope
      WHERE person_id=$1 AND group_id=$2 AND revoked_at_ms IS NULL FOR SHARE`,[actor.personId,g.id]));
    actor.scope.group_ids.push(g.id);
  }
  const {status}=need(await query(tx,'SELECT status FROM ua_private.groups WHERE id=$1 FOR UPDATE',[g.id]));
  if(requireActive&&status!=='active')fail('GROUP_ARCHIVED',409);
  return {...g,status};
}
const registeredStudent="p.enabled AND p.roles=ARRAY['student']::text[] AND p.profile->'registration_complete'='true'::jsonb";
async function availableStudents(tx,actor,{groupId,after}){
  await group(tx,groupId,actor);
  if(after!=null&&(typeof after!=='string'||!/^[0-9]{10}$/.test(after)))fail('VALIDATION_ERROR',422);
  const rows=await query(tx,`SELECT concat_ws(' ',nullif(p.profile->>'first_name',''),nullif(p.profile->>'last_name','')) AS name,
      p.univeracademy_id
    FROM ua_private.people_registration p JOIN ua_private.memberships m ON m.person_id=p.id
    WHERE p.univeracademy_id>$1 AND ${registeredStudent} AND p.profile->>'active_group_id' IS NULL
      AND NOT m.active AND m.affinity_group_id IS NULL
    ORDER BY p.univeracademy_id LIMIT $2`,[after??'',studentDirectoryPageSize+1]);
  const students=rows.slice(0,studentDirectoryPageSize);
  return {students,nextCursor:rows.length>students.length?students.at(-1).univeracademy_id:null};
}
async function byCabinet(tx,id){
  if(typeof id!=='string'||!/^\d{10}$/.test(id))fail('VALIDATION_ERROR',422);
  return (await query(tx,`SELECT p.id,p.telegram_id FROM ua_private.people_registration p WHERE p.univeracademy_id=$1 AND ${registeredStudent}`,[id]))[0];
}
async function enroll(tx,g,studentId){
  let rows;
  try {
    rows=await query(tx,`SELECT m.*,p.profile->>'active_group_id' AS profile_group FROM ua_private.memberships m JOIN ua_private.people p ON p.id=m.person_id
      WHERE m.person_id=$1 AND ${registeredStudent} FOR UPDATE OF m,p NOWAIT`,[studentId]);
  }catch(error){
    if(error.code==='55P03')fail('MEMBERSHIP_BUSY',409);
    throw error;
  }
  const m=need(rows);
  if(m.active&&m.affinity_group_id===g.id)return groupView(g);
  if(m.active||m.affinity_group_id!==null||m.profile_group!==null)fail('GROUP_MEMBERSHIP_CONFLICT',409);
  need(await query(tx,'UPDATE ua_private.memberships SET active=true,affinity_group_id=$2,revision=revision+1,epoch=epoch+1 WHERE person_id=$1 AND revision=$3 AND NOT active AND affinity_group_id IS NULL RETURNING person_id',[studentId,g.id,m.revision]));
  await query(tx,"UPDATE ua_private.people SET profile=jsonb_set(profile,'{active_group_id}',to_jsonb($2::text)) WHERE id=$1",[studentId,g.id]);
  await query(tx,'UPDATE ua_private.groups SET revision=revision+1 WHERE id=$1',[g.id]);
  return groupView(g);
}
// Removing a student mirrors the roster-removal rule: never while a test is running, and the old
// access to unstarted tests stops at once because the membership epoch moves on. The student returns
// to the "no group" list, so the same or another teacher can add them again.
async function unenroll(tx,g,cabinetId){
  const student=await byCabinet(tx,cabinetId);if(!student)fail('NOT_FOUND',404);
  let rows;
  try {
    rows=await query(tx,`SELECT m.*,p.profile->>'active_group_id' AS profile_group FROM ua_private.memberships m JOIN ua_private.people p ON p.id=m.person_id
      WHERE m.person_id=$1 AND ${registeredStudent} FOR UPDATE OF m,p NOWAIT`,[student.id]);
  }catch(error){
    if(error.code==='55P03')fail('MEMBERSHIP_BUSY',409);
    throw error;
  }
  const m=need(rows);
  if(!m.active||m.affinity_group_id!==g.id||m.profile_group!==g.id)fail('NOT_FOUND',404);
  // Finish tests whose time has already run out, then refuse if one is still open.
  await expireVisible(tx,student.id,[],false);
  const running=await query(tx,`SELECT 1 FROM ua_private.attempts t JOIN ua_private.exam_series es ON es.current_attempt_id=t.id AND es.person_id=t.person_id
    WHERE t.person_id=$1 AND t.body->>'status'='in_progress' AND (t.body->>'deadlineAt')::numeric>extract(epoch FROM clock_timestamp())*1000 LIMIT 1`,[student.id]);
  if(running.length)fail('ACTIVE_EXAM_OR_RECOVERY',409);
  need(await query(tx,`UPDATE ua_private.memberships SET active=false,affinity_group_id=NULL,revision=revision+1,epoch=epoch+1
    WHERE person_id=$1 AND revision=$2 AND active AND affinity_group_id=$3 RETURNING person_id`,[student.id,m.revision,g.id]));
  await query(tx,"UPDATE ua_private.people SET profile=jsonb_set(profile,'{active_group_id}','null'::jsonb) WHERE id=$1",[student.id]);
  await query(tx,'UPDATE ua_private.groups SET revision=revision+1 WHERE id=$1',[g.id]);
  return groupView(g);
}
async function invite(tx,actor,g,recipient,send){
  let tg=null;
  if(send){
    if(!recipient?.telegram_id)fail('CHAT_UNAVAILABLE',409);
    tg=recipient.telegram_id;
    if(!(await query(tx,'SELECT telegram_id FROM ua_cabinet.private_starts WHERE telegram_id=$1',[tg])).length)fail('CHAT_UNAVAILABLE',409);
  }
  const token='grp_'+randomBytes(24).toString('base64url'),digest=hash(token);
  const row=need(await query(tx,`INSERT INTO ua_cabinet.invites(digest,group_id,recipient_id,expires_at,created_by)
    VALUES($1,$2,$3,clock_timestamp()+interval '24 hours',$4) RETURNING expires_at`,[digest,g.id,recipient?.id??null,actor.personId]));
  if(send)await query(tx,`INSERT INTO ua_cabinet.invite_delivery(id,invite_digest,telegram_id,token) VALUES($1,$2,$3,$4)`,[randomUUID(),digest,tg,token]);
  return {groupId:g.id,token,expiresAt:row.expires_at.toISOString(),...(send?{delivery:'queued'}:{})};
}
async function accept(tx,actor,{token},key){
  if(typeof token!=='string'||!/^grp_[A-Za-z0-9_-]{32}$/.test(token))fail('INVALID_INVITE',404);
  const digest=hash(token);
  const i=(await query(tx,'SELECT *,expires_at<=clock_timestamp() expired FROM ua_cabinet.invites WHERE digest=$1',[digest]))[0];
  if(!i||i.recipient_id&&i.recipient_id!==actor.personId)fail('INVALID_INVITE',404);
  if(i.recipient_id && !(await query(tx,`SELECT 1 FROM ua_cabinet.invite_delivery d JOIN ua_private.people p
    ON p.telegram_id=d.telegram_id AND p.id=$2 AND p.enabled WHERE d.invite_digest=$1`,[digest,actor.personId])).length)
    fail('INVALID_INVITE',404);
  const teacher=await actorFor(tx,{personId:i.created_by,role:'teacher'}),g=await group(tx,i.group_id,teacher);
  if(!(await query(tx,'SELECT 1 FROM ua_cabinet.invites WHERE digest=$1 AND expires_at>clock_timestamp()',[digest])).length)fail('INVITE_EXPIRED',410);
  const prior=(await query(tx,'SELECT invite_digest FROM ua_cabinet.redemptions WHERE student_id=$1 AND command_key=$2',[actor.personId,key]))[0];
  if(prior && prior.invite_digest!==digest)fail('IDEMPOTENCY_CONFLICT',409);
  const out=await enroll(tx,g,actor.personId);
  await query(tx,'INSERT INTO ua_cabinet.redemptions(invite_digest,student_id,command_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[digest,actor.personId,key]);
  return out;
}
async function media(tx,actor,action,input){
  const id=needId(input.id);
  if(action==='putMedia'){
    if(input.contentType!=='image/png'||!(input.bytes instanceof Uint8Array)||!input.bytes.length||input.bytes.length>8388608)fail('VALIDATION_ERROR',422);
    await query(tx,'INSERT INTO ua_cabinet.media(id,teacher_id,png) VALUES($1,$2,$3)',[id,actor.personId,Buffer.from(input.bytes)]);
    return {id,contentType:'image/png'};
  }
  const rows=actor.role==='teacher'?await query(tx,'SELECT png FROM ua_cabinet.media WHERE id=$1 AND teacher_id=$2',[id,actor.personId]):
    await query(tx,`SELECT f.png FROM ua_cabinet.media f WHERE f.id=$1 AND EXISTS(
      SELECT 1 FROM ua_cabinet.assignment_media x JOIN ua_private.attempts t ON t.assignment_id=x.assignment_id
      JOIN ua_private.exam_series es ON es.current_attempt_id=t.id AND es.person_id=t.person_id
      JOIN ua_private.assignments a ON a.id=t.assignment_id JOIN ua_private.memberships m ON m.person_id=t.person_id AND m.affinity_group_id=a.group_id
      JOIN ua_private.groups g ON g.id=a.group_id AND g.status='active'
      JOIN ua_private.grants gr ON gr.assignment_id=a.id AND gr.person_id=t.person_id
      WHERE x.asset_id=f.id AND t.person_id=$2 AND t.body->>'status'='in_progress' AND m.active AND gr.rostered AND gr.grant_epoch=m.epoch
        AND NOT (a.record->>'cancelled')::boolean AND (t.body->>'deadlineAt')::numeric>extract(epoch FROM clock_timestamp())*1000
        FOR SHARE OF t,a,m,gr,g)`,[id,actor.personId]);
  return {bytes:need(rows).png,contentType:'image/png'};
}
async function authorizeResource(tx,actor,action,input){
  if(['approveGroup','addMember','removeMember','createInvite','sendInvite','assignTest'].includes(action)){
    const g=await group(tx,input.groupId,actor,{requireActive:!['approveGroup','removeMember'].includes(action),recoverPending:actor.role==='teacher'});
    return g;
  }
  if(action==='updateDraft'){
    if(Object.keys(input).some(k=>!['testId','expectedRevision','draft'].includes(k)))fail('VALIDATION_ERROR',422);
    const loaded=await ownedTest(tx,actor,input.testId,true);
    requireEditable(loaded.t);
    return loaded;
  }
  return null;
}
async function effect(tx,actor,action,input,subjectId,g){
  switch(action){
    case 'createGroup':{
      const id=randomUUID();
      await query(tx,'INSERT INTO ua_cabinet.group_requests(id,teacher_id,subject_id,name) VALUES($1,$2,$3,$4)',
        [id,actor.personId,subjectId,cleanText(input.name,100)]);
      return groupView(need(await activatePending(tx,actor.personId,[subjectId],actor.personId,id)));
    }
    case 'approveGroup':{
      if(g.active_group_id)return groupView(g);
      const owner=await actorFor(tx,{role:'teacher',personId:g.teacher_id});
      subjectFor(owner,g.subject_id);
      return groupView(need(await activatePending(tx,g.teacher_id,[g.subject_id],actor.personId,g.id)));
    }
    case 'addMember':{
      const student=await byCabinet(tx,input.univeracademy_id);if(!student)fail('NOT_FOUND',404);
      return enroll(tx,g,student.id);
    }
    case 'removeMember':return unenroll(tx,g,input.univeracademy_id);
    case 'requestAccountDeletion':{
      return {id:actor.personId,requested:true,repeated:actor.deletionRequested};
    }
    case 'createInvite':return invite(tx,actor,g,null,false);
    case 'sendInvite':return invite(tx,actor,g,await byCabinet(tx,input.univeracademy_id),true);
    case 'importTest':{const {subjectId:_,...file}=input;return createDraft(tx,actor,file,subjectId);}
    case 'updateDraft':return saveDraft(tx,actor,g,input);
    case 'publishTest':return publish(tx,actor,input.testId);
    case 'assignTest':return assign(tx,actor,g,input.testId,input.startsAt);
    default:fail('FORBIDDEN',403);
  }
}
export async function runStagingPilot(tx,identity,action,input={},key){
  if(!tx?.personIds?.includes(identity?.personId))fail('FORBIDDEN',403);
  if(!input||typeof input!=='object'||Array.isArray(input))fail('VALIDATION_ERROR',422);
  const actor=await actorFor(tx,identity);
  if(!actions[actor.role].has(action))fail('FORBIDDEN',403);
  if(action==='dashboard'){
    if(actor.role==='teacher')await activatePending(tx,actor.personId,actor.approvedSubjectIds,actor.personId);
    return dashboard(tx,actor);
  }
  if(action==='previewText')return parseTeacherTestText(input.text);
  if(action==='availableStudents')return availableStudents(tx,actor,input);
  if(action==='readMedia'||action==='putMedia')return media(tx,actor,action,input);
  if(action==='readDraft'){
    const {s,t}=await ownedTest(tx,actor,input.testId,true);
    return editableDraft(s,t);
  }
  if(action==='previewTest')return preview(tx,actor,input.testId);
  if(attemptActions.has(action)){
    const {runStagingAttempt}=await import('./teacher-staging-attempts.mjs');
    return runStagingAttempt(tx,actor,action,input,key);
  }
  if(typeof key!=='string'||key.length>128||!key.length)fail('IDEMPOTENCY_KEY_REQUIRED',400);
  if(action==='acceptInvite')return accept(tx,actor,input,key);
  const importSubject=action==='importTest'?subjectFor(actor,input.subjectId):null;
  const g=await authorizeResource(tx,actor,action,input);
  const receiptKey=actor.personId+'/staging/'+action+'/'+hash(key),payload=hash(canonical(input));
  const prior=(await query(tx,'SELECT payload,response FROM ua_private.staff_receipts WHERE actor_id=$1 AND key=$2',[actor.personId,receiptKey]))[0];
  if(prior){
    if(action==='publishTest'||action==='assignTest')await requireOwnedTest(tx,actor,input.testId);
    if(prior.payload!==payload)fail('IDEMPOTENCY_CONFLICT',409);
    if(action==='createGroup')return groupView(await group(tx,prior.response.id,actor,{requireActive:false,recoverPending:true}));
    if(action==='importTest')await requireOwnedTest(tx,actor,prior.response.id);
    if(action==='assignTest'&&prior.response.opensAt===undefined){
      // Receipts written by older releases only contained the assignment identity.
      const window=need(await query(tx,`SELECT record#>'{admission,opensAt}' AS "opensAt",record#>'{admission,closesAt}' AS "closesAt",
        record#>>'{reviewGate,timezone}' AS timezone FROM ua_private.assignments WHERE id=$1 AND group_id=$2 AND version_id=$3`,
        [prior.response.id,input.groupId,input.testId]));
      return {...prior.response,...window};
    }
    return prior.response;
  }
  const subject=action==='createGroup'?subjectFor(actor,input.subjectId):importSubject;
  const {repeated,...response}=await effect(tx,actor,action,input,subject,g);
  // A repeated deletion request changes nothing, so it leaves no second receipt or audit row.
  if(repeated)return response;
  await query(tx,'INSERT INTO ua_private.staff_receipts(actor_id,key,payload,response) VALUES($1,$2,$3,$4)',[actor.personId,receiptKey,payload,response]);
  await query(tx,'INSERT INTO ua_private.staff_audit(command_key,actor_id,action,target_id,revision,at_ms) VALUES($1,$2,$3,$4,$5,$6)',
    [receiptKey,actor.personId,action,response.id??response.groupId,action==='updateDraft'?response.revision:0,tx.now]);
  return response;
}
