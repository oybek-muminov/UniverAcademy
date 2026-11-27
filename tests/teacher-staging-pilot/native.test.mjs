import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import pg from 'pg';
import { forwardTeacherStaging } from '../../runtime/teacher-staging-proxy.mjs';
import { createTeacherStageNode } from '../../runtime/teacher-staging-node.mjs';
import { createTeacherStagingApi } from '../../runtime/teacher-staging-api.mjs';
import { createCabinetApi } from '../../runtime/teacher-cabinet-api.mjs';
import { createStagingInviteDeliveryStore } from '../../runtime/teacher-staging-delivery.mjs';
import { addProfile, createCluster, createServiceLogin } from './cluster.mjs';
import { proofHash } from '../../supabase/functions/univeracademy-api/student-state.ts';
import { issuer,party,ownerParty,testClerk,provisionStaff,provisionStudent } from './credentials.mjs';
import { apiOrigin,routes,studentOrigin,good,rejected,graphSvg,richDocument } from './requests.mjs';
import { testBot } from './bot.mjs';

async function afterRestart(input) {
  const program=fileURLToPath(new URL('./restart-probe.mjs',import.meta.url));
  const child=spawn(process.execPath,[program],{stdio:['pipe','pipe','pipe']});
  let output='',diagnostic='';
  child.stdout.setEncoding('utf8').on('data',value=>output+=value);
  child.stderr.setEncoding('utf8').on('data',value=>diagnostic+=value);
  const completed=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',code=>code===0?resolve():reject(Error('Restart probe: '+diagnostic)));
  });
  child.stdin.end(JSON.stringify(input));
  await completed;
  return JSON.parse(output);
}

test('staging routes require an explicit server configuration',async()=>{
  const off=createTeacherStagingApi();
  const path=party+'/api/v1/teacher/pilot/dashboard';
  const never=async()=>assert.fail('Disabled adapters must not initialize or send requests.');
  assert.equal((await off.fetch(new Request(path))).status,404);
  const offNode=createTeacherStageNode(()=>({}),never);
  assert.equal((await offNode.fetch(new Request(path))).status,404);
  for(const surface of ['teacher','student']) {
    const edge=await forwardTeacherStaging(new Request(path),{},{surface,transport:never});
    assert.equal(edge.status,404);
  }
});

