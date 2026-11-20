import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherPilotServer } from '../../runtime/teacher-local-pilot.mjs';

async function pilot(t) {
  let time = Date.UTC(2026, 10, 20, 10);
  const server = await createTeacherPilotServer({ now: () => time });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = 'http://127.0.0.1:' + server.address().port;

  async function request(method, path, body, session, idempotencyKey) {
    const headers = new Headers();
    if (session) headers.set('Cookie', session);
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(new URL(path, origin), {
      method, headers, redirect: 'error',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    return { response, payload };
  }
  async function actor(identity) {
    const role = identity.replace(/[0-9]+$/, '');
    const root = '/local-pilot/' + role;
    const { response } = await request('POST', root + '/session', { actor: identity });
    assert.ok(response.ok, 'local ' + identity + ' session: ' + response.status);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'local session cookie');
    return {
      dashboard: async () => success(await request('GET', root + '/dashboard', undefined, cookie)),
      available: (groupId, query='') => request('GET',root+'/groups/'+groupId+'/available-students'+query,undefined,cookie),
      upload: async (bytes, contentType) => {
        const response = await fetch(origin + root + '/media', {
          method: 'POST', headers: { Cookie: cookie, 'Content-Type': contentType }, body: bytes
        });
        return { response, payload: await response.json() };
      },
      image: id => fetch(origin + root + '/media/' + id, { headers: { Cookie: cookie } }),
      preview: text => request('POST','/local-pilot/teacher/import-preview',{ text },cookie),
      command: (action, body, key = randomUUID()) =>
        request('POST', root + '/commands/' + action, body, cookie, key)
    };
  }
  return { sampleText: async () => {
    const response = await fetch(origin + '/teacher/sample.txt');
    assert.equal(response.status,200);
    return response.text();
  }, assertBotStart: async token => {
    const data = success(await request('POST','/local-pilot/bot/start',{command: '/start ' + token}));
    return data.studentPath;
  }, actor, advance: milliseconds => { time += milliseconds; } };
}

function success({ response, payload }) {
  assert.ok(response.ok, 'HTTP ' + response.status + ': ' + JSON.stringify(payload));
  assert.ok(Object.hasOwn(payload, 'data'));
  return payload.data;
}

function denied({ response, payload }) {
  assert.ok(response.status >= 400 && response.status < 500, 'HTTP ' + response.status);
  assert.equal(typeof payload.error?.code, 'string');
  assert.ok(!Object.hasOwn(payload, 'data'));
}

const source = {
  title: 'Mexanika nazorati', duration_seconds: 600,
  questions: [
    { text: 'Kuch birligi qaysi?', options: ['Joul', 'Nyuton', 'Vatt', 'Paskal'], correctIndex: 1 },
    { text: 'Tezlik birligi qaysi?', options: ['kg', 'N', 'm/s', 'Pa'], correctIndex: 2 }
  ]
};

function noAnswerKey(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, /^(?:correct(?:_?option_?id|_?(?:index|answer))?|answer_?key)$/i);
    noAnswerKey(child);
  }
}

async function createGroup(teacher, name) {
  const group = success(await teacher.command('createGroup', { name }));
  assert.equal(group.status, 'active');
  return group.id;
}

