import {assignmentSchedule} from './teacher-assignment-schedule.mjs';
import {randomUUID} from 'node:crypto';
import {fail} from '../supabase/functions/univeracademy-api/fault.ts';
import {encodePublished,decodePublished} from '../supabase/functions/univeracademy-api/storage/attempt-rows.ts';
import {publishDraft} from '../supabase/functions/univeracademy-api/staff-content.ts';
import {createTeacherPilotAssignment} from '../supabase/functions/univeracademy-api/pilot-provisioning.ts';
import {blocksWire} from '../supabase/functions/univeracademy-api/student-wire.ts';
import {importDraft,replaceDraft,verifyTeacherImage} from './teacher-pilot-import.mjs';
import {validate} from './teacher-staging-contract.mjs';

export const uuid=id=>typeof id==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export const needId=id=>{if(!uuid(id))fail('NOT_FOUND',404);return id;};
export const groupView=row=>({id:row.id,name:row.name,status:row.status,subjectId:row.subject_id});
export const query=async(tx,sql,args=[])=> (await tx.client.query({text:sql,values:args})).rows;
export const need=rows=>{if(!rows.length) fail('NOT_FOUND',404);return rows[0];};
function context(){return {versions:{},demos:{},receipts:{},audit:[],pilot:{media:{}}};}
function summary(t,title){return {id:t.wire.id,revision:t.wire.revision,title,status:t.wire.status,duration_seconds:t.wire.duration_seconds,questionCount:t.questionIds.length,subjectId:t.subjectId};}
function imageIds(questions,instructions=[]) {
  const ids=new Set();
  const visit=bs=>{if(Array.isArray(bs))for(const b of bs)if(b?.type==='image' && uuid(b.asset_id)) ids.add(b.asset_id);};
  visit(instructions);
  if(Array.isArray(questions))for(const q of questions){
    visit(q?.prompt_blocks);visit(q?.explanation_blocks);
    if(Array.isArray(q?.options))for(const o of q.options)visit(o?.blocks);
  }
  return [...ids];
}
async function ownImages(tx,state,teacherId,ids){
  if(!ids.length)return;
  for(const asset of await query(tx,'SELECT id FROM ua_cabinet.media WHERE teacher_id=$1 AND id=ANY($2::uuid[])',[teacherId,ids]))
    state.pilot.media[asset.id]={teacherPersonId:teacherId};
}
export async function createDraft(tx,actor,file,subjectId){
  const s=context();
  await ownImages(tx,s,actor.personId,imageIds(file.questions,file.instructions_blocks));
  const t=importDraft(s,actor,file,tx.now,subjectId),w=t.wire,title=s.demos[w.demo_id].title;
  await query(tx,'INSERT INTO ua_private.demos(id,subject_id,title) VALUES($1,$2,$3)',[w.demo_id,subjectId,title]);
  await query(tx,'INSERT INTO ua_private.test_versions(id,demo_id,revision,status,wire,published_snapshot) VALUES($1,$2,$3,$4,$5,NULL)',[w.id,w.demo_id,w.revision,w.status,w]);
  await query(tx,'INSERT INTO ua_cabinet.test_owners(version_id,teacher_id) VALUES($1,$2)',[w.id,actor.personId]);
  await insertQuestions(tx,w.id,t.questions);
  return summary(t,title);
}
async function insertQuestions(tx,id,questions){
  await query(tx,`INSERT INTO ua_private.draft_questions(version_id,id,position,record)
    SELECT $1,(v->>'id')::uuid,(v->>'position')::bigint,v FROM jsonb_array_elements($2::jsonb) v`,
    [id,JSON.stringify(Object.values(questions))]);
}
export async function saveDraft(tx,actor,loaded,input){
  const {s,t,title,qs}=loaded,{testId,expectedRevision,draft}=input;
  await ownImages(tx,s,actor.personId,imageIds(draft?.questions,draft?.instructions_blocks));
  replaceDraft(s,actor,t,draft,expectedRevision,tx.now);
  const w=t.wire,newTitle=s.demos[w.demo_id].title;
  if(newTitle!==title){
    // A demo title belongs to all its versions. Never rename a published or independently owned sibling.
    // Block concurrent sibling inserts (their foreign key needs a key-share lock).
    const demo=await query(tx,'SELECT id FROM ua_private.demos WHERE id=$1 FOR UPDATE',[w.demo_id]);
    if(!demo.length)fail('DEMO_TITLE_SHARED',409);
    const renamed=await query(tx,`UPDATE ua_private.demos d SET title=$2 WHERE d.id=$1 AND NOT EXISTS(
      SELECT 1 FROM ua_private.test_versions v WHERE v.demo_id=d.id AND v.id<>$3) RETURNING id`,[w.demo_id,newTitle,testId]);
    if(!renamed.length)fail('DEMO_TITLE_SHARED',409);
  }
  const removed=await query(tx,'DELETE FROM ua_private.draft_questions WHERE version_id=$1 RETURNING id',[testId]);
  if(removed.length!==qs.length)fail('RESOURCE_REVISION_CONFLICT',409);
  await insertQuestions(tx,testId,t.questions);
  need(await query(tx,"UPDATE ua_private.test_versions SET revision=$2,wire=$3 WHERE id=$1 AND revision=$4 AND status='draft' RETURNING id",
    [testId,w.revision,w,expectedRevision]));
  return summary(t,newTitle);
}
const ownerScope=` FROM ua_private.test_versions v JOIN ua_cabinet.test_owners t ON t.version_id=v.id JOIN ua_private.demos d ON d.id=v.demo_id
  WHERE v.id=$1 AND t.teacher_id=$2 AND d.subject_id=ANY($3::text[])`;
