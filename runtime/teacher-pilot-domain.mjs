// Loopback synthetic pilot. The HTTP adapter resolves an opaque local session to
// an actor. All role, group and test decisions below use server-owned records.
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fail,ApiFault} from '../supabase/functions/univeracademy-api/fault.ts';
import {publishDraft} from '../supabase/functions/univeracademy-api/staff-content.ts';
import {currentStaff} from '../supabase/functions/univeracademy-api/staff-state.ts';
import {addTeacherPilotMember,createTeacherPilotAssignment} from '../supabase/functions/univeracademy-api/pilot-provisioning.ts';
import {createStudentHttpHandler} from '../supabase/functions/univeracademy-api/student-http.ts';
import {blocksWire,scoreWire} from '../supabase/functions/univeracademy-api/student-wire.ts';
import {materializeElapsedAttempts} from '../supabase/functions/univeracademy-api/membership-activity.ts';
import {StaffFixture,validate} from '../tests/backend/staff-fixture.ts';
import {testNumbers} from '../tests/backend/http-fixture.ts';
import {studentDirectoryPageSize} from './teacher-student-directory.mjs';
import {assignmentSchedule,studentAssignmentStatus} from './teacher-assignment-schedule.mjs';
import {cleanText,editableDraft,importDraft,replaceDraft,requireEditable,verifyTeacherImage} from './teacher-pilot-import.mjs';

const subject='physics', day=86_400_000;
const actors = new Map([
  ['teacher',{name:'Sinov o‘qituvchisi',role:'teacher'}],['teacher2',{name:'Ikkinchi o‘qituvchi',role:'teacher'}],
  ['admin',{name:'Sinov administratori',role:'admin'}],
  ['student1',{name:'Aziza Karimova',role:'student',cabinetId:'0100000001'}],
  ['student2',{name:'Bekzod Aliyev',role:'student',cabinetId:'0100000002'}]
]);
const actions = {teacher:['createGroup','addMember','createInvite','sendInvite','importTest','readDraft','updateDraft','previewTest','publishTest','assignTest'],
  admin:['approveGroup'],student:['acceptInvite','startAttempt','saveAnswer','resumeAttempt','submitAttempt']};