test('the owner lists eligible students and a joined learner disappears from both teachers’ choices',async t=>{
  const f=await pilot(t), first=await f.actor('teacher'), second=await f.actor('teacher2');
  const firstGroup=await createGroup(first,'Fizika'), secondGroup=await createGroup(second,'Optika');
  const aziza={name:'Aziza Karimova',univeracademy_id:'0100000001'};
  const bekzod={name:'Bekzod Aliyev',univeracademy_id:'0100000002'};
  assert.deepEqual(success(await first.available(firstGroup)),{students:[aziza,bekzod],nextCursor:null});
  assert.deepEqual(success(await first.available(firstGroup,'?after=0100000001')),{students:[bekzod],nextCursor:null});
  denied(await first.available(firstGroup,'?after=1'));
  denied(await first.available(firstGroup,'?after=0100000001&after=0100000002'));
  denied(await second.available(firstGroup));
  denied(await (await f.actor('student1')).available(firstGroup));
  success(await first.command('addMember',{groupId:firstGroup,univeracademy_id:aziza.univeracademy_id}));
  assert.deepEqual(success(await second.available(secondGroup)),{students:[bekzod],nextCursor:null});
  denied(await second.command('addMember',{groupId:secondGroup,univeracademy_id:aziza.univeracademy_id}));
  success(await second.command('addMember',{groupId:secondGroup,univeracademy_id:bekzod.univeracademy_id}));
  assert.deepEqual(success(await first.available(firstGroup)),{students:[],nextCursor:null});
});
test('two students join through different entrances, take the uploaded test and get different scores', async t => {
  const f = await pilot(t);
  const teacher = await f.actor('teacher');
  const byId = await f.actor('student1'), byInvite = await f.actor('student2');
  const groupId = await createGroup(teacher, 'Fizika 01');
  const directId = (await byId.dashboard()).univeracademy_id;
  assert.equal(directId, '0100000001');
  success(await teacher.command('addMember', { groupId, univeracademy_id: directId }));
  const invitation = success(await teacher.command('createInvite', { groupId }));
  const localUrl = new URL(invitation.localBotUrl, 'http://127.0.0.1');
  assert.equal(localUrl.searchParams.get('start'), invitation.token);
  const studentPath = await f.assertBotStart(invitation.token);
  assert.equal(new URL(studentPath, 'http://127.0.0.1').searchParams.get('invite'), invitation.token);
  success(await byInvite.command('acceptInvite', { token: invitation.token }));
  success(await byInvite.command('acceptInvite', { token: invitation.token }));
  const members = (await teacher.dashboard()).groups.find(group => group.id === groupId).members;
  assert.deepEqual(members.map(student => student.univeracademy_id).sort(), ['0100000001','0100000002']);

  const draft = success(await teacher.command('importTest', source));
  assert.equal(draft.status, 'draft');
  assert.equal(draft.questionCount, source.questions.length);
  denied(await teacher.command('assignTest', { groupId, testId: draft.id }));
  assert.equal(success(await teacher.command('publishTest', { testId: draft.id })).status, 'published');
  const assigned = success(await teacher.command('assignTest', { groupId, testId: draft.id }));
  const completed = [];
  // Exercise two distinct draws without relying on the chance that random orders differ.
  const randomValues = crypto.getRandomValues.bind(crypto);
  let draw = 0;
  t.mock.method(crypto, 'getRandomValues', array =>
    array instanceof Uint32Array && array.length === 1 ? array.fill(draw) : randomValues(array));
  let firstOrder;
  for (const [learner, expectedCorrect] of [[byId, 2], [byInvite, 1]]) {
    const dashboard = await learner.dashboard();
    assert.ok(dashboard.assignments.some(item => item.id === assigned.id));
    noAnswerKey(dashboard);
    draw = learner === byId ? 0 : 1;
    const attempt = success(await learner.command('startAttempt', { assignmentId: assigned.id }));
    noAnswerKey(attempt);
    assert.equal(attempt.questions.length, source.questions.length);
    const displayed = attempt.questions.find(q => q.text === source.questions[0].text).options.map(o => o.text);
    assert.deepEqual([...displayed].sort(), [...source.questions[0].options].sort());
    if (firstOrder) assert.notDeepEqual(displayed, firstOrder);
    else firstOrder = displayed;
    for (const [position, authored] of source.questions.entries()) {
      const question = attempt.questions.find(q => q.text === authored.text);
      assert.ok(question, authored.text);
      const selected = authored.options[position < expectedCorrect ? authored.correctIndex : 0];
      const option = question.options.find(o => o.text === selected);
      const revision = attempt.answers.find(a => a.questionId === question.id)?.revision ?? 0;
      const input = { attemptId: attempt.id, questionId: question.id, optionId: option.id, expectedRevision: revision };
      const key = randomUUID();
      const saved = success(await learner.command('saveAnswer', input, key));
      assert.equal(saved.optionId, option.id);
      assert.equal(saved.revision, revision + 1);
      const replay = success(await learner.command('saveAnswer', input, key));
      assert.equal(replay.revision, saved.revision);
    }
    const resumed = success(await learner.command('resumeAttempt', { attemptId: attempt.id }));
    assert.deepEqual(resumed.questions, attempt.questions);
    assert.equal(resumed.answers.filter(a => a.optionId !== null).length, 2);
    noAnswerKey(resumed);
    const score = success(await learner.command('submitAttempt', { attemptId: attempt.id }));
    assert.equal(score.earned, expectedCorrect.toFixed(1));
    assert.equal(score.maximum, '2.0');
    assert.equal(score.percentage, (expectedCorrect * 50).toFixed(2));
    completed.push(attempt.id);
  }
  const scores = (await teacher.dashboard()).results.filter(row => row.assignmentId === assigned.id);
  assert.deepEqual(scores.map(row => row.earned).sort(), ['1.0', '2.0']);
  assert.deepEqual(scores.map(row => row.attemptId).sort(), completed.sort());
});

