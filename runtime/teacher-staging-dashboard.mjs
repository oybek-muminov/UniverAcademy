import {studentAssignmentStatus} from './teacher-assignment-schedule.mjs';
import {AttemptRows,decodeRatio} from '../supabase/functions/univeracademy-api/storage/attempt-rows.ts';
import {candidateHalfUp2,studentPointsHalfUp1} from '../supabase/functions/univeracademy-api/student-wire.ts';
import {expireForMembershipGuard} from '../supabase/functions/univeracademy-api/attempts.ts';
import {query,groupView,archivedFilter} from './teacher-staging-content.mjs';

const profileNameSql="concat_ws(' ',nullif(p.profile->>'first_name',''),nullif(p.profile->>'last_name',''))";
export function displayName(profile){return [profile.first_name,profile.last_name].filter(Boolean).join(' ');}
// Materialize elapsed current attempts with their own locked student row. A concurrent
// student request owns any skipped row and will finish its own transition.
export async function expireVisible(tx,person,groupIds,teacher){
  const due=await query(tx,`SELECT t.id,t.person_id FROM ua_private.attempts t JOIN ua_private.exam_series es ON es.current_attempt_id=t.id
    JOIN ua_private.people p ON p.id=t.person_id JOIN ua_private.assignments a ON a.id=t.assignment_id
    WHERE t.body->>'status'='in_progress' AND (t.body->>'deadlineAt')::numeric<=extract(epoch FROM clock_timestamp())*1000
    AND (($3::boolean AND a.group_id=ANY($2::uuid[])) OR (NOT $3 AND p.id=$1))
    ORDER BY p.id,t.id FOR UPDATE OF p SKIP LOCKED`,[person,groupIds,teacher]);
  if(!due.length)return;
  const now=Number((await query(tx,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text value'))[0].value);
  const persist=new AttemptRows();
  for(const row of due){
    const locked={client:tx.client,personIds:[row.person_id],now};
    const before=await persist.load(locked,row.person_id,row.id),after=expireForMembershipGuard(before,now);
    if(before!==after)await persist.persist(locked,before,after);
  }
}
export async function dashboard(tx,actor){
  const base={role:actor.role,person_id:actor.personId,name:displayName(actor.profile)};
  if(actor.role==='owner')return base;
  if(actor.role==='admin'){
    const gs=await query(tx,`SELECT r.id,r.name,r.subject_id,COALESCE(g.status,'pending') status,${profileNameSql} AS teacher_name FROM ua_cabinet.group_requests r
      LEFT JOIN ua_private.groups g ON g.id=r.active_group_id JOIN ua_private.people p ON p.id=r.teacher_id
      WHERE $1::boolean OR r.subject_id=ANY($2::text[]) ORDER BY r.created_at,r.id`,[actor.scope.all_groups,actor.scope.subject_ids]);
    return {...base,groups:gs.map(g=>({...groupView(g),teacherName:g.teacher_name}))};
  }
  const teacher=actor.role==='teacher',person=actor.personId;
  // A teacher's own request to delete the account lives in the audit trail; nothing is deleted automatically.
  if(teacher)base.deletionRequested=actor.deletionRequested===true;
  const groups=teacher?await query(tx,`SELECT r.id,r.name,r.subject_id,g.status FROM ua_cabinet.group_requests r
    JOIN ua_private.groups g ON g.id=r.active_group_id
    JOIN ua_private.staff_group_scope s ON s.group_id=g.id AND s.person_id=r.teacher_id AND s.revoked_at_ms IS NULL
    WHERE r.teacher_id=$1 AND r.subject_id=ANY($2::text[]) ORDER BY r.created_at,r.id`,[person,actor.approvedSubjectIds]):
    await query(tx,`SELECT r.id,r.name,r.subject_id,g.status FROM ua_private.memberships m JOIN ua_private.groups g ON g.id=m.affinity_group_id
    JOIN ua_cabinet.group_requests r ON r.active_group_id=g.id WHERE m.person_id=$1 AND m.active`,[person]);
  const tests=teacher?await query(tx,`SELECT v.id,d.title,v.status,d.subject_id "subjectId",(v.wire->>'duration_seconds')::int duration_seconds,
    (SELECT count(*)::int FROM ua_private.draft_questions q WHERE q.version_id=v.id) "questionCount"
    FROM ua_cabinet.test_owners o JOIN ua_private.test_versions v ON v.id=o.version_id JOIN ua_private.demos d ON d.id=v.demo_id
    WHERE o.teacher_id=$1 AND d.subject_id=ANY($2::text[]) ${await archivedFilter(tx,'v')} ORDER BY v.id`,[person,actor.approvedSubjectIds]):[];
  const subjects=teacher?actor.approvedSubjectIds.map(id=>({id,title:id})):[];
  if(teacher&&!groups.length)return {...base,subjects,groups:[],tests,assignments:[],results:[]};
  const ids=groups.map(g=>g.id);
  await expireVisible(tx,person,ids,teacher);
  const assignments=ids.length?await query(tx,`SELECT a.id,a.group_id "groupId",a.version_id "testId",d.title,
    a.record#>'{admission,opensAt}' AS "opensAt",a.record#>'{admission,closesAt}' AS "closesAt",a.record#>>'{reviewGate,timezone}' AS timezone,
    a.record->'cancelled' AS cancelled,t.id "attemptId",t.body->>'status' AS status FROM ua_private.assignments a
    JOIN ua_private.demos d ON d.id=a.demo_id LEFT JOIN ua_private.grants gr ON gr.assignment_id=a.id AND gr.person_id=$2
    LEFT JOIN ua_private.memberships m ON m.person_id=gr.person_id LEFT JOIN ua_private.exam_series es ON es.person_id=$2 AND es.demo_id=a.demo_id
    LEFT JOIN ua_private.attempts t ON t.id=es.current_attempt_id AND t.assignment_id=a.id
    WHERE a.group_id=ANY($1::uuid[]) AND ($3::boolean OR(gr.rostered AND m.active AND m.epoch=gr.grant_epoch)) ORDER BY a.id`,[ids,person,teacher]):[];
  const results=(await query(tx,`SELECT t.id "attemptId",a.id "assignmentId",a.group_id "groupId",d.title,${profileNameSql} AS student_name,r.exact_result
    FROM ua_private.ordinary_results r JOIN ua_private.attempts t ON t.id=r.attempt_id JOIN ua_private.assignments a ON a.id=t.assignment_id
    JOIN ua_private.demos d ON d.id=a.demo_id JOIN ua_private.people p ON p.id=t.person_id
    WHERE (($3::boolean AND a.group_id=ANY($1::uuid[])) OR (NOT $3 AND t.person_id=$2)) ORDER BY t.id`,[ids,person,teacher])).map(({student_name,exact_result,...info})=>({
    ...info,studentName:student_name,earned:studentPointsHalfUp1(decodeRatio(exact_result.earned)),maximum:studentPointsHalfUp1(decodeRatio(exact_result.maximum)),
    percentage:candidateHalfUp2(decodeRatio(exact_result.percentage))}));
  if(!teacher)return {...base,univeracademy_id:actor.cabinetId,group:groups.length?groupView(groups[0]):null,serverNow:tx.now,
    assignments:assignments.map(({cancelled,...row})=>({...row,status:studentAssignmentStatus(row,tx.now,row.status,cancelled)})),results};
  const members=await query(tx,`SELECT m.affinity_group_id,${profileNameSql} AS name,p.univeracademy_id FROM ua_private.people_registration p
    JOIN ua_private.memberships m ON m.person_id=p.id WHERE p.enabled AND m.active AND m.affinity_group_id=ANY($1::uuid[]) ORDER BY p.id`,[ids]);
  const rosters=new Map();
  for(const {affinity_group_id,name,univeracademy_id} of members){
    if(!rosters.has(affinity_group_id))rosters.set(affinity_group_id,[]);
    rosters.get(affinity_group_id).push({name,univeracademy_id});
  }
  return {...base,subjects,groups:groups.map(g=>({...groupView(g),members:rosters.get(g.id)??[]})),
    tests,assignments:assignments.map(({attemptId,status,cancelled,...a})=>a),results};
}