const digest = value => createHash('sha256').update(value).digest('hex');
const unique = () => randomUUID();
const fullName = profile => [profile.first_name,profile.last_name].filter(Boolean).join(' ');
const textBlocks = blocks => blocks.map(block=>block.type === 'formula' ? block.latex : block.markdown ?? block.alt).join('\n');
const recordAt = (table,key) => typeof key === 'string' && Object.hasOwn(table,key) ? table[key] : undefined;
function requestDigest(input) {
  return digest(JSON.stringify(input, (_,v)=>v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])) : v));
}
function safeId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))
    fail('NOT_FOUND',404);
  return value;
}
function initialize(store) {
  const state=store.state;
  for (const k of ['staff','groups','memberships','versions','demos','recoveryAssignments','notifications','approvals','receipts'])
    state[k]={};
  for (const k of Object.keys(state.student)) state.student[k]={};
  state.audit=[];
  state.pilot={actors:{},studentsById:{},startedChats:{},inbox:{},invites:{},receipts:{},media:{},assignmentMedia:{}};
  for (const [alias,spec] of actors) {
    const personId=unique(), actor={...spec,personId,alias};
    state.pilot.actors[alias]=actor;
    if (spec.role === 'student') {
      const [first_name,last_name]=spec.name.split(' ');
      const profile={person_id:personId,first_name,last_name,roles:['student'],registration_complete:true,
        active_group_id:null,univeracademy_id:spec.cabinetId};
      state.student.people[personId]={profile,enabled:true,telegramId:null};
      state.pilot.studentsById[spec.cabinetId]=personId;
      state.pilot.startedChats[personId]=alias==='student2';
      state.pilot.inbox[personId]=[];
      state.student.grants[personId]={};
      state.memberships[personId]={affinityGroupId:null,active:false,revision:0,epoch:0};
    } else {
      state.staff[alias]={personId,enabled:true,approved:true,roles:[spec.role],approvedSubjectIds:[subject],
        capabilities:{manage_roster:false,manage_content:false},
        scope:{all_groups:false,all_subjects:false,group_ids:[],subject_ids:[subject]}};
    }
  }
}
function authorized(state,alias,now) {
  const actor=recordAt(state.pilot.actors,alias);
  if (!actor) fail('FORBIDDEN',403);
  if (actor.role==='student') {
    const person=state.student.people[actor.personId];
    if (!person?.enabled || !person.profile.roles.includes('student') || !person.profile.registration_complete) fail('FORBIDDEN',403);
  } else {
    const staff=currentStaff(state,{kind:'staff_verified',subject:alias,notBefore:now,expiresAt:now+1},now);
    if (staff.personId!==actor.personId || !staff.roles.includes(actor.role) ||
        actor.role==='teacher' && !staff.approvedSubjectIds.includes(subject)) fail('FORBIDDEN',403);
  }
  return actor;
}
function groupFor(state,actor,id,active=true) {
  const g=recordAt(state.groups,id);
  if (!g || g.teacherPersonId!==actor.personId || !state.staff[actor.alias].scope.group_ids.includes(id)) fail('NOT_FOUND',404);
  if (active && g.status!=='active') fail('GROUP_PENDING',409);
  return g;
}
function testFor(state,actor,id) {
  const test=recordAt(state.versions,id);
  if (!test || test.teacherPersonId!==actor.personId || test.subjectId!==subject) fail('NOT_FOUND',404);
  return test;
}
const groupView=g=>({id:g.id,name:g.name,status:g.status,subjectId:g.subjectId});
const testView=(state,t)=>({id:t.wire.id,title:state.demos[t.wire.demo_id].title,status:t.wire.status,
  questionCount:t.questionIds.length,duration_seconds:t.wire.duration_seconds,revision:t.wire.revision,subjectId:t.subjectId});
const assignView=a=>({id:a.admission.assignmentId,groupId:a.admission.groupId,testId:a.published.versionId,title:a.title,
  opensAt:a.admission.opensAt,closesAt:a.admission.closesAt,timezone:a.reviewGate.timezone});