test('a teacher creates and uses their own group immediately while other accounts remain scoped', async t => {
  const f = await pilot(t);
  const teacher = await f.actor('teacher'), otherTeacher = await f.actor('teacher2');
  const learner = await f.actor('student1'), otherLearner = await f.actor('student2');
  const groupId = await createGroup(teacher, 'Optika guruhi');
  denied(await learner.command('createGroup', {name:'Begona guruh'}));
  assert.ok(!(await otherTeacher.dashboard()).groups.some(g => g.id === groupId));
  const draft = success(await teacher.command('importTest', source));
  denied(await otherTeacher.command('publishTest', { testId: draft.id }));
  denied(await otherTeacher.command('createInvite', { groupId }));
  denied(await teacher.command('addMember', { groupId, univeracademy_id:'100000001' }));
  success(await teacher.command('addMember', { groupId, univeracademy_id:'0100000001' }));
  success(await teacher.command('publishTest', { testId: draft.id }));
  const assigned = success(await teacher.command('assignTest', { groupId, testId:draft.id }));
  assert.equal((await otherLearner.dashboard()).assignments.length, 0);
  denied(await otherLearner.command('startAttempt', { assignmentId:assigned.id }));
  const attempt = success(await learner.command('startAttempt', { assignmentId:assigned.id }));
  denied(await otherLearner.command('resumeAttempt', { attemptId:attempt.id }));
  success(await learner.command('submitAttempt', { attemptId:attempt.id }));
  const result = (await teacher.dashboard()).results.find(row => row.attemptId === attempt.id);
  assert.equal(result?.earned, '0.0');
  assert.equal((await otherTeacher.dashboard()).results.length, 0);
});

test('group invitation expires at its boundary and existing members are never transferred implicitly', async t => {
  const f = await pilot(t);
  const teacher = await f.actor('teacher'), learner = await f.actor('student1');
  const first = await createGroup(teacher, 'Mexanika');
  const second = await createGroup(teacher, 'Optika');
  const invite = success(await teacher.command('createInvite', { groupId:first }));
  const other = success(await teacher.command('createInvite', { groupId:second }));
  assert.equal((await learner.command('acceptInvite', { token:'grp_' + 'X'.repeat(43) })).response.status,404);
  success(await learner.command('acceptInvite', { token:invite.token }));
  assert.equal((await learner.command('acceptInvite', { token:other.token })).response.status,409);
  f.advance(24 * 60 * 60 * 1000);
  const newcomer = await f.actor('student2');
  assert.equal((await newcomer.command('acceptInvite', { token:other.token })).response.status,410);
  const groups = (await teacher.dashboard()).groups;
  assert.equal(groups.find(g => g.id === first).members.length,1);
  assert.equal(groups.find(g => g.id === second).members.length,0);
});

test('invalid import never creates a partial draft', async t => {
  const f = await pilot(t), teacher = await f.actor('teacher');
  const before = await teacher.dashboard();
  const invalid = { ...source, questions:[source.questions[0], { ...source.questions[1], correctIndex: 4 }] };
  denied(await teacher.command('importTest',invalid));
  assert.deepEqual(await teacher.dashboard(), before);
});


