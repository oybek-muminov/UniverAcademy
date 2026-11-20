// Exercise the built Ustoz Pages and production API bundles with private, local-only services.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCluster, createServiceLogin } from './cluster.mjs';
import { issuer, party, provisionStaff, provisionStudent, testClerk } from './credentials.mjs';
import { apiOrigin, good, graphSvg, rejected, richDocument, routes, studentOrigin } from './requests.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const pages=join(root,'apps/teacher-web/ustoz-pages');
const {Miniflare,convertV4MiniflareOptions}=createRequire(join(pages,'package.json'))('miniflare');
const build=promisify(execFile);
const bundle=await mkdtemp(join(tmpdir(),'ua-cabinet-workerd-'));
let cluster,mf;
try {
  await build(process.execPath,[join(pages,'node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run',
    '--config','wrangler.api.registration-only.jsonc','--outdir',bundle],{
    cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'}
  });
  const modules=[{type:'ESModule',path:join(bundle,'cloudflare-worker.js')}];
  for (const file of await readdir(bundle)) {
    if(file.endsWith('.wasm') || file.endsWith('.bin')) modules.push({type:file.endsWith('.wasm')?'CompiledWasm':'Data',path:join(bundle,file)});
  }
  const botBundle=join(bundle,'bot');
  await build(process.execPath,[join(pages,'node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run',
    '--config','apps/telegram-bot/wrangler.json','--outdir',botBundle],{
    cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'}
  });
  const botCode=await readFile(join(botBundle,'lifecycle-cloudflare-entry.js'),'utf8');
  const gateway=await readFile(join(root,'apps/mini-app/dist-teacher-entrance/_worker.js/index.js'),'utf8');
  cluster=await createCluster();
  const db=cluster.admin;
  await db.query(await readFile(join(root,'supabase/migrations/teacher-staging/up.sql'),'utf8'));
  await db.query('ALTER SCHEMA ua_cabinet OWNER TO ua_owner');
  await db.query(await readFile(join(root,'supabase/migrations/teacher-staging/draft-edit/001_up.sql'),'utf8'));
  const connection=await createServiceLogin(cluster,'qa_workerd_cabinet',[
    {role:'ua_api_login',inherit:true,set:false},{role:'ua_cabinet_stage',inherit:false,set:true}
  ]);
  const delivery=await createServiceLogin(cluster,'qa_workerd_delivery',[{role:'ua_cabinet_delivery',inherit:false,set:true}]);
  const lookup=await createServiceLogin(cluster,'qa_workerd_lookup',[{role:'ua_api_login',inherit:true,set:false}]);
  const clerk=await testClerk(), teacher=await provisionStaff(db,'Muallim','teacher'),admin=await provisionStaff(db,'Tasdiq','admin');
  const account=await provisionStudent(db,'O‘quvchi','0000000017',710300035,{clerk});
  const invitee=await provisionStudent(db,'Taklifli','0000000018',710300036,{clerk});
  const botOrigin='https://bot.stage-classroom.example.com', webhookSecret=randomBytes(24).toString('hex');
  const teacherJwt=await clerk.sign(teacher.subject),adminJwt=await clerk.sign(admin.subject);
  const {jwk,sessions}=clerk.publicConfiguration();
  const users=new Map(sessions.map(([,s])=>[s.userId,s])), sessionById=new Map(sessions);
  const clerkCalls=[];
  async function clerkProvider(request) {
    const url=new URL(request.url);
    clerkCalls.push(url.pathname);
    if(request.url===issuer+'/.well-known/jwks.json') return Response.json({keys:[jwk]});
    assert.equal(url.origin,'https://api.clerk.com');
    assert.equal(request.headers.get('authorization'),'Bearer local-session-fixture');
    const [,v1,kind,id]=url.pathname.split('/');
    assert.equal(v1,'v1');
    if(kind==='sessions'&&sessionById.has(id)){
      const s=sessionById.get(id);
      return Response.json({id,user_id:s.userId,status:'active',actor:null,expire_at:s.expiresAt,abandon_at:s.expiresAt});
    }
    assert.equal(kind,'users');assert.ok(users.has(id));
    return Response.json({id,banned:false,locked:false,deprovisioned:false});
  }
  const switches={UA_CABINET_RUNTIME:'worker',UA_CABINET_STAGING_ENABLED:'true',UA_CABINET_TEACHER_ORIGIN:party};
  const date='2026-11-11';
  mf=new Miniflare(convertV4MiniflareOptions({workers:[
    {name:'staff',modules:true,script:gateway,compatibilityDate:date,routes:[party+'/*'],bindings:switches,
      serviceBindings:{UA_CABINET_API:{name:'api',entrypoint:'TeacherCabinetGateway'},ASSETS:()=>new Response('static fixture')},
      outboundService:()=>{throw Error('Pages unexpectedly requested external transport');}},
    {name:'bot',modules:true,script:botCode,compatibilityDate:date,routes:[botOrigin+'/*'],
      bindings:{TELEGRAM_TEACHER_PILOT_ENABLED:'true',TELEGRAM_WEBHOOK_SECRET:webhookSecret,
        MINI_CABINET_URL:studentOrigin+'/',MINI_SIGN_IN_URL:studentOrigin+'/sign-in'},
      serviceBindings:{TELEGRAM_PILOT_DIRECTORY:{name:'api',entrypoint:'TelegramPilotDirectory'},
        TELEGRAM_START_LOOKUP:{name:'api',entrypoint:'TelegramAccountDirectory'}},
      outboundService:()=>{throw Error('Bot unexpectedly requested external transport');}},
    {name:'api',modules,modulesRoot:bundle,compatibilityDate:date,compatibilityFlags:['nodejs_compat'],routes:[apiOrigin+'/*'],
      bindings:{...switches,UA_TELEGRAM_PILOT_DIRECTORY_ENABLED:'true',UA_TELEGRAM_LOOKUP_TIMEOUT_MS:'4000',UA_API_ORIGIN:apiOrigin,UA_ALLOWED_ORIGINS:JSON.stringify([studentOrigin]),UA_CABINET_STUDENT_ORIGIN:studentOrigin,UA_CLERK_SECRET_KEY:'local-session-fixture',
        UA_CLERK_PROVIDER_SETTINGS:JSON.stringify({issuer,authorizedParties:[studentOrigin],audience:{kind:'clerk_default_no_audience'},
          jwksCacheMs:300000,jwksCooldownMs:0,timeoutMs:4000,maxJwksBytes:65536})},
      hyperdrives:{CABINET_HYPERDRIVE:connection,TEACHER_PILOT_HYPERDRIVE:delivery,HYPERDRIVE:lookup},outboundService:clerkProvider}
  ]}));
  // All browser traffic uses dispatchFetch; real staff requests cross the named binding.
  const browser={fetch:async request=>mf.dispatchFetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),
    ...(request.body ? {body:Buffer.from(await request.arrayBuffer())} : {}),redirect:'manual'})};
  const teacherUI=routes(browser,'teacher',teacherJwt),adminUI=routes(browser,'admin',adminJwt),student=routes(browser,'student',account.token);
  assert.equal((await good(teacherUI.dashboard())).role,'teacher');
  assert.equal((await good(adminUI.dashboard())).role,'admin');
  assert.equal((await good(student.dashboard())).univeracademy_id,account.cabinetId);
  await rejected(routes(browser,'admin',teacherJwt).dashboard());
  const direct=await mf.dispatchFetch(apiOrigin+'/api/v1/teacher/pilot/dashboard',{headers:{origin:studentOrigin,authorization:'Bearer '+teacherJwt,'x-univeracademy-pilot-proxy':'untrusted'}});
  assert.equal(direct.status,404);
  const g=await good(teacherUI.command('createGroup',{subjectId:'physics',name:'Mexanika'}));
  assert.equal(g.status,'active');
  const available='groups/'+g.id+'/available-students';
  const candidates=await good(teacherUI.call(available));
  assert.deepEqual(candidates,{students:[{name:'O‘quvchi Sinov',univeracademy_id:account.cabinetId},
    {name:'Taklifli Sinov',univeracademy_id:invitee.cabinetId}],nextCursor:null});
  assert.deepEqual(await good(teacherUI.call(available+'?after='+account.cabinetId)),{students:[candidates.students[1]],nextCursor:null});
  await rejected(student.call(available),404);
  await rejected(teacherUI.call(available+'?after=bad'),404);
  await good(teacherUI.command('addMember',{groupId:g.id,univeracademy_id:candidates.students[0].univeracademy_id}));
  assert.deepEqual(await good(teacherUI.call(available)),{students:[candidates.students[1]],nextCursor:null});
  const invitation=await good(teacherUI.command('createInvite',{groupId:g.id}));
  const webhook=await mf.dispatchFetch(botOrigin+'/telegram/webhook',{method:'POST',
    headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':webhookSecret},
    body:JSON.stringify({update_id:1,message:{message_id:1,date:Math.floor(Date.now()/1000),
      from:{is_bot:false,id:invitee.telegramId},chat:{type:'private',id:invitee.telegramId},text:'/start '+invitation.token}})});
  assert.equal(webhook.status,200);
  const message=await webhook.json(),miniLink=new URL(message.reply_markup.inline_keyboard[0][0].web_app.url);
  assert.equal(message.chat_id,invitee.telegramId);assert.equal(miniLink.origin,studentOrigin);
  assert.equal(miniLink.searchParams.get('invite'),invitation.token);
  assert.equal((await db.query('SELECT count(*)::int n FROM ua_cabinet.private_starts WHERE telegram_id=$1',[invitee.telegramId])).rows[0].n,1);
  const secondStudent=routes(browser,'student',invitee.token);
  assert.equal((await good(secondStudent.dashboard())).group,null);
  assert.equal((await good(secondStudent.command('acceptInvite',{token:miniLink.searchParams.get('invite')}))).id,g.id);
  const roster=(await good(teacherUI.dashboard())).groups.find(row=>row.id===g.id).members;
  assert.deepEqual(roster.map(row=>row.univeracademy_id).sort(),[account.cabinetId,invitee.cabinetId]);
  const image=await good(teacherUI.upload(graphSvg,'image/svg+xml'));
  await rejected(student.image(image.id),404);
  const draft=await good(teacherUI.command('importTest',richDocument(image.id)));
  const open=await good(teacherUI.command('readDraft',{testId:draft.id}));
  const key=open.draft.questions[0].correct_option_id;
  open.draft.questions[0].options.reverse();
  open.draft.title+=' (tahrirlangan)';
  const saved=await good(teacherUI.command('updateDraft',{testId:draft.id,expectedRevision:open.revision,draft:open.draft}));
  assert.equal(saved.id,draft.id);
  const reloaded=await good(teacherUI.command('readDraft',{testId:draft.id}));
  assert.equal(reloaded.revision,saved.revision);
  assert.deepEqual(reloaded.draft,open.draft);
  assert.equal(reloaded.draft.questions[0].correct_option_id,key);
  await good(teacherUI.command('publishTest',{testId:draft.id}));
  const {duration_seconds,...scheduledFile}=open.draft;
  await rejected(teacherUI.command('importTest',{...open.draft,duration_hours:0.5}),422);
  const scheduledDraft=await good(teacherUI.command('importTest',{...scheduledFile,title:'Rejali nazorat',duration_hours:0.5}));
  assert.equal(scheduledDraft.duration_seconds,1800);
  await good(teacherUI.command('publishTest',{testId:scheduledDraft.id}));
  const startsAt=Date.now()+3_600_000;
  const scheduled=await good(teacherUI.command('assignTest',{testId:scheduledDraft.id,groupId:g.id,startsAt}));
  assert.equal(scheduled.opensAt,startsAt);
  assert.equal((await good(student.dashboard())).assignments.find(row=>row.id===scheduled.id).status,'scheduled');
  await rejected(student.command('startAttempt',{assignmentId:scheduled.id}),409);
  const assignment=await good(teacherUI.command('assignTest',{testId:draft.id,groupId:g.id}));
  const attempt=await good(student.command('startAttempt',{assignmentId:assignment.id})),q=attempt.questions[0];
  assert.doesNotMatch(JSON.stringify(attempt),/correct_option_id|Maxsus o‘qituvchi izohi/);
  assert.equal(q.prompt_blocks[1].latex,String.raw`\frac{s}{t}`);
  const imageReply=await student.image(image.id);
  assert.equal(imageReply.status,200);assert.equal(imageReply.headers.get('content-type'),'image/png');
  const png=Buffer.from(await imageReply.arrayBuffer());
  assert.equal(png.readUInt32BE(16),96);assert.equal(png.readUInt32BE(20),50);
  const correct=q.options.find(o=>o.blocks.some(b=>b.latex===String.raw`\frac{20}{4}`));
  await good(student.command('saveAnswer',{attemptId:attempt.id,questionId:q.id,optionId:correct.id,expectedRevision:0}));
  const resumed=await good(student.command('resumeAttempt',{attemptId:attempt.id}));
  assert.deepEqual(resumed.questions,attempt.questions);
  assert.equal(resumed.answers[0].optionId,correct.id);
  const score=await good(student.command('submitAttempt',{attemptId:attempt.id}));
  assert.equal(score.percentage,'100.00');
  assert.equal((await good(teacherUI.dashboard())).results.find(r=>r.attemptId===attempt.id).percentage,score.percentage);
  assert.equal((await db.query('SELECT count(*)::int n FROM ua_private.ordinary_results WHERE attempt_id=$1',[attempt.id])).rows[0].n,1);
  assert.ok(clerkCalls.includes('/.well-known/jwks.json'));
  console.log('PASS workerd. Bundled Ustoz Pages and API verified signed staff JWTs and the student session, created a teacher-owned active group, selected an eligible student from its paged directory, resumed, edited and published the same rich test, rendered a private PNG, enrolled a second learner via the compiled Telegram bot and both directory bindings, stored answers and returned the persisted grade.');
} finally {
  try { await mf?.dispose(); } finally { try {await cluster?.close();} finally {await rm(bundle,{recursive:true,force:true});} }
}