function scoreView(ordinary) {
  const s=ordinary.display;
  return {earned:s.earned_points,maximum:s.max_points,percentage:s.percentage};
}
function enroll(state,g,personId,now,actorId,commandKey) {
  const membership=state.memberships[personId];
  if (membership?.active && membership.affinityGroupId===g.id) return groupView(g);
  if (membership?.affinityGroupId) fail('GROUP_MEMBERSHIP_CONFLICT',409);
  const teacher=state.pilot.actors[g.teacherAlias];
  authorized(state,teacher.alias,now);
  groupFor(state,teacher,g.id);
  const body={student_id:personId,status:'active',expected_revision:g.revision,expected_membership_revision:membership.revision};
  addTeacherPilotMember(state,state.staff[g.teacherAlias],g.id,body,'pilot-member/'+commandKey,JSON.stringify(body),now);
  state.audit.push({actorId,action:'pilot_enroll',targetId:personId,revision:g.revision,at:now});
  return groupView(g);
}
function groupMembers(state,g) {
  return Object.values(state.student.people).filter(p=>p.enabled && state.memberships[p.profile.person_id]?.active &&
    p.profile.active_group_id===g.id);
}
function dashboard(state,actor,time) {
  const role=actor.role,base={role,name:actor.name};
  if (role==='admin') return {...base,groups:Object.values(state.groups).map(g=>({...groupView(g),teacherName:state.pilot.actors[g.teacherAlias].name}))};
  const groups=role==='teacher'?Object.values(state.groups).filter(g=>g.teacherPersonId===actor.personId &&
    state.staff[actor.alias].scope.group_ids.includes(g.id)):[];
  const scope=new Set(groups.map(g=>g.id));
  const visiblePeople=role==='student'?[actor.personId]:[...new Set(groups.flatMap(g=>groupMembers(state,g).map(p=>p.profile.person_id)))];
  for (const id of visiblePeople) materializeElapsedAttempts(state,id,time);
  const assignments=Object.values(state.student.assignments).filter(a=>role==='teacher'?scope.has(a.admission.groupId):
    Boolean(state.student.grants[actor.personId]?.[a.admission.assignmentId]?.rostered) && state.student.people[actor.personId].profile.active_group_id===a.admission.groupId);
  const attempts=Object.values(state.student.attempts).filter(a=>role==='student'?a.personId===actor.personId:scope.has(a.groupId));
  const results=attempts.filter(a=>a.ordinary).map(a=>({attemptId:a.id,assignmentId:a.assignmentId,groupId:a.groupId,
    studentName:fullName(state.student.people[a.personId].profile),title:state.student.assignments[a.assignmentId].title,
    ...scoreView(scoreWire(state.student,a,testNumbers).ordinary)}));
  if (role==='teacher') return {...base,groups:groups.map(g=>({...groupView(g),members:groupMembers(state,g).map(p=>({
      name:fullName(p.profile),univeracademy_id:p.profile.univeracademy_id}))})),
    tests:Object.values(state.versions).filter(t=>t.teacherPersonId===actor.personId).map(t=>testView(state,t)),
    assignments:assignments.map(assignView),results};
  const p=state.student.people[actor.personId].profile, g=recordAt(state.groups,p.active_group_id);
  return {...base,serverNow:time,univeracademy_id:p.univeracademy_id,group:g?groupView(g):null,
    inbox:state.pilot.inbox[actor.personId].filter(entry=>Date.parse(entry.expiresAt)>time)
      .map(entry=>({...entry})),
    assignments:assignments.map(a=>{const attempt=attempts.find(x=>x.assignmentId===a.admission.assignmentId);
      return {...assignView(a),attemptId:attempt?.id??null,status:studentAssignmentStatus(a.admission,time,attempt?.status,a.cancelled)};}),results};
}