test('a teacher can reopen a saved draft in a new session and continue it without a copy', async t => {
  const f = await pilot(t);
  const teacher = await f.actor('teacher');
  const created = success(await teacher.command('importTest', source));
  const newSession = await f.actor('teacher');
  const {id, revision, draft} = success(await newSession.command('readDraft', {testId:created.id}));
  assert.equal(created.id, id);
  assert.equal(created.revision, revision);
  for (const alias of ['teacher2', 'student1']) {
    const other = await f.actor(alias);
    denied(await other.command('readDraft', {testId:id}));
  }
  const oldKey = draft.questions[0].correct_option_id;
  draft.questions[0].options.reverse();
  draft.title = 'Davom ettirilgan test';
  const input = {testId:id, expectedRevision:revision, draft};
  const updated = success(await newSession.command('updateDraft', input, 'save-continued'));
  assert.equal(updated.id, id);
  assert.ok(updated.revision > revision);
  assert.deepEqual(success(await newSession.command('updateDraft', input, 'save-continued')), updated);
  assert.equal((await newSession.command('updateDraft', input, 'stale-save')).response.status, 409);
  const opened = success(await newSession.command('readDraft', {testId:id}));
  assert.deepEqual(opened.draft.questions[0].options, draft.questions[0].options);
  assert.equal(opened.draft.questions[0].correct_option_id, oldKey);
  assert.equal(opened.draft.title, draft.title);
  assert.equal((await newSession.dashboard()).tests.length, 1);
  success(await newSession.command('publishTest', {testId:id}));
  assert.equal((await newSession.command('readDraft', {testId:id})).response.status, 409);
  assert.equal((await newSession.command('updateDraft', {...input,expectedRevision:updated.revision})).response.status, 409);
});

test('TXT preview reports the source line to its teacher and only a valid preview can be saved as a draft', async t => {
  const f = await pilot(t), teacher = await f.actor('teacher'), student = await f.actor('student1');
  const initial = await teacher.dashboard();
  const sample = await f.sampleText();
  assert.match(sample,/^\* 5 m\/s$/m);
  denied(await student.preview(sample));
  const wrongAnswer = await teacher.preview(sample.replace('* 5 m/s', '- 5 m/s'));
  assert.equal(wrongAnswer.response.status,422);
  assert.match(wrongAnswer.payload.error.message,/^8-qator/);
  const doubleKey = await teacher.preview(sample.replace('- 80 m/s', '* 80 m/s'));
  assert.equal(doubleKey.response.status,422);
  assert.match(doubleKey.payload.error.message,/bitta to‘g‘ri javob/);
  const legacy = 'Nomi: Oldingi fayl\n1. Tezlik birligi?\nA) m/s\nB) s\nC) m\nD) N\nJavob: A';
  assert.deepEqual(success(await teacher.preview(legacy)).questions[0], {
    text: 'Tezlik birligi?', options: ['m/s', 's', 'm', 'N'], correctIndex: 0,
  });
  assert.equal((await teacher.preview(legacy.replace('D) N\n', ''))).response.status, 422);
  const parsed = success(await teacher.preview('\uFEFF' + sample.replaceAll('\n','\r\n')));
  assert.equal(parsed.title, 'Kinematika — qisqa sinov');
  assert.equal(parsed.duration_seconds,300);
  assert.deepEqual(parsed.questions.map(q => q.options[q.correctIndex]), ['5 m/s','Tezlik']);
  assert.deepEqual(await teacher.dashboard(),initial);
  const draft = success(await teacher.command('importTest',parsed));
  assert.equal(draft.status,'draft');
  assert.equal(draft.questionCount,2);
});

