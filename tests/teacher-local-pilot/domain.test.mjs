// Role/assignment visibility on private media depends on the server-owned attempt clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createTeacherPilot} from '../../runtime/teacher-pilot-domain.mjs';

const text=markdown=>({type:'text',markdown});
const image=(id,alt)=>({type:'image',asset_id:id,alt});
const code=value=>error=>error.code===value;
async function activeGroup(pilot){
  const group=await pilot.command('teacher','createGroup',{name:'Matematika'});
  assert.equal(group.status,'active');
  return group;
}
function richFile(publicImage,privateKeyImage){
  const options=['3','4','5','6'].map(n=>({id:randomUUID(),blocks:[text(n)]}));
  options[1].blocks.unshift(image(publicImage,'Variant rasmi'));
  return {title:'Daraja',duration_seconds:60,questions:[{id:randomUUID(),position:1,
    prompt_blocks:[text('Hisoblang'),{type:'formula',display:'inline',latex:'2^2'},image(publicImage,'Rasm')],
    options,correct_option_id:options[1].id,explanation_blocks:[text('MAXFIY'),image(privateKeyImage,'Yechim')] }]};
}
test('only assigned active attempts receive projected question images; answer explanations and foreign media remain private',async()=>{
  let now=Date.parse('2026-09-01T09:00:00Z');
  const p=createTeacherPilot({now:()=>now}),media=randomUUID(),keyImage=randomUUID(),foreign=randomUUID();
  for (const id of [media,keyImage]) await p.registerMedia('teacher',{id,contentType:'image/png'});
  await p.registerMedia('teacher2',{id:foreign,contentType:'image/png'});
  assert.equal(await p.canReadMedia('teacher',media),true);
  assert.equal(await p.canReadMedia('teacher2',media),false);
  assert.equal(await p.canReadMedia('admin',media),false);
  await assert.rejects(p.registerMedia('student1',{id:randomUUID(),contentType:'image/png'}),code('FORBIDDEN'));
  await assert.rejects(p.command('teacher','importTest',richFile(media,foreign)),code('INVALID_TEST_FILE'));
  assert.deepEqual((await p.read('teacher')).tests,[]);
  const t=await p.command('teacher','importTest',richFile(media,keyImage));
  const preview=await p.command('teacher','previewTest',{testId:t.id});
  assert.equal(preview.questions[0].prompt_blocks[2].asset.url,'/local-pilot/teacher/media/'+media);
  await assert.rejects(p.command('teacher2','previewTest',{testId:t.id}),code('NOT_FOUND'));
  await p.command('teacher','publishTest',{testId:t.id});
  const group=await activeGroup(p);
  await p.command('teacher','addMember',{groupId:group.id,univeracademy_id:'0100000001'});
  const assigned=await p.command('teacher','assignTest',{groupId:group.id,testId:t.id});
  assert.equal(await p.canReadMedia('student1',media),false);
  const attempt=await p.command('student1','startAttempt',{assignmentId:assigned.id});
  assert.equal(attempt.questions.length,1);
  const q=attempt.questions[0];
  assert.equal(q.prompt_blocks[1].latex,'2^2');
  assert.equal(q.prompt_blocks[2].asset.url,'/local-pilot/student/media/'+media);
  assert.equal(q.prompt_blocks[2].asset.expires_at,attempt.deadlineAt);
  assert.ok(q.options.flatMap(o=>o.blocks).some(b=>b.type==='image' && b.asset.asset_id===media));
  for (const needle of ['correct_option','explanation','MAXFIY',keyImage]) assert.ok(!JSON.stringify(attempt).includes(needle));
  assert.equal(await p.canReadMedia('student1',media),true);
  assert.equal(await p.canReadMedia('student1',keyImage),false);
  assert.equal(await p.canReadMedia('student2',media),false);
  now=Date.parse(attempt.deadlineAt);
  assert.equal(await p.canReadMedia('student1',media),false);
  const expired=await p.command('student1','resumeAttempt',{attemptId:attempt.id});
  assert.equal(expired.status,'expired');
  assert.deepEqual(expired.questions,[]);
});

test('direct local bot delivery is recipient-bound and retried once; public links remain usable',async()=>{
  let now=Date.parse('2026-09-01T09:00:00Z');
  const p=createTeacherPilot({now:()=>now}), g=await activeGroup(p);
  const data={groupId:g.id,univeracademy_id:'0100000002'};
  await assert.rejects(p.command('teacher','sendInvite',{...data,univeracademy_id:'0100000001'}),code('LOCAL_CHAT_UNAVAILABLE'));
  const message=await p.command('teacher','sendInvite',data,'send');
  const replay=await p.command('teacher','sendInvite',data,'send');
  assert.deepEqual(replay,message);
  assert.equal(message.delivery,'local_bot');
  const own=(await p.read('student2')).inbox;
  assert.equal(own.length,1);
  assert.equal(own[0].token,message.token);
  assert.deepEqual((await p.read('student1')).inbox,[]);
  await assert.rejects(p.command('student1','acceptInvite',{token:message.token}),code('INVALID_INVITE'));
  const accepted=await p.command('student2','acceptInvite',{token:message.token});
  assert.equal(accepted.id,g.id);
  assert.equal((await p.command('student2','acceptInvite',{token:message.token})).id,g.id);
  const link=await p.command('teacher','createInvite',{groupId:g.id});
  assert.equal((await p.command('student1','acceptInvite',{token:link.token})).id,g.id);
  now=Date.parse(message.expiresAt);
  assert.deepEqual((await p.read('student2')).inbox,[]);
  await assert.rejects(p.command('student2','acceptInvite',{token:message.token}),code('INVITE_EXPIRED'));
});

test('invalid LaTeX in a later answer or instructions reports its source and leaves no draft',async()=>{
  const pilot=createTeacherPilot();
  const simple={text:'2+2?',options:['1','2','3','4'],correctIndex:3};
  const options=['A','B','C','D'].map(n=>({id:randomUUID(),blocks:[text(n)]}));
  const bad={type:'formula',latex:'\\notARealCommand',display:'block'};
  options[2].blocks.push(bad);
  const q={id:randomUUID(),position:2,prompt_blocks:[text('Hisoblang')],options,
    correct_option_id:options[0].id,explanation_blocks:[]};
  const issue=location=>e=>e.code==='INVALID_FORMULA' && e.status===422 && e.detail.startsWith(location);
  await assert.rejects(pilot.command('teacher','importTest',{title:'Test',questions:[simple,q]},'test-key'),
    issue('2-savol, 3-javob, 2-blok'));
  await assert.rejects(pilot.command('teacher','importTest',{title:'Test',instructions_blocks:[bad],questions:[simple]},'test-key'),
    issue('Test yo‘riqnomasi, 1-blok'));
  assert.deepEqual((await pilot.read('teacher')).tests,[]);
  options[2].blocks.pop();
  const draft=await pilot.command('teacher','importTest',{title:'Test',questions:[simple,q]},'test-key');
  assert.equal(draft.questionCount,2);
});