function issueInvite(state,group,time,recipientId=null) {
  const token='grp_'+randomBytes(24).toString('base64url'), expiresAt=time+day;
  state.pilot.invites[digest(token)]={groupId:group.id,recipientId,expiresAt};
  return {groupId:group.id,token,expiresAt:new Date(expiresAt).toISOString()};
}
function studentIdFor(state,value) {
  if (typeof value!=='string' || !/^[0-9]{10}$/.test(value)) fail('VALIDATION_ERROR',422);
  return recordAt(state.pilot.studentsById,value);
}
function mediaLink(role,asset,deadline) {
  return {asset_id:asset.id,url:'/local-pilot/'+role+'/media/'+asset.id,content_type:asset.contentType,
    expires_at:new Date(deadline).toISOString()};
}
function attemptCanReadImage(state,actor,attempt,id,time) {
  if (attempt.personId!==actor.personId || attempt.status!=='in_progress' || time>=attempt.deadlineAt) return false;
  const membership=state.memberships[actor.personId], assignment=state.student.assignments[attempt.assignmentId];
  const grant=state.student.grants[actor.personId]?.[attempt.assignmentId];
  return Boolean(membership?.active && membership.affinityGroupId===attempt.groupId && assignment && !assignment.cancelled &&
    state.student.people[actor.personId].profile.active_group_id===attempt.groupId &&
    grant?.rostered && grant.grantEpoch===grant.membershipEpoch && grant.grantEpoch===membership.epoch &&
    state.pilot.assignmentMedia[attempt.assignmentId]?.has(id));
}
function indexPublicImages(assignment) {
  const ids=new Set();
  for (const question of Object.values(assignment.contents)) {
    for (const block of [...question.prompt,...Object.values(question.options).flat()]) {
      if (block.type==='image') ids.add(block.asset_id);
    }
  }
  return ids;
}
function displayQuestion(id,prompt,options) {
  return {id,text:textBlocks(prompt),prompt_blocks:prompt,blocks:prompt,
    options:options.map(o=>({id:o.id,blocks:o.blocks,text:textBlocks(o.blocks)}))};
}
function previewTest(state,actor,testId,time) {
  const t=testFor(state,actor,testId);
  const image=id=>{
    verifyTeacherImage(state,state.staff[actor.alias],id);
    return mediaLink('teacher',state.pilot.media[id],time+day);
  };
  return {...testView(state,t),instructions_blocks:blocksWire(t.wire.instructions_blocks,image),
    questions:Object.values(t.questions).sort((a,b)=>a.position-b.position).map(q=>
      displayQuestion(q.id,blocksWire(q.prompt_blocks,image),q.options.map(o=>({id:o.id,blocks:blocksWire(o.blocks,image)}))))};
}
function teacherCommand(state,actor,action,input,key,time) {
  const staff=state.staff[actor.alias];
  if (action==='createGroup') {
    const id=unique(),group={id,name:cleanText(input.name,100),revision:1,status:'active',subjectId:subject,
      teacherAlias:actor.alias,teacherPersonId:actor.personId};
    state.groups[id]=group;
    staff.scope.group_ids.push(id);
    state.audit.push({actorId:actor.personId,action:'createGroup',targetId:id,revision:group.revision,at:time});
    return groupView(group);
  }
  if (action==='importTest') return testView(state,importDraft(state,staff,input,time));
  if (action==='updateDraft') {
    const t=testFor(state,actor,input.testId);
    return testView(state,replaceDraft(state,staff,t,input.draft,input.expectedRevision,time));
  }
  if (action==='publishTest') {
    const t=testFor(state,actor,input.testId);
    if (t.wire.status!=='published') {
      const body={expected_revision:t.wire.revision,reason:'O‘qituvchi kabinetidan nashr qilindi'};
      publishDraft(state,t,body,'pilot-publish/'+key,JSON.stringify(body),actor.personId,time,validate,id=>verifyTeacherImage(state,staff,id));
    }
    return testView(state,t);
  }
  const group=groupFor(state,actor,input.groupId);
  if (action==='addMember') {
    const studentId=studentIdFor(state,input.univeracademy_id);
    if (!studentId) fail('NOT_FOUND',404);
    return enroll(state,group,studentId,time,actor.personId,key);
  }
  if (action==='createInvite') return issueInvite(state,group,time);
  if (action==='sendInvite') {
    const id=studentIdFor(state,input.univeracademy_id);
    if (!id || !state.pilot.startedChats[id]) fail('LOCAL_CHAT_UNAVAILABLE',409);
    const invite=issueInvite(state,group,time,id);
    state.pilot.inbox[id].push({id:unique(),token:invite.token,groupName:group.name,expiresAt:invite.expiresAt});
    return {...invite,delivery:'local_bot'};
  }
  const test=testFor(state,actor,input.testId);
  if (test.wire.status!=='published') fail('TEST_NOT_PUBLISHED',409);
  const recipients=groupMembers(state,group).map(p=>p.profile.person_id);
  if (!recipients.length) fail('EMPTY_GROUP',409);
  const body={group_id:group.id,demo_id:test.wire.demo_id,version_id:test.wire.id,student_ids:recipients,...assignmentSchedule(time,input.startsAt),
    review_policy:'teacher_approval',reminder_lead_seconds:null};
  const a=createTeacherPilotAssignment(state,staff,body,'pilot-assignment/'+key,JSON.stringify(body),time,unique);
  state.pilot.assignmentMedia[a.id]=indexPublicImages(state.student.assignments[a.id]);
  return assignView(state.student.assignments[a.id]);
}