test('teacher delivery appears once in the intended student inbox and only that student can accept', async t => {
  const f = await pilot(t);
  const teacher = await f.actor('teacher');
  const first = await f.actor('student1'), intended = await f.actor('student2');
  const groupId = await createGroup(teacher,'Astronomiya');
  const unavailable = await teacher.command('sendInvite',{groupId,univeracademy_id:'0100000001'});
  assert.equal(unavailable.response.status,409);
  assert.equal(unavailable.payload.error.code,'LOCAL_CHAT_UNAVAILABLE');
  const input = {groupId,univeracademy_id:'0100000002'}, key=randomUUID();
  const firstDelivery = success(await teacher.command('sendInvite',input,key));
  const duplicate = success(await teacher.command('sendInvite',input,key));
  assert.equal(firstDelivery.delivery,'local_bot');
  assert.deepEqual(duplicate,firstDelivery);
  const messages = (await intended.dashboard()).inbox;
  assert.equal(messages.length,1);
  assert.equal(messages[0].groupName,'Astronomiya');
  assert.equal(messages[0].token,firstDelivery.token);
  assert.deepEqual((await first.dashboard()).inbox,[]);
  const wrong = await first.command('acceptInvite',{token:messages[0].token});
  assert.equal(wrong.response.status,404);
  const link = await f.assertBotStart(messages[0].token);
  assert.equal(new URL(link,'http://127.0.0.1').searchParams.get('invite'),firstDelivery.token);
  assert.equal((await intended.dashboard()).group,null);
  success(await intended.command('acceptInvite',{token:messages[0].token}));
  assert.equal((await intended.dashboard()).group.id,groupId);
});

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><path d="M10 50L110 10" fill="none" stroke="#155533"/></svg>');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABIAAAAKCAIAAAA2KZn2AAAAE0lEQVR4nGOI7EwjAzGMahtJ2gDFW+ahJLrIeAAAAABJRU5ErkJggg==','base64');

async function renderedPng(actor, asset, width, height) {
  const response=await actor.image(asset.id);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'image/png');
  const result=Buffer.from(await response.arrayBuffer());
  assert.deepEqual(result.subarray(0,8),png.subarray(0,8));
  assert.equal(result.readUInt32BE(16),width);
  assert.equal(result.readUInt32BE(20),height);
}

test('typed formula and private SVG/PNG survive preview, publish and an authorized student attempt',async t=>{
  const f=await pilot(t);
  const teacher=await f.actor('teacher'), other=await f.actor('teacher2');
  const learner=await f.actor('student1'), outsider=await f.actor('student2');
  const illustration=success(await teacher.upload(svg,'image/svg+xml'));
  const answerImage=success(await teacher.upload(png,'image/png'));
  const groupId=await createGroup(teacher,'Dinamika');
  await renderedPng(teacher,illustration,120,60);
  assert.equal((await other.image(illustration.id)).status,404);
  assert.equal((await learner.image(illustration.id)).status,404);
  const formula={type:'formula',latex:'F = ma',display:'block'};
  const options=['Kuch','Massa','Tezlik','Vaqt'].map(markdown=>({id:randomUUID(),blocks:[{type:'text',markdown}]}));
  options[0].blocks.push({type:'formula',latex:'2 m a',display:'inline'},
    {type:'image',asset_id:answerImage.id,alt:'Javob uchun chizma'});
  const question={id:randomUUID(),position:1,expected_revision:0,prompt_blocks:[
    {type:'text',markdown:'Qaysi kattalik tasvirlangan?'},formula,
    {type:'image',asset_id:illustration.id,alt:'Harakat grafigi'}
  ],options, correct_option_id:options[0].id,explanation_blocks:[{type:'text',markdown:'Faqat muallif uchun izoh'}]};
  const rich={title:'Formula va chizma',duration_seconds:300,questions:[question]};
  denied(await other.command('importTest',rich));
  const draft=success(await teacher.command('importTest',rich));
  const preview=success(await teacher.command('previewTest',{testId:draft.id}));
  denied(await other.command('previewTest',{testId:draft.id}));
  function verify(view,role) {
    noAnswerKey(view);
    assert.ok(!JSON.stringify(view).includes('Faqat muallif uchun izoh'));
    const prompt=view.questions[0].prompt_blocks;
    assert.deepEqual(prompt[1],formula);
    assert.equal(prompt[2].asset.url,'/local-pilot/'+role+'/media/'+illustration.id);
    assert.equal(prompt[2].alt,'Harakat grafigi');
    const option=view.questions[0].options.find(o=>o.blocks[0].markdown==='Kuch');
    assert.equal(option.blocks[1].latex,'2 m a');
    assert.equal(option.blocks[2].asset.url,'/local-pilot/'+role+'/media/'+answerImage.id);
    return option.id;
  }
  verify(preview,'teacher');
  success(await teacher.command('addMember',{groupId,univeracademy_id:'0100000001'}));
  success(await teacher.command('publishTest',{testId:draft.id}));
  const assignment=success(await teacher.command('assignTest',{groupId,testId:draft.id}));
  assert.equal((await learner.image(illustration.id)).status,404);
  const attempt=success(await learner.command('startAttempt',{assignmentId:assignment.id}));
  const selected=verify(attempt,'student');
  await renderedPng(learner,illustration,120,60);
  await renderedPng(learner,answerImage,18,10);
  assert.equal((await outsider.image(illustration.id)).status,404);
  success(await learner.command('saveAnswer',{attemptId:attempt.id,questionId:attempt.questions[0].id,optionId:selected,expectedRevision:0}));
  const grade=success(await learner.command('submitAttempt',{attemptId:attempt.id}));
  assert.equal(grade.percentage,'100.00');
  assert.equal((await learner.image(illustration.id)).status,404);
  assert.equal((await teacher.dashboard()).results[0].percentage,'100.00');
});