export async function requireOwnedTest(tx,actor,id){
  need(await query(tx,'SELECT v.id'+ownerScope,[needId(id),actor.personId,actor.approvedSubjectIds]));
}
export async function ownedTest(tx,actor,id,lock=false){
  const row=need(await query(tx,'SELECT v.wire,v.published_snapshot,d.subject_id,d.title'+ownerScope+(lock?' FOR UPDATE OF v':''),
    [needId(id),actor.personId,actor.approvedSubjectIds]));
  // Publication pins the validated authored questions. Reopening/assigning a published version
  // can reuse that same snapshot; drafts still read the editable canonical rows.
  const qs=row.published_snapshot?.questions??(await query(tx,'SELECT record FROM ua_private.draft_questions WHERE version_id=$1 ORDER BY position',[id])).map(q=>q.record);
  const s=context(),t={subjectId:row.subject_id,teacherPersonId:actor.personId,wire:row.wire,questionIds:qs.map(q=>q.id),questions:Object.fromEntries(qs.map(q=>[q.id,q]))};
  if(row.published_snapshot)t.publishedSnapshot={...row.published_snapshot,test:decodePublished(row.published_snapshot.test)};
  s.versions[id]=t;s.demos[t.wire.demo_id]={title:row.title,subjectId:t.subjectId};
  await ownImages(tx,s,actor.personId,imageIds(qs,t.wire.instructions_blocks));
  return {s,t,qs,title:row.title};
}
export async function publish(tx,actor,id){
  const {s,t,title}=await ownedTest(tx,actor,id,true);
  if(t.wire.status!=='published'){
    const rev=t.wire.revision;
    publishDraft(s,t,{expected_revision:rev,reason:'O‘qituvchi nashri'},'publish','publish',actor.personId,tx.now,validate,
      asset=>verifyTeacherImage(s,actor,asset));
    const snapshot={...t.publishedSnapshot,test:encodePublished(t.publishedSnapshot.test)};
    need(await query(tx,"UPDATE ua_private.test_versions SET revision=$2,status='published',wire=$3,published_snapshot=$4 WHERE id=$1 AND revision=$5 AND status='draft' RETURNING id",
      [id,t.wire.revision,t.wire,snapshot,rev]));
  }
  return summary(t,title);
}
function visibleText(blocks){return blocks.map(b=>b.markdown??b.latex??b.alt).join('\n');}
export async function preview(tx,actor,id){
  const {s,t,qs,title}=await ownedTest(tx,actor,id);
  const project=asset=>{verifyTeacherImage(s,actor,asset);return {asset_id:asset,content_type:'image/png',expires_at:new Date(tx.now+86400000).toISOString(),url:'/api/v1/teacher/pilot/media/'+asset};};
  return {...summary(t,title),instructions_blocks:blocksWire(t.wire.instructions_blocks,project),questions:qs.map(q=>{
    const blocks=blocksWire(q.prompt_blocks,project);
    return {id:q.id,text:visibleText(blocks),blocks,prompt_blocks:blocks,options:q.options.map(o=>{
      const blocks=blocksWire(o.blocks,project);return {id:o.id,blocks,text:visibleText(blocks)};
    })};
  })};
}
export async function assign(tx,actor,g,testId,startsAt){
  const {s,t,title}=await ownedTest(tx,actor,testId,true);
  if(t.wire.status!=='published')fail('TEST_NOT_PUBLISHED',409);
  if(g.subject_id!==t.subjectId)fail('NOT_FOUND',404);
  const roster=await query(tx,`SELECT p.id,p.profile,m.epoch FROM ua_private.memberships m JOIN ua_private.people p ON p.id=m.person_id
    WHERE m.active AND m.affinity_group_id=$1 AND p.enabled AND 'student'=ANY(p.roles)
    AND p.profile->>'registration_complete'='true' ORDER BY p.id FOR SHARE OF m,p NOWAIT`,[g.id]);
  if(!roster.length)fail('EMPTY_GROUP',409);
  const saved=await query(tx,'SELECT id FROM ua_private.assignments WHERE group_id=$1 AND demo_id=$2',[g.id,t.wire.demo_id]);
  if(saved.length)fail('ASSIGNMENT_CONFLICT',409);
  s.groups={[g.id]:{id:g.id,status:'active',teacherPersonId:actor.personId,subjectId:g.subject_id}};
  s.memberships={};s.student={people:{},grants:{},assignments:{}};
  for(const p of roster){
    s.memberships[p.id]={active:true,epoch:Number(p.epoch),affinityGroupId:g.id};
    s.student.people[p.id]={enabled:true,profile:p.profile};
  }
  const window=assignmentSchedule(tx.now,startsAt);
  const spec={group_id:g.id,version_id:testId,demo_id:t.wire.demo_id,student_ids:roster.map(p=>p.id),...window,
    review_policy:'teacher_approval',reminder_lead_seconds:null};
  const a=createTeacherPilotAssignment(s,actor,spec,'assign','assign',tx.now,randomUUID);
  const record=s.student.assignments[a.id];
  await query(tx,'INSERT INTO ua_private.assignments(id,group_id,demo_id,version_id,revision,record) VALUES($1,$2,$3,$4,0,$5)',[a.id,g.id,t.wire.demo_id,testId,{...record,published:encodePublished(record.published)}]);
  await query(tx,`INSERT INTO ua_private.grants(person_id,assignment_id,rostered,grant_epoch)
    SELECT m.person_id,$1,true,m.epoch FROM ua_private.memberships m WHERE m.person_id=ANY($2::uuid[])`,[a.id,roster.map(p=>p.id)]);
  const ids=imageIds(t.publishedSnapshot.questions.map(({prompt_blocks,options})=>({prompt_blocks,options})));
  if(ids.length)await query(tx,'INSERT INTO ua_cabinet.assignment_media SELECT $1,unnest($2::uuid[])',[a.id,ids]);
  return {id:a.id,title,groupId:g.id,testId,opensAt:record.admission.opensAt,closesAt:record.admission.closesAt,timezone:a.timezone};
}