function acceptInvite(state,actor,input,key,time) {
  if (typeof input.token!=='string' || !/^grp_[A-Za-z0-9_-]{32}$/.test(input.token)) fail('INVALID_INVITE',404);
  const invite=state.pilot.invites[digest(input.token)];
  if (!invite || invite.recipientId && invite.recipientId!==actor.personId) fail('INVALID_INVITE',404);
  if (time>=invite.expiresAt) fail('INVITE_EXPIRED',410);
  const group=state.groups[invite.groupId];
  if (!group || group.status!=='active') fail('INVALID_INVITE',404);
  return enroll(state,group,actor.personId,time,actor.personId,key);
}
const answerView=a=>({questionId:a.question_id,optionId:a.selected_option_id,revision:a.revision});
function attemptView(a) {
  return {id:a.id,status:a.status,deadlineAt:a.deadline_at,answers:a.answers.map(answerView),questions:a.questions.map(q=>
    displayQuestion(q.id,q.prompt_blocks,q.options))};
}
async function studentAttempt(state,actor,action,input,key,time) {
  // The local actor has already been authenticated by the loopback adapter.
  // Bind a single-use internal proof to this person; the original student
  // handler still verifies the owner, roster, revisions, deadline and answers.
  const personId=actor.personId,token=randomBytes(32).toString('base64url'),hash=digest(token),familyId=unique();
  const family={personId,expiresAt:time+day,revokedAt:null,logoutRetainUntil:null};
  state.student.families[familyId]=family;
  state.student.access[hash]={familyId,expiresAt:time+day,superseded:false};
  let method, path, body;
  try {
    if (action==='startAttempt') {
      method='POST';path='/exams/'+safeId(input.assignmentId)+'/attempts';body={confirmed:true};
    } else {
      const base='/attempts/'+safeId(input.attemptId);
      if (action==='saveAnswer') {
        method='PUT';path=base+'/answers/'+safeId(input.questionId);
        body={expected_revision:input.expectedRevision,selected_option_id:input.optionId};
      } else if (action==='submitAttempt') {method='POST';path=base+'/submit';}
      else {method='GET';path=base;}
    }
    const studentHandler=createStudentHttpHandler({transactions:{transaction:work=>work({state:state.student,now:()=>time})},
      numericPresentation:testNumbers,projectAttemptImage:(id,attempt)=>{
        if (!attemptCanReadImage(state,actor,attempt,id,time)) fail('FORBIDDEN',403);
        return mediaLink('student',state.pilot.media[id],attempt.deadlineAt);
      }});
    const response=await studentHandler(new Request('http://127.0.0.1/api/v1'+path,{method,
      headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':key},
      body:body===undefined?undefined:JSON.stringify(body)}));
    const wire=await response.json();
    // The caller commits materialized deadlines even when an answer arrives late.
    if (!response.ok) return {error:{code:wire.error.code,status:response.status}};
    if (action==='saveAnswer') return {value:answerView(wire.data)};
    if (action==='submitAttempt') return {value:scoreView(wire.data.ordinary)};
    return {value:attemptView(wire.data)};
  } finally {
    delete state.student.access[hash];
    delete state.student.families[familyId];
  }
}