test('classroom workflow with restricted logins and the captured PostgreSQL catalog',async t=>{
  const cluster=await createCluster();
  let pool,deliveryPool;
  t.after(async()=>{try {await Promise.all([pool?.end(),deliveryPool?.end()]);}finally {await cluster.close();}});
  const db=cluster.admin;
  await cluster.installDeletion();
  const migration=await readFile(new URL('../../supabase/migrations/teacher-staging/up.sql',import.meta.url),'utf8');
  await db.query(migration);
  const database=await createServiceLogin(cluster,'qa_cabinet_service',[
    {role:'ua_api_login',inherit:true,set:false},{role:'ua_cabinet_stage',inherit:false,set:true}
  ]);
  const deliveryUrl=await createServiceLogin(cluster,'qa_cabinet_delivery',[{role:'ua_cabinet_delivery',inherit:false,set:true}]);
  pool=new pg.Pool({connectionString:database,max:8});
  deliveryPool=new pg.Pool({connectionString:deliveryUrl,max:3});
  const visitor=await pool.query(`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
  assert.deepEqual(visitor.rows[0],{current_user:'qa_cabinet_service',rolsuper:false,rolbypassrls:false});
  const clerk=await testClerk();
  const teacherRow=await provisionStaff(db,'Muallim','teacher');
  const otherRow=await provisionStaff(db,'Muallima','teacher');
  const adminRow=await provisionStaff(db,'Guruh administratori','admin');
  const byId=await provisionStudent(db,'Ali','0100000021',711000021,{clerk});
  const byInvite=await provisionStudent(db,'Zebo','0100000022',711000022,{clerk});
  const outsider=await provisionStudent(db,'Sardor','0100000023',711000023);
  const configuration={enabled:true,pool,teacherOrigin:party,studentOrigin,apiOrigin,verifier:clerk.verifier,liveness:clerk.liveness,
    allowLegacyTelegram:true};
  const nodeOrigin='https://node.stage-classroom.example.com';
  const env={
    UA_CABINET_STAGING_ENABLED:'true',UA_CABINET_STAGING_NODE_ORIGIN:nodeOrigin,UA_API_ORIGIN:apiOrigin,
    UA_CABINET_TEACHER_ORIGIN:party,UA_CABINET_STAGING_PROXY_SECRET:randomBytes(32).toString('hex')
  };
  const host=createTeacherStageNode(()=>env,async()=>createTeacherStagingApi(configuration));
  const router={fetch(req){
    const surface=new URL(req.url).origin===party?'teacher':'student';
    return forwardTeacherStaging(req,env,{surface,transport:r=>host.fetch(r)});
  }};
  const teacherJWT=await clerk.sign(teacherRow.subject);
  const teacher=routes(router,'teacher',teacherJWT),other=routes(router,'teacher',await clerk.sign(otherRow.subject));
  const admin=routes(router,'admin',await clerk.sign(adminRow.subject));
  const student=routes(router,'student',byId.token),invitee=routes(router,'student',byInvite.token);
  const bystander=routes(router,'student',outsider.token);
  const directory=createStagingInviteDeliveryStore({pool:deliveryPool});
  const bot=testBot(directory,deliveryUrl);
  const scalar=async (sql,values=[])=>Number((await db.query(sql,values)).rows[0].n);
  let group,invitation,media,draft,assignment,attempt,answerId;
  await t.test('issuer, subject, opaque families and database roles determine separate access',async()=>{
    const unsourced=await host.fetch(new Request(nodeOrigin+'/api/v1/teacher/pilot/dashboard',{
      headers:{authorization:'Bearer '+teacherJWT,origin:party}
    }));
    assert.equal(unsourced.status,403);
    const options=await router.fetch(new Request(apiOrigin+'/api/v1/student/pilot/dashboard',{
      method:'OPTIONS',headers:{origin:studentOrigin,'access-control-request-method':'GET'}
    }));
    assert.equal(options.status,204);
    assert.equal(options.headers.get('access-control-allow-origin'),studentOrigin);
    const badOrigin=await router.fetch(new Request(apiOrigin+'/api/v1/student/pilot/dashboard',{
      headers:{origin:party,authorization:'Bearer '+byId.token}
    }));
    assert.equal(badOrigin.status,403);
    assert.equal((await good(teacher.dashboard())).role,'teacher');
    assert.equal((await good(admin.dashboard())).role,'admin');
    assert.equal((await good(student.dashboard())).univeracademy_id,'0100000021');
    await rejected(routes(router,'teacher',byId.token).dashboard());
    await rejected(routes(router,'student',teacherJWT).dashboard());
    await rejected(routes(router,'admin',teacherJWT).dashboard());
    const wrongIssuer=await clerk.sign(teacherRow.subject,{iss:'https://different.example.com'});
    await rejected(routes(router,'teacher',wrongIssuer).dashboard(),401);
    await rejected(routes(router,'teacher',await clerk.sign('user_UnmappedPrincipal')).dashboard());
    await rejected(teacher.call('session','POST',JSON.stringify({actor:'admin'}),{'content-type':'application/json'}));
  });

  await t.test('Owner has its own origin: it reads only its own identity, loses access on revocation and is absent from the Ustoz origin',async()=>{
    const row=await provisionStaff(db,'Loyiha egasi','owner');
    // The Owner site has its own Worker entry; the Ustoz proxy and legacy host never carry Owner routes.
    const ownerApi=createCabinetApi({enabled:true,pool,teacherOrigin:party,studentOrigin,apiOrigin,ownerOrigin:ownerParty,
      verifier:clerk.verifier,liveness:clerk.liveness,allowLegacyTelegram:false},async()=>{throw new Error('no media on the Owner site');});
    const ownerRouter={fetch:req=>ownerApi.fetch(req)};
    const sign=(subject,claims={})=>clerk.sign(subject,{azp:ownerParty,...claims});
    const jwt=await sign(row.subject);
    const owner=routes(ownerRouter,'owner',jwt);
    const reply=await owner.dashboard();
    assert.equal(reply.headers.get('cache-control'),'no-store');
    assert.equal(reply.headers.get('access-control-allow-origin'),ownerParty);
    const opened=await good(reply);
    const {teachers,overview,canAssignTeacher,appointmentHistory,accountRequestHistory,...identity}=opened;
    assert.deepEqual(accountRequestHistory,[]);
    assert.deepEqual(appointmentHistory,[]);
    assert.deepEqual(identity,{role:'owner',person_id:row.id,name:'Loyiha egasi Sinov'});
    assert.equal(canAssignTeacher,false,'the appointment migration is absent');
    assert.deepEqual(Object.keys(overview).sort(),['activeGroups','activeStudents','activeTeachers','groupsWithoutUpcomingAssignment','openAssignments','pendingGroups','submittedLast7Days']);
    assert.ok(Object.values(overview).every(n=>Number.isSafeInteger(n)&&n>=0));
    assert.ok(Array.isArray(opened.teachers));
    // Not a staff or student identity, nothing from a claim, wrong audience or another surface.
    await rejected(routes(ownerRouter,'owner',await sign(teacherRow.subject)).dashboard(),403);
    await rejected(routes(ownerRouter,'owner',await sign(adminRow.subject,{role:'owner'})).dashboard(),403);
    await rejected(routes(ownerRouter,'owner',await sign(byId.subject)).dashboard(),403);
    await rejected(routes(ownerRouter,'owner',byId.token).dashboard(),401);
    await rejected(routes(ownerRouter,'owner',await clerk.sign(row.subject)).dashboard(),401); // token minted for the Ustoz site
    await rejected(routes(ownerRouter,'teacher',jwt).dashboard(),401); // an Owner-site token is not valid for the Ustoz site
    await rejected(routes(ownerRouter,'admin',jwt).dashboard(),401);
    await rejected(owner.call('dashboard','POST'),404);
    await rejected(owner.command('approveGroup',{}),404);
    await rejected(owner.call('dashboard?person_id='+teacherRow.id),404);
    await rejected(ownerRouter.fetch(new Request(ownerParty+'/api/v1/owner/pilot/dashboard')),401);
    await rejected(ownerRouter.fetch(new Request(ownerParty+'/api/v1/owner/pilot/dashboard',{headers:{origin:party}})),403);
    // The Ustoz site and the legacy host have no Owner route at all, not even for the real Owner.
    await rejected(router.fetch(new Request(party+'/api/v1/owner/pilot/dashboard',{headers:{authorization:'Bearer '+jwt,origin:party}})),404);
    await rejected(ownerRouter.fetch(new Request(party+'/api/v1/owner/pilot/dashboard',{headers:{authorization:'Bearer '+await clerk.sign(row.subject),origin:party}})),404);
    // Without an Owner origin configured the routes simply do not exist.
    const closed=createCabinetApi({enabled:true,pool,teacherOrigin:party,studentOrigin,apiOrigin,verifier:clerk.verifier,liveness:clerk.liveness,allowLegacyTelegram:false},async()=>{});
    await rejected(closed.fetch(new Request(ownerParty+'/api/v1/owner/pilot/dashboard',{headers:{authorization:'Bearer '+jwt,origin:ownerParty}})),404);
    await db.query('UPDATE ua_private.staff_access SET approved=false WHERE person_id=$1',[row.id]);
    await rejected(owner.dashboard(),403);
    await db.query('UPDATE ua_private.staff_access SET approved=true WHERE person_id=$1',[row.id]);
    await db.query('UPDATE ua_private.people SET enabled=false WHERE id=$1',[row.id]);
    await rejected(owner.dashboard(),403);
    await db.query(`UPDATE ua_private.people_registration SET enabled=true,roles=ARRAY['admin']::text[],
      profile=jsonb_set(profile,'{roles}','["admin"]') WHERE id=$1`,[row.id]);
    await rejected(owner.dashboard(),403);
    await db.query('UPDATE ua_private.clerk_identities SET enabled=false WHERE person_id=$1',[row.id]);
    await rejected(owner.dashboard(),401);
  });

  await t.test('one person, one role: a second role closes the cabinet until the person holds a single role again',async()=>{
    const set=roles=>db.query(`UPDATE ua_private.people_registration SET roles=$2::text[],profile=jsonb_set(profile,'{roles}',to_jsonb($2::text[])) WHERE id=$1`,[teacherRow.id,roles]);
    await good(teacher.dashboard());
    await set(['student','teacher']);
    await rejected(teacher.dashboard(),403);
    await set(['teacher','admin']);
    await rejected(teacher.dashboard(),403);
    await set(['teacher']);
    await good(teacher.dashboard());
  });

  const groupKey=randomUUID();
  await t.test('a verified teacher immediately creates one usable group across concurrent retries and enrolls by leading-zero ID',async()=>{
    const data={name:'Mexanika 01',subjectId:'physics'};
    const repeated=await Promise.all([1,2].map(()=>good(teacher.command('createGroup',data,groupKey))));
    assert.equal(repeated[0].id,repeated[1].id);
    group=repeated[0];
    assert.equal(group.status,'active');
    assert.deepEqual(repeated[1],group);
    assert.equal((await good(teacher.dashboard())).groups.find(row=>row.id===group.id).status,'active');
    await rejected(teacher.command('createGroup',{...data,name:'Boshqa guruh'},groupKey),409);
    await rejected(teacher.command('createGroup',{name:'Unapproved',subjectId:'chemistry'}),403);
    await rejected(other.command('createInvite',{groupId:group.id}),404);
    assert.deepEqual((await db.query(`SELECT r.approved_by,s.person_id,g.status FROM ua_cabinet.group_requests r
      JOIN ua_private.groups g ON g.id=r.active_group_id JOIN ua_private.staff_group_scope s ON s.group_id=g.id
      WHERE r.id=$1`,[group.id])).rows,[{approved_by:teacherRow.id,person_id:teacherRow.id,status:'active'}]);
    assert.equal(await scalar("SELECT count(*) n FROM ua_private.staff_audit WHERE target_id=$1 AND action='createGroup'",[group.id]),1);
    const add={groupId:group.id,univeracademy_id:byId.cabinetId};
    const key=randomUUID();
    await Promise.all([good(teacher.command('addMember',add,key)),good(teacher.command('addMember',add,key))]);
    assert.equal(await scalar('SELECT count(*) n FROM ua_private.memberships WHERE active AND affinity_group_id=$1',[group.id]),1);
    assert.equal((await good(student.dashboard())).group.id,group.id);
  });

  await t.test('bot private start and targeted outbox grant one membership after the intended student accepts',async()=>{
    await rejected(teacher.command('sendInvite',{groupId:group.id,univeracademy_id:byInvite.cabinetId}),409);
    await bot.start(byInvite.telegramId);
    const privateLink=await good(teacher.command('createInvite',{groupId:group.id}));
    const webApp=await bot.start(byInvite.telegramId,privateLink.token);
    assert.equal(webApp.origin,studentOrigin);
    assert.equal(webApp.searchParams.get('invite'),privateLink.token);
    const key=randomUUID(), input={groupId:group.id,univeracademy_id:byInvite.cabinetId};
    const [first,again]=await Promise.all([good(teacher.command('sendInvite',input,key)),good(teacher.command('sendInvite',input,key))]);
    assert.equal(first.token,again.token);assert.equal(first.delivery,'queued');
    const delivered=[];
    const tick=bot.schedule(payload=>{
      delivered.push(payload);
      return Response.json({ok:true,result:{chat:{id:payload.chat_id},message_id:42}});
    });
    await Promise.all([tick(),tick()]);
    assert.equal(await scalar("SELECT count(*) n FROM ua_cabinet.invite_delivery WHERE token=$1 AND status='sent'",[first.token]),1);
    assert.equal(delivered.length,1);assert.equal(delivered[0].chat_id,byInvite.telegramId);
    const target=new URL(delivered[0].reply_markup.inline_keyboard[0][0].web_app.url);
    assert.equal(target.origin,studentOrigin);
    invitation=target.searchParams.get('invite');
    assert.equal(invitation,first.token);
    assert.equal((await good(invitee.dashboard())).group,null);
    await rejected(bystander.command('acceptInvite',{token:invitation}));
    const [a,b]=await Promise.all([good(invitee.command('acceptInvite',{token:invitation})),good(invitee.command('acceptInvite',{token:invitation}))]);
    assert.equal(a.id,group.id);assert.equal(b.id,group.id);
    assert.equal(await scalar('SELECT count(*) n FROM ua_private.memberships WHERE active AND affinity_group_id=$1',[group.id]),2);
    assert.equal(await scalar('SELECT count(*) n FROM ua_cabinet.redemptions WHERE student_id=$1',[byInvite.id]),1);
  });

  await t.test('scheduled delivery delays a Telegram rate limit and keeps an ambiguous send out of future ticks',async()=>{
    const target=await good(teacher.command('sendInvite',{groupId:group.id,univeracademy_id:byInvite.cabinetId}));
    const sends=[];
    const tick=bot.schedule(payload=>{
      sends.push(payload.chat_id);
      if(sends.length===1) return Response.json({ok:false,error_code:429,parameters:{retry_after:60}},{status:429});
      throw Error('lost provider response');
    });
    await tick();
    await tick();
    assert.deepEqual(sends,[byInvite.telegramId]);
    assert.equal(await scalar("SELECT count(*) n FROM ua_cabinet.invite_delivery WHERE token=$1 AND status='retry' AND available_at>clock_timestamp()",[target.token]),1);
    await db.query("UPDATE ua_cabinet.invite_delivery SET available_at=clock_timestamp() WHERE token=$1",[target.token]);
    await tick();
    await tick();
    assert.deepEqual(sends,[byInvite.telegramId,byInvite.telegramId]);
    assert.equal(await scalar("SELECT count(*) n FROM ua_cabinet.invite_delivery WHERE token=$1 AND status='unconfirmed'",[target.token]),1);
  });

  await t.test('rich test import, teacher preview, publish and group assignment preserve private question assets',async()=>{
    media=await good(teacher.upload(graphSvg,'image/svg+xml'));
    assert.equal((await teacher.image(media.id)).headers.get('content-type'),'image/png');
    await rejected(other.image(media.id));
    await rejected(student.image(media.id));
    const file=richDocument(media.id);
    draft=await good(teacher.command('importTest',file));
    const before=(await good(teacher.dashboard())).tests;
    const malformed=structuredClone(file);
    malformed.questions[0].options[1].blocks[1].latex=String.raw`\InvalidUniverCommand`;
    const invalid=await teacher.command('importTest',malformed);
    assert.equal(invalid.status,422);
    const fault=(await invalid.json()).error;
    assert.equal(fault.code,'INVALID_FORMULA');
    assert.match(fault.message,/1-savol, 2-javob, 2-blok/);
    assert.deepEqual((await good(teacher.dashboard())).tests,before);
    assert.equal(await scalar('SELECT count(*) n FROM ua_private.test_versions'),1);
    const preview=await good(teacher.command('previewTest',{testId:draft.id}));
    assert.equal(preview.questions[0].prompt_blocks[1].latex,String.raw`\frac{s}{t}`);
    await rejected(other.command('publishTest',{testId:draft.id}));
    await good(teacher.command('publishTest',{testId:draft.id}));
    const key=randomUUID(),input={testId:draft.id,groupId:group.id};
    const assigned=await Promise.all([good(teacher.command('assignTest',input,key)),good(teacher.command('assignTest',input,key))]);
    assert.equal(assigned[0].id,assigned[1].id);
    assignment=assigned[0];
    assert.equal((await good(bystander.dashboard())).assignments.length,0);
  });

  await t.test('concurrent starts create one attempt; stale updates fail and a fresh API process resumes the saved answer',async()=>{
    const key=randomUUID();
    const starts=await Promise.all([good(invitee.command('startAttempt',{assignmentId:assignment.id},key)),good(invitee.command('startAttempt',{assignmentId:assignment.id},key))]);
    attempt=starts[0];
    assert.equal(attempt.id,starts[1].id);
    assert.equal(await scalar('SELECT count(*) n FROM ua_private.attempts WHERE assignment_id=$1 AND person_id=$2',[assignment.id,byInvite.id]),1);
    assert.doesNotMatch(JSON.stringify(attempt),/correct_option_id|Maxsus o‘qituvchi izohi/);
    const q=attempt.questions[0];
    assert.equal(q.prompt_blocks[1].latex,String.raw`\frac{s}{t}`);
    const image=await invitee.image(media.id);
    assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
    const pixels=Buffer.from(await image.arrayBuffer());
    assert.equal(pixels.readUInt32BE(16),96);
    assert.equal(pixels.readUInt32BE(20),50);
    await rejected(bystander.image(media.id));
    await rejected(student.command('resumeAttempt',{attemptId:attempt.id}));
    answerId=q.options.find(o=>o.blocks.some(b=>b.latex===String.raw`\frac{20}{4}`)).id;
    const answer={attemptId:attempt.id,questionId:q.id,optionId:answerId,expectedRevision:0};
    const saveKey=randomUUID();
    const replies=await Promise.all([good(invitee.command('saveAnswer',answer,saveKey)),good(invitee.command('saveAnswer',answer,saveKey))]);
    assert.equal(replies[0].revision,1);assert.deepEqual(replies[1],replies[0]);
    await rejected(invitee.command('saveAnswer',{...answer,optionId:q.options.find(o=>o.id!==answerId).id}),409);
    const resumed=await afterRestart({database,auth:clerk.publicConfiguration(),token:byInvite.token,attempt:attempt.id});
    assert.equal(resumed.id,attempt.id);
    assert.deepEqual(resumed.questions,attempt.questions);
    assert.equal(resumed.answers.find(a=>a.questionId===q.id).optionId,answerId);
  });

  await t.test('submitted score is persisted exactly once and remains visible only to its teacher and learner',async()=>{
    const key=randomUUID();
    const grade=await good(invitee.command('submitAttempt',{attemptId:attempt.id},key));
    assert.equal(grade.percentage,'100.00');
    assert.deepEqual(await good(invitee.command('submitAttempt',{attemptId:attempt.id},key)),grade);
    assert.equal(await scalar('SELECT count(*) n FROM ua_private.ordinary_results WHERE attempt_id=$1',[attempt.id]),1);
    assert.equal((await good(teacher.dashboard())).results.find(r=>r.attemptId===attempt.id).earned,'1.0');
    assert.equal((await good(invitee.dashboard())).results.find(r=>r.attemptId===attempt.id).percentage,'100.00');
    assert.deepEqual((await good(other.dashboard())).results,[]);
    assert.deepEqual((await good(student.dashboard())).results,[]);
    await rejected(invitee.image(media.id));
  });

  await t.test('media access follows the current active group and original grant epoch on every fetch',async()=>{
    const opened=await good(student.command('startAttempt',{assignmentId:assignment.id}));
    assert.equal(opened.status,'in_progress');
    assert.equal((await student.image(media.id)).status,200);
    // A teacher cannot remove a student while that student's test is running.
    const busyRemoval=await teacher.command('removeMember',{groupId:group.id,univeracademy_id:byId.cabinetId});
    assert.equal(busyRemoval.status,409);
    assert.equal((await busyRemoval.json()).error.code,'ACTIVE_EXAM_OR_RECOVERY');
    assert.equal((await db.query('SELECT active FROM ua_private.memberships WHERE person_id=$1',[byId.id])).rows[0].active,true);
    // Simulate the canonical administrative release. The membership/profile projection is deferred to commit.
    await db.query('BEGIN');
    try {
      await db.query('UPDATE ua_private.memberships SET active=false,affinity_group_id=NULL,epoch=epoch+1,revision=revision+1 WHERE person_id=$1',[byId.id]);
      await db.query(`UPDATE ua_private.people SET profile=jsonb_set(profile,'{active_group_id}','null'::jsonb) WHERE id=$1`,[byId.id]);
      await db.query('COMMIT');
    } catch(error) {await db.query('ROLLBACK');throw error;}
    await rejected(student.image(media.id),404);
    await good(teacher.command('addMember',{groupId:group.id,univeracademy_id:byId.cabinetId}));
    assert.equal((await good(student.dashboard())).group.id,group.id);
    // New membership in the same group cannot revalidate the old assignment grant.
    await rejected(student.image(media.id),404);
    await rejected(student.command('resumeAttempt',{attemptId:opened.id}),403);
  });

  await t.test('operator down/up retains canonical work, closes both stage roles and restores the same data',async()=>{
    const versionCount=await scalar('SELECT count(*) n FROM ua_private.test_versions');
    const down=await readFile(new URL('../../supabase/migrations/teacher-staging/down.sql',import.meta.url),'utf8');
    await db.query(down);
    const [disabled]=(await db.query(`SELECT to_regnamespace('ua_cabinet') IS NULL gone,
      has_schema_privilege('ua_cabinet_stage','ua_cabinet_retained','USAGE') stage,
      has_schema_privilege('ua_cabinet_delivery','ua_cabinet_retained','USAGE') delivery`)).rows;
    assert.deepEqual(disabled,{gone:true,stage:false,delivery:false});
    assert.equal(await scalar('SELECT count(*) n FROM ua_private.test_versions'),versionCount);
    assert.equal(await scalar('SELECT count(*) n FROM ua_cabinet_retained.media WHERE id=$1',[media.id]),1);
    await db.query(migration);
    assert.equal((await good(teacher.dashboard())).tests.find(row=>row.id===draft.id).status,'published');
    assert.equal((await good(invitee.dashboard())).group.id,group.id);
    assert.equal((await teacher.image(media.id)).status,200);
  });

  await t.test('deleting a linked student clears delivery records and keeps the teacher’s test and other learner',async()=>{
    // Compose with the actual reviewed deletion transaction rather than issuing a manual person DELETE.
    await db.query('UPDATE ua_private.account_deletion_control SET accepting=true');
    const job=randomUUID(),lease=randomUUID(),receipt=randomBytes(32).toString('hex');
    const prepared=await db.query('SELECT * FROM ua_private.prepare_account_deletion($1,$2,$3,$4,$5,$6,$7,$8)',
      [job,byInvite.id,await proofHash(byInvite.token),issuer,byInvite.subject,byInvite.sessionId,receipt,Date.now()]);
    assert.equal(prepared.rows[0].state,'pending');
    await rejected(invitee.dashboard());
    await db.query('SELECT * FROM ua_private.claim_account_deletion($1,$2)',[job,lease]);
    assert.equal((await db.query('SELECT ua_private.mark_account_provider_deleted($1,$2) ok',[job,lease])).rows[0].ok,true);
    assert.equal((await db.query('SELECT ua_private.finish_account_deletion($1,$2) ok',[job,lease])).rows[0].ok,true);
    assert.equal(await scalar('SELECT count(*) n FROM ua_private.people WHERE id=$1',[byInvite.id]),0);
    assert.equal(await scalar('SELECT count(*) n FROM ua_cabinet.redemptions WHERE student_id=$1',[byInvite.id]),0);
    assert.equal(await scalar('SELECT count(*) n FROM ua_cabinet.invites WHERE recipient_id=$1',[byInvite.id]),0);
    assert.equal(await scalar('SELECT count(*) n FROM ua_cabinet.invite_delivery WHERE telegram_id=$1',[byInvite.telegramId]),0);
    assert.equal(await scalar('SELECT count(*) n FROM ua_cabinet.private_starts WHERE telegram_id=$1',[byInvite.telegramId]),0);
    assert.equal((await good(teacher.dashboard())).groups.find(row=>row.id===group.id).members.length,1);
    assert.equal((await good(student.dashboard())).univeracademy_id,byId.cabinetId);
    assert.equal((await good(teacher.dashboard())).tests.find(row=>row.id===draft.id).status,'published');
  });

  await t.test('the teacher directory pages through eligible students and enrollment rechecks the choice under lock',async()=>{
    const ownerGroup=await good(teacher.command('createGroup',{name:'Ro‘yxat',subjectId:'physics'}));
    const otherGroup=await good(other.command('createGroup',{name:'Boshqa sinf',subjectId:'physics'}));
    const path=id=>'groups/'+id+'/available-students';
    const directory=path(ownerGroup.id);
    const expected=[],people=[];
    for(let i=0;i<32;i++){
      const cabinetId='09'+String(i).padStart(8,'0'),name='Talaba '+i;
      people.push(await addProfile(db,{name,role:'student',cabinetId}));
      expected.push({name:name+' Sinov',univeracademy_id:cabinetId});
    }
    const staff=people[28],disabled=people[29],incomplete=people[30],historic=people[31];
    await db.query("UPDATE ua_private.people SET roles=ARRAY['student','teacher'],profile=jsonb_set(profile,'{roles}',to_jsonb(ARRAY['student','teacher'])) WHERE id=$1",[staff]);
    await db.query('UPDATE ua_private.people SET enabled=false WHERE id=$1',[disabled]);
    await db.query("UPDATE ua_private.people SET profile=jsonb_set(profile,'{registration_complete}','false'::jsonb) WHERE id=$1",[incomplete]);
    await db.query('UPDATE ua_private.memberships SET affinity_group_id=$1 WHERE person_id=$2',[otherGroup.id,historic]);
    const eligible=expected.slice(0,28);
    const first=await good(teacher.call(directory+'?after=0800000000'));
    assert.deepEqual(first,{students:eligible.slice(0,25),nextCursor:eligible[24].univeracademy_id});
    assert.deepEqual(await good(teacher.call(directory+'?after='+first.nextCursor)),{students:eligible.slice(25),nextCursor:null});
    assert.deepEqual(await good(teacher.call(directory+'?after='+eligible[2].univeracademy_id)),{students:eligible.slice(3),nextCursor:null});
    assert.deepEqual(await good(teacher.call(directory+'?after=9999999999')),{students:[],nextCursor:null});
    const unfiltered=await teacher.call(directory);
    assert.equal(unfiltered.headers.get('cache-control'),'no-store');
    assert.equal((await good(unfiltered)).students.length,25);
    for(const suffix of ['?after=no','?after=','?after=12345','?after=0000000001&extra=x','?after=0000000001&after=0000000002','?limit=500'])
      await rejected(teacher.call(directory+suffix),404);
    await rejected(teacher.call(directory,'POST'),404);
    await rejected(other.call(directory),404);
    await rejected(admin.call(directory),404);
    await rejected(routes(router,'teacher',byId.token).call(directory));
    await rejected(student.call(directory),404);
    await rejected(teacher.call(path(randomUUID())),404);
    for(const i of [28,29,30])await rejected(teacher.command('addMember',{groupId:ownerGroup.id,univeracademy_id:expected[i].univeracademy_id}),404);
    await rejected(teacher.command('addMember',{groupId:ownerGroup.id,univeracademy_id:expected[31].univeracademy_id}),409);

    const selected=eligible[0].univeracademy_id;
    const enrollment={groupId:ownerGroup.id,univeracademy_id:selected};
    await db.query('BEGIN');
    try{
      await db.query('SELECT 1 FROM ua_private.memberships WHERE person_id=$1 FOR UPDATE',[people[0]]);
      const busy=await teacher.command('addMember',enrollment);
      assert.equal(busy.status,409);
      assert.equal((await busy.json()).error.code,'MEMBERSHIP_BUSY');
    }finally{await db.query('ROLLBACK');}
    await good(other.command('addMember',{...enrollment,groupId:otherGroup.id}));
    const stale=await teacher.command('addMember',enrollment);
    assert.equal(stale.status,409);
    assert.equal((await stale.json()).error.code,'GROUP_MEMBERSHIP_CONFLICT');
    assert.equal((await good(teacher.call(directory+'?after=0800000000'))).students.some(row=>row.univeracademy_id===selected),false);
    assert.equal((await db.query('SELECT affinity_group_id FROM ua_private.memberships WHERE person_id=$1',[people[0]])).rows[0].affinity_group_id,otherGroup.id);
    // Removal: only the owning teacher, only from the group the student is really in.
    const removal={groupId:otherGroup.id,univeracademy_id:selected};
    await rejected(teacher.command('removeMember',removal),404);
    await rejected(other.command('removeMember',{...removal,groupId:ownerGroup.id}),404);
    const before=(await db.query('SELECT revision,epoch FROM ua_private.memberships WHERE person_id=$1',[people[0]])).rows[0];
    const removeKey=randomUUID();
    await good(other.command('removeMember',removal,removeKey));
    await good(other.command('removeMember',removal,removeKey));
    const after=(await db.query(`SELECT m.active,m.affinity_group_id,m.revision,m.epoch,p.profile->>'active_group_id' AS profile_group
      FROM ua_private.memberships m JOIN ua_private.people p ON p.id=m.person_id WHERE m.person_id=$1`,[people[0]])).rows[0];
    assert.deepEqual({active:after.active,group:after.affinity_group_id,profile:after.profile_group},{active:false,group:null,profile:null});
    assert.equal(Number(after.revision),Number(before.revision)+1);
    assert.equal(Number(after.epoch),Number(before.epoch)+1);
    assert.equal(await scalar("SELECT count(*) n FROM ua_private.staff_audit WHERE action='removeMember' AND target_id=$1",[otherGroup.id]),1);
    await rejected(other.command('removeMember',removal),404);
    assert.equal((await good(other.dashboard())).groups.find(row=>row.id===otherGroup.id).members.some(row=>row.univeracademy_id===selected),false);
    assert.equal((await good(teacher.call(directory+'?after=0800000000'))).students.some(row=>row.univeracademy_id===selected),true);
    // The student is free again; the state before the check is restored.
    await good(other.command('addMember',removal));
    // A deletion request is recorded once, shown on the dashboard, and is open to teachers only.
    assert.equal((await good(teacher.dashboard())).deletionRequested,false);
    await good(teacher.command('requestAccountDeletion',{}));
    await good(teacher.command('requestAccountDeletion',{}));
    assert.equal((await good(teacher.dashboard())).deletionRequested,true);
    assert.equal(await scalar("SELECT count(*) n FROM ua_private.staff_audit WHERE action='requestAccountDeletion' AND actor_id=$1",[teacherRow.id]),1);
    assert.equal((await good(other.dashboard())).deletionRequested,false);
    await rejected(student.command('requestAccountDeletion',{}));
    await db.query('UPDATE ua_private.teacher_subject_approvals SET revoked_at_ms=1 WHERE person_id=$1',[teacherRow.id]);
    await rejected(teacher.call(directory),403);
    await db.query('UPDATE ua_private.teacher_subject_approvals SET revoked_at_ms=NULL WHERE person_id=$1',[teacherRow.id]);
    await db.query("UPDATE ua_private.groups SET status='archived' WHERE id=$1",[ownerGroup.id]);
    await rejected(teacher.call(directory),409);
    await db.query('UPDATE ua_private.staff_group_scope SET revoked_at_ms=1 WHERE person_id=$1 AND group_id=$2',[teacherRow.id,ownerGroup.id]);
    await rejected(teacher.call(directory),404);
  });

  await t.test('a scheduled PostgreSQL assignment denies early admission and opens through the same HTTP route at the selected time',async()=>{
    const test=await good(teacher.command('importTest',{title:'Belgilanadigan vaqt',duration_seconds:300,
      questions:[{text:'1+1',options:['1','2','3','4'],correctIndex:1}]}));
    await good(teacher.command('publishTest',{testId:test.id}));
    const now=(await good(student.dashboard())).serverNow,startsAt=now+4500;
    const spec={groupId:group.id,testId:test.id,startsAt},key=randomUUID();
    await rejected(teacher.command('assignTest',{...spec,startsAt:now-1}),422);
    await rejected(other.command('assignTest',spec),404);
    const [scheduled,retry]=await Promise.all([1,2].map(()=>good(teacher.command('assignTest',spec,key))));
    assert.deepEqual(retry,scheduled);assert.equal(scheduled.opensAt,startsAt);
    assert.equal(scheduled.timezone,'Asia/Tashkent');
    assert.equal((await good(teacher.dashboard())).assignments.find(a=>a.id===scheduled.id).closesAt,scheduled.closesAt);
    const scheduledRow=(await good(student.dashboard())).assignments.find(a=>a.id===scheduled.id);
    assert.equal(scheduledRow.status,'scheduled');assert.equal(scheduledRow.opensAt,startsAt);
    const attemptKey=randomUUID();
    const start=()=>student.command('startAttempt',{assignmentId:scheduled.id},attemptKey);
    await rejected(start(),409);
    assert.equal(await scalar('SELECT count(*) n FROM ua_private.attempts WHERE assignment_id=$1',[scheduled.id]),0);
    const saved=(await db.query("SELECT record->'admission' admission FROM ua_private.assignments WHERE id=$1",[scheduled.id])).rows[0].admission;
    assert.deepEqual([saved.opensAt,saved.closesAt],[scheduled.opensAt,scheduled.closesAt]);
    await delay(Math.max(0,startsAt-Date.now())+10);
    assert.equal((await good(student.dashboard())).assignments.find(a=>a.id===scheduled.id).status,'available');
    const live=await good(start());
    assert.equal(live.status,'in_progress');
    const times=(await db.query('SELECT body FROM ua_private.attempts WHERE id=$1',[live.id])).rows[0].body;
    assert.ok(times.startedAt>=startsAt);
    assert.equal(times.deadlineAt,Math.min(times.startedAt+300000,scheduled.closesAt));
    // The phone shows the remaining time from the server's clock, so the start reply carries it.
    assert.equal(live.serverNow,times.startedAt);
    assert.deepEqual(await good(teacher.command('assignTest',spec,key)),scheduled);
    await rejected(teacher.command('assignTest',{...spec,startsAt:startsAt+60000},key),409);

    // A pre-release receipt stores the identity only. Replaying it reads the immutable admission window.
    const oldKey=randomUUID(),legacyInput={groupId:group.id,testId:draft.id};
    const digest=value=>createHash('sha256').update(value).digest('hex');
    const receipt=teacherRow.id+'/staging/assignTest/'+digest(oldKey);
    const oldResponse={id:assignment.id,groupId:group.id,testId:draft.id,title:assignment.title};
    await db.query('BEGIN');
    try{
      await db.query('INSERT INTO ua_private.staff_audit(command_key,actor_id,action,target_id,revision,at_ms) VALUES($1,$2,$3,$4,0,$5)',
        [receipt,teacherRow.id,'assignTest',assignment.id,Date.now()]);
      await db.query('INSERT INTO ua_private.staff_receipts(actor_id,key,payload,response) VALUES($1,$2,$3,$4)',
        [teacherRow.id,receipt,digest(JSON.stringify(legacyInput)),oldResponse]);
      await db.query('COMMIT');
    }catch(error){await db.query('ROLLBACK');throw error;}
    assert.deepEqual(await good(teacher.command('assignTest',legacyInput,oldKey)),assignment);
  });

  await t.test('a late audit write failure rolls back group, scope, request and receipt; the same command can retry',async()=>{
    const input={name:'Atomar guruh',subjectId:'physics'},key=randomUUID();
    const counts=async()=>(await db.query(`SELECT
      (SELECT count(*) FROM ua_cabinet.group_requests) AS requests,
      (SELECT count(*) FROM ua_private.groups) AS groups,
      (SELECT count(*) FROM ua_private.staff_group_scope) AS scopes,
      (SELECT count(*) FROM ua_private.staff_receipts) AS receipts`)).rows[0];
    const before=await counts();
    await db.query("ALTER TABLE ua_private.staff_audit ADD CONSTRAINT qa_reject_group CHECK(action<>'createGroup') NOT VALID");
    try { await rejected(other.command('createGroup',input,key),500); }
    finally { await db.query('ALTER TABLE ua_private.staff_audit DROP CONSTRAINT qa_reject_group'); }
    assert.deepEqual(await counts(),before);
    const created=await good(other.command('createGroup',input,key));
    assert.equal(created.status,'active');
    assert.deepEqual(await good(other.command('createGroup',input,key)),created);
  });

  await t.test('legacy pending requests activate on owner sign-in, first use or receipt replay, within current subject and scope',async()=>{
    async function pending(name,subject='physics'){
      const id=randomUUID();
      await db.query('INSERT INTO ua_cabinet.group_requests(id,teacher_id,subject_id,name) VALUES($1,$2,$3,$4)',
        [id,otherRow.id,subject,name]);
      return id;
    }
    const byDashboard=await pending('Eski guruh'),unapproved=await pending('Kimyo','chemistry');
    const isPending=async id=>await scalar('SELECT count(*) n FROM ua_cabinet.group_requests WHERE id=$1 AND active_group_id IS NULL',[id])===1;
    await good(teacher.dashboard());
    await good(admin.dashboard());
    await rejected(teacher.command('createInvite',{groupId:byDashboard}),404);
    assert.equal(await isPending(byDashboard),true);
    const deny=async sql=>{
      await db.query(sql,[otherRow.id]);
      await rejected(other.dashboard(),403);
      assert.equal(await isPending(byDashboard),true);
    };
    await deny('UPDATE ua_private.staff_access SET approved=false WHERE person_id=$1');
    await db.query('UPDATE ua_private.staff_access SET approved=true WHERE person_id=$1',[otherRow.id]);
    await deny('UPDATE ua_private.teacher_subject_approvals SET revoked_at_ms=123 WHERE person_id=$1');
    await db.query('UPDATE ua_private.teacher_subject_approvals SET revoked_at_ms=NULL WHERE person_id=$1',[otherRow.id]);
    const [first,again]=await Promise.all([good(other.dashboard()),good(other.dashboard())]);
    for(const result of [first,again]){
      assert.equal(result.groups.find(row=>row.id===byDashboard).status,'active');
      assert.equal(result.groups.some(row=>row.id===unapproved),false);
    }
    assert.equal(await isPending(unapproved),true);
    const byCommand=await pending('Yangi taklif');
    assert.equal((await good(other.command('createInvite',{groupId:byCommand}))).groupId,byCommand);
    const byReceipt=await pending('Eski kvitansiya'),key=randomUUID(),input={name:'Eski kvitansiya'};
    const digest=value=>createHash('sha256').update(value).digest('hex');
    const receipt=otherRow.id+'/staging/createGroup/'+digest(key);
    const old={id:byReceipt,name:input.name,status:'pending',subjectId:'physics'};
    await db.query('BEGIN');
    await db.query('INSERT INTO ua_private.staff_audit(command_key,actor_id,action,target_id,revision,at_ms) VALUES($1,$2,$3,$4,0,$5)',
      [receipt,otherRow.id,'createGroup',byReceipt,Date.now()]);
    await db.query('INSERT INTO ua_private.staff_receipts(actor_id,key,payload,response) VALUES($1,$2,$3,$4)',
      [otherRow.id,receipt,digest(JSON.stringify(input)),old]);
    await db.query('COMMIT');
    await db.query("INSERT INTO ua_private.teacher_subject_approvals VALUES($1,'history',true,NULL)",[otherRow.id]);
    await rejected(other.command('createGroup',{name:'Boshqa'},key),409);
    assert.equal(await isPending(byReceipt),true);
    assert.deepEqual(await good(other.command('createGroup',input,key)),{...old,status:'active'});
    await rejected(other.command('createGroup',{name:'Fan kerak'}),422);
    await db.query("UPDATE ua_private.groups SET status='archived' WHERE id=$1",[byReceipt]);
    assert.equal((await good(other.command('createGroup',input,key))).status,'archived');
    await rejected(other.command('createInvite',{groupId:byReceipt}),409);
    await db.query('UPDATE ua_private.staff_group_scope SET revoked_at_ms=123 WHERE person_id=$1 AND group_id=$2',[otherRow.id,byReceipt]);
    await db.query('INSERT INTO ua_private.staff_group_scope(person_id,group_id) VALUES($1,$2)',[teacherRow.id,byReceipt]);
    assert.equal((await good(other.dashboard())).groups.some(row=>row.id===byReceipt),false);
    await rejected(other.command('createGroup',input,key),404);
    await rejected(teacher.command('createInvite',{groupId:byReceipt}),404);
    const byOldClient=await pending('Old client');
    assert.equal((await good(admin.command('approveGroup',{groupId:byOldClient}))).status,'active');
    await good(other.dashboard());
    assert.equal((await db.query('SELECT approved_by FROM ua_cabinet.group_requests WHERE id=$1',[byOldClient])).rows[0].approved_by,adminRow.id);
  });

  await t.test('revoking a staff mapping or an opaque family closes even a previously successful replay',async()=>{
    await db.query('UPDATE ua_private.clerk_identities SET enabled=false WHERE person_id=$1',[teacherRow.id]);
    await rejected(teacher.command('createGroup',{name:'Mexanika 01',subjectId:'physics'},groupKey));
    await db.query('UPDATE ua_private.student_families SET revoked_at_ms=$1 WHERE id=$2',[Date.now(),byId.familyId]);
    await rejected(student.dashboard());
  });
});
