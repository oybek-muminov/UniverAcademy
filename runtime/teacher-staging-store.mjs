import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fail} from '../supabase/functions/univeracademy-api/fault.ts';
import {cleanText} from './teacher-pilot-import.mjs';
import {query,need,needId,groupView,createDraft,publish,assign,preview,ownedTest} from './teacher-staging-content.mjs';
import {dashboard} from './teacher-staging-dashboard.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const actions={teacher:new Set(['dashboard','createGroup','addMember','createInvite','sendInvite','importTest','previewTest','publishTest','assignTest','readMedia','putMedia']),
 student:new Set(['dashboard','acceptInvite','startAttempt','saveAnswer','submitAttempt','resumeAttempt','readMedia']),admin:new Set(['dashboard','approveGroup'])};
const attemptActions=new Set(['startAttempt','saveAnswer','submitAttempt','resumeAttempt']);
function canonical(v){return JSON.stringify(v,(_,x)=>x && typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);}
async function actorFor(tx,{personId,role}){
  if(!Object.hasOwn(actions,role))fail('FORBIDDEN',403);
  const p=(await query(tx,'SELECT id,enabled,roles,profile,univeracademy_id FROM ua_private.people_registration WHERE id=$1',[needId(personId)]))[0];
  if(!p?.enabled || !p.roles.includes(role))fail('FORBIDDEN',403);
  const actor={personId,role,roles:p.roles,enabled:true,profile:p.profile,cabinetId:p.univeracademy_id};
  if(role==='student'){
    if(!p.profile.registration_complete)fail('PROFILE_INCOMPLETE',409);
    return actor;
  }
  const s=(await query(tx,'SELECT * FROM ua_private.staff_access WHERE person_id=$1 FOR SHARE',[personId]))[0];
  if(!s?.approved || role==='admin'&&!s.manage_roster)fail('FORBIDDEN',403);
  const current=async(sql,field)=>(await query(tx,sql,[personId])).map(row=>row[field]);
  actor.approved=true;
  actor.approvedSubjectIds=await current('SELECT subject_id FROM ua_private.teacher_subject_approvals WHERE person_id=$1 AND approved AND revoked_at_ms IS NULL ORDER BY subject_id FOR SHARE','subject_id');
  actor.scope={all_groups:s.all_groups,all_subjects:s.all_subjects,
    group_ids:await current('SELECT group_id FROM ua_private.staff_group_scope WHERE person_id=$1 AND revoked_at_ms IS NULL ORDER BY group_id FOR SHARE','group_id'),
    subject_ids:await current('SELECT subject_id FROM ua_private.staff_subject_scope WHERE person_id=$1 AND revoked_at_ms IS NULL ORDER BY subject_id FOR SHARE','subject_id')};
  if(role==='teacher'&&!actor.approvedSubjectIds.length)fail('FORBIDDEN',403);
  return actor;
}
function subjectFor(actor,id){
  if(id===undefined && actor.approvedSubjectIds.length!==1)fail('SUBJECT_REQUIRED',422);
  const subject=id??actor.approvedSubjectIds[0];
  if(!actor.approvedSubjectIds.includes(subject))fail('FORBIDDEN',403);return subject;
}
async function group(tx,id,actor,active=true){
  const g=need(await query(tx,`SELECT r.*,COALESCE(g.status,'pending') status FROM ua_cabinet.group_requests r
    LEFT JOIN ua_private.groups g ON g.id=r.active_group_id WHERE r.id=$1 FOR UPDATE OF r`,[needId(id)]));
  if(actor.role==='teacher'&&(g.teacher_id!==actor.personId||!actor.approvedSubjectIds.includes(g.subject_id)||
    g.active_group_id&&!actor.scope.group_ids.includes(id)))fail('NOT_FOUND',404);
  if(actor.role==='admin'&&!actor.scope.all_groups&&!actor.scope.subject_ids.includes(g.subject_id))fail('NOT_FOUND',404);
  if(active && g.status!=='active')fail(g.status==='pending'?'GROUP_PENDING':'GROUP_ARCHIVED',409);
  if(g.active_group_id){
    const canonical=need(await query(tx,'SELECT status FROM ua_private.groups WHERE id=$1 FOR UPDATE',[id]));
    if(active&&canonical.status!=='active')fail('GROUP_ARCHIVED',409);
  }
  return g;
}
async function byCabinet(tx,id){
  if(typeof id!=='string'||!/^\d{10}$/.test(id))fail('VALIDATION_ERROR',422);
  return (await query(tx,`SELECT id,telegram_id FROM ua_private.people_registration WHERE univeracademy_id=$1 AND enabled AND 'student'=ANY(roles)
    AND profile->>'registration_complete'='true'`,[id]))[0];
}
async function enroll(tx,g,studentId){
  const rows=await query(tx,`SELECT m.*,p.enabled,p.roles,p.profile FROM ua_private.memberships m JOIN ua_private.people p ON p.id=m.person_id
    WHERE m.person_id=$1 ORDER BY m.person_id FOR UPDATE OF m,p NOWAIT`,[studentId]);
  const m=need(rows);
  if(!m.enabled||!m.roles.includes('student')||!m.profile.registration_complete)fail('NOT_FOUND',404);
  if(m.active&&m.affinity_group_id===g.id)return groupView(g);
  if(m.affinity_group_id||m.profile.active_group_id)fail('GROUP_MEMBERSHIP_CONFLICT',409);
  need(await query(tx,'UPDATE ua_private.memberships SET active=true,affinity_group_id=$2,revision=revision+1,epoch=epoch+1 WHERE person_id=$1 AND revision=$3 AND NOT active AND affinity_group_id IS NULL RETURNING person_id',[studentId,g.id,m.revision]));
  await query(tx,"UPDATE ua_private.people SET profile=jsonb_set(profile,'{active_group_id}',to_jsonb($2::text)) WHERE id=$1",[studentId,g.id]);
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
  if(['approveGroup','addMember','createInvite','sendInvite','assignTest'].includes(action)){
    const g=await group(tx,input.groupId,actor,action!=='approveGroup');
    if(action==='assignTest')await ownedTest(tx,actor,input.testId);
    return g;
  }
  if(action==='publishTest')await ownedTest(tx,actor,input.testId);
  return null;
}
async function effect(tx,actor,action,input,subjectId,g){
  switch(action){
    case 'createGroup':{
      const r=need(await query(tx,`INSERT INTO ua_cabinet.group_requests(id,teacher_id,subject_id,name) VALUES($1,$2,$3,$4) RETURNING *, 'pending' status`,
        [randomUUID(),actor.personId,subjectId,cleanText(input.name,100)]));return groupView(r);
    }
    case 'approveGroup':{
      if(!g.active_group_id){
        await actorFor(tx,{role:'teacher',personId:g.teacher_id}).then(t=>subjectFor(t,g.subject_id));
        await query(tx,"INSERT INTO ua_private.groups(id,revision,status) VALUES($1,1,'active')",[g.id]);
        await query(tx,'INSERT INTO ua_private.staff_group_scope(person_id,group_id,revoked_at_ms) VALUES($1,$2,NULL)',[g.teacher_id,g.id]);
        await query(tx,'UPDATE ua_cabinet.group_requests SET active_group_id=id,approved_by=$2 WHERE id=$1 AND active_group_id IS NULL',[g.id,actor.personId]);
      }
      return groupView({...g,status:g.active_group_id?g.status:'active'});
    }
    case 'addMember':{
      const student=await byCabinet(tx,input.univeracademy_id);if(!student)fail('NOT_FOUND',404);
      return enroll(tx,g,student.id);
    }
    case 'createInvite':return invite(tx,actor,g,null,false);
    case 'sendInvite':return invite(tx,actor,g,await byCabinet(tx,input.univeracademy_id),true);
    case 'importTest':{const {subjectId:_,...file}=input;return createDraft(tx,actor,file,subjectId);}
    case 'publishTest':return publish(tx,actor,input.testId);
    case 'assignTest':return assign(tx,actor,g,input.testId);
    default:fail('FORBIDDEN',403);
  }
}
export async function runStagingPilot(tx,identity,action,input={},key){
  if(!tx?.personIds?.includes(identity?.personId))fail('FORBIDDEN',403);
  if(!input||typeof input!=='object'||Array.isArray(input))fail('VALIDATION_ERROR',422);
  const actor=await actorFor(tx,identity);
  if(!actions[actor.role].has(action))fail('FORBIDDEN',403);
  if(action==='dashboard')return dashboard(tx,actor);
  if(action==='readMedia'||action==='putMedia')return media(tx,actor,action,input);
  if(action==='previewTest')return preview(tx,actor,input.testId);
  if(attemptActions.has(action)){
    const {runStagingAttempt}=await import('./teacher-staging-attempts.mjs');
    return runStagingAttempt(tx,actor,action,input,key);
  }
  if(typeof key!=='string'||key.length>128||!key.length)fail('IDEMPOTENCY_KEY_REQUIRED',400);
  if(action==='acceptInvite')return accept(tx,actor,input,key);
  const subject=['createGroup','importTest'].includes(action)?subjectFor(actor,input.subjectId):null;
  const g=await authorizeResource(tx,actor,action,input);
  const receiptKey=actor.personId+'/staging/'+action+'/'+hash(key),payload=hash(canonical(input));
  const prior=(await query(tx,'SELECT payload,response FROM ua_private.staff_receipts WHERE actor_id=$1 AND key=$2',[actor.personId,receiptKey]))[0];
  if(prior){
    if(prior.payload!==payload)fail('IDEMPOTENCY_CONFLICT',409);
    if(action==='createGroup')return groupView(await group(tx,prior.response.id,actor,false));
    if(action==='importTest')await ownedTest(tx,actor,prior.response.id);
    return prior.response;
  }
  const response=await effect(tx,actor,action,input,subject,g);
  await query(tx,'INSERT INTO ua_private.staff_receipts(actor_id,key,payload,response) VALUES($1,$2,$3,$4)',[actor.personId,receiptKey,payload,response]);
  await query(tx,'INSERT INTO ua_private.staff_audit(command_key,actor_id,action,target_id,revision,at_ms) VALUES($1,$2,$3,$4,0,$5)',
    [receiptKey,actor.personId,action,response.id??response.groupId,tx.now]);
  return response;
}