export function createTeacherPilot({now=Date.now}={}) {
  const store=new StaffFixture(now);
  initialize(store);
  return {
    registerMedia(alias,{id,contentType}) {
      return store.transaction(({state,now:clock})=>{
        const actor=authorized(state,alias,clock());
        if (actor.role!=='teacher') fail('FORBIDDEN',403);
        safeId(id);
        if (contentType!=='image/png') fail('VALIDATION_ERROR',422);
        if (recordAt(state.pilot.media,id)) fail('ASSET_CONFLICT',409);
        state.pilot.media[id]={id,contentType,teacherPersonId:actor.personId};
        return {id};
      });
    },
    canReadMedia(alias,id) {
      return store.transaction(({state,now:clock})=>{
        const time=clock(),actor=authorized(state,alias,time),asset=recordAt(state.pilot.media,id);
        if (!asset) return false;
        if (actor.role==='teacher') return asset.teacherPersonId===actor.personId;
        return actor.role==='student' && Object.values(state.student.attempts)
          .some(attempt=>attemptCanReadImage(state,actor,attempt,id,time));
      });
    },
    availableStudents(alias,groupId,after) {
      return store.transaction(({state,now:clock})=>{
        const actor=authorized(state,alias,clock());
        if (actor.role!=='teacher') fail('FORBIDDEN',403);
        groupFor(state,actor,safeId(groupId));
        const students=[];
        for (const id of Object.keys(state.pilot.studentsById).sort()) {
          if (after && id<=after) continue;
          const personId=state.pilot.studentsById[id], person=state.student.people[personId];
          const m=state.memberships[personId], profile=person?.profile;
          if (!person?.enabled || !profile?.registration_complete || profile.roles.length!==1 || profile.roles[0]!=='student' ||
              !m || m.active || m.affinityGroupId!==null || profile.active_group_id!==null) continue;
          if (students.length===studentDirectoryPageSize) {
            return {students,nextCursor:students.at(-1).univeracademy_id};
          }
          students.push({name:fullName(profile),univeracademy_id:id});
        }
        return {students,nextCursor:null};
      });
    },
    read(alias) {
      return store.transaction(({state,now:clock})=>{
        const time=clock();return dashboard(state,authorized(state,alias,time),time);
      });
    },
    async command(alias,action,input={},key=unique()) {
      if (!input || typeof input!=='object' || Array.isArray(input) || typeof key!=='string' || key.length>128 || !key.length)
        fail('VALIDATION_ERROR',422);
      const outcome=await store.transaction(async({state,now:clock})=>{
        const time=clock(),actor=authorized(state,alias,time);
        if (!actions[actor.role].includes(action)) fail('FORBIDDEN',403);
        const receiptKey=JSON.stringify([actor.personId,action,key]);
        // Preserve the same underlying idempotency identifier within this actor
        // and operation, even for short caller keys or identical keys on others.
        const commandKey=digest(receiptKey);
        if (action==='readDraft') return {value:editableDraft(state,testFor(state,actor,input.testId))};
        if (action==='previewTest') return {value:previewTest(state,actor,input.testId,time)};
        if (action==='acceptInvite') return {value:acceptInvite(state,actor,input,commandKey,time)};
        if (actor.role==='student') {
          if (action!=='saveAnswer') return studentAttempt(state,actor,action,input,commandKey,time);
        }
        const request=requestDigest(input), prior=state.pilot.receipts[commandKey];
        if (prior) {
          if (action==='assignTest') { groupFor(state,actor,input.groupId);testFor(state,actor,input.testId); }
          if (action==='updateDraft') requireEditable(testFor(state,actor,input.testId));
          if (request!==prior.request) fail('IDEMPOTENCY_CONFLICT',409);
          return {value:structuredClone(prior.value)};
        }
        let value;
        if (actor.role==='teacher') value=teacherCommand(state,actor,action,input,commandKey,time);
        else if (actor.role==='admin') {
          const group=recordAt(state.groups,input.groupId);
          if (!group) fail('NOT_FOUND',404);
          if (group.status==='pending') {
            group.status='active';group.revision++;
            state.audit.push({actorId:actor.personId,action:'group_approve',targetId:group.id,revision:group.revision,at:time});
          }
          value=groupView(group);
        } else {
          const answer=await studentAttempt(state,actor,action,input,commandKey,time);
          if (answer.error) return answer;
          value=answer.value;
        }
        state.pilot.receipts[commandKey]={request,value:structuredClone(value)};
        return {value};
      });
      if (outcome.error) throw new ApiFault(outcome.error.code,outcome.error.status);
      return outcome.value;
    }
  };
}