test('the timed attempt closes at its server deadline and its score cannot change through late writes',async t=>{
  const f=await pilot(t);
  const teacher=await f.actor('teacher'),student=await f.actor('student1');
  const groupId=await createGroup(teacher,'Qisqa nazorat');
  success(await teacher.command('addMember',{groupId,univeracademy_id:'0100000001'}));
  const draft=success(await teacher.command('importTest',{...source,duration_seconds:60}));
  success(await teacher.command('publishTest',{testId:draft.id}));
  const assignment=success(await teacher.command('assignTest',{groupId,testId:draft.id}));
  const attempt=success(await student.command('startAttempt',{assignmentId:assignment.id}));
  const question=attempt.questions.find(q=>q.text===source.questions[0].text);
  const save={attemptId:attempt.id,questionId:question.id,optionId:question.options.find(o=>o.text==='Nyuton').id,expectedRevision:0};
  success(await student.command('saveAnswer',save));
  f.advance(60_000);
  const replacement={...save,expectedRevision:1,optionId:question.options.find(o=>o.text==='Joul').id};
  denied(await student.command('saveAnswer',replacement));
  const dashboard=await student.dashboard();
  assert.equal(dashboard.assignments[0].status,'expired');
  const before=(await teacher.dashboard()).results;
  assert.equal(before.length,1);
  assert.equal(before[0].percentage,'50.00');
  denied(await student.command('saveAnswer',replacement));
  const after=(await teacher.dashboard()).results;
  assert.deepEqual(after,before);
});

test('invalid LaTeX reports the question, option and block and leaves the teacher’s drafts unmodified',async t=>{
  const f=await pilot(t),teacher=await f.actor('teacher');
  const options=['Kuch','Masofa','Vaqt','Massa'].map(markdown=>({id:randomUUID(),blocks:[{type:'text',markdown}]}));
  const fraction={type:'formula',latex:String.raw`\frac{s}{t}`,display:'block'};
  const bad={type:'formula',latex:String.raw`\UnknownUniver`,display:'inline'};
  const canonical={
    id:randomUUID(),position:2,expected_revision:0,prompt_blocks:[fraction],
    options,correct_option_id:options[1].id,explanation_blocks:[]
  };
  const subject={title:'Formulani tekshirish',duration_seconds:120,questions:[source.questions[0],canonical]};
  const before=await teacher.dashboard();
  options[1].blocks.push(bad);
  const rejected=await teacher.command('importTest',subject);
  assert.equal(rejected.response.status,422);
  assert.equal(rejected.payload.error.code,'INVALID_FORMULA');
  assert.match(rejected.payload.error.message,/2-savol, 2-javob, 2-blok/);
  assert.match(rejected.payload.error.message,/Formula .*LaTeX/);
  assert.deepEqual(await teacher.dashboard(),before);
  options[1].blocks[1]={...fraction,display:'inline'};
  const saved=success(await teacher.command('importTest',subject));
  const presentation=success(await teacher.command('previewTest',{testId:saved.id}));
  assert.deepEqual(presentation.questions[1].prompt_blocks,[fraction]);
  assert.equal((await teacher.dashboard()).tests.length,before.tests.length+1);
});
