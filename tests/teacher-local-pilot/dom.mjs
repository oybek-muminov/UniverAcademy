import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { createTeacherPilotServer } from '../../runtime/teacher-local-pilot.mjs';

const { JSDOM } = createRequire(new URL('./tooling/package.json', import.meta.url))('jsdom');
const root = new URL('../../', import.meta.url);
const hostedModules = new Map([
  ['/teacher/workspace.mjs', 'apps/teacher-web/src/workspace.mjs'],
  ['/pilot/blocks.mjs', 'apps/mini-app/local-teacher-pilot/blocks.mjs'],
  ['/pilot/rich-blocks.mjs', 'apps/mini-app/src/rich-blocks.mjs'],
  ['/pilot/vendor/katex.mjs', 'runtime/teacher-local-ui/node_modules/katex/dist/katex.mjs'],
]);

// JSDOM supplies the controls/events but does not load module scripts. These are the same
// ESM sources the HTTP launcher serves. Requests, grading and private images use the real server.
test('teacher authors, previews, publishes, invites and reads an ordinary score through the DOM', async t => {
  const server = createTeacherPilotServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const nativeFetch = globalThis.fetch;
  const cookies = new Map();
  const faults = [];
  async function browserFetch(path, options = {}) {
    const url = new URL(path, base);
    assert.equal(url.origin, base);
    const headers = new Headers(options.headers);
    headers.set('Cookie', [...cookies.values()].join('; '));
    const response = await nativeFetch(url, { ...options, headers });
    const cookie = response.headers.get('set-cookie');
    if (cookie) cookies.set(cookie.split('=')[0], cookie.split(';')[0]);
    if (!response.ok && response.status !== 401) faults.push([url.pathname, response.status, await response.clone().text()]);
    return response;
  }
  const html = await (await browserFetch('/teacher/')).text();
  const { window } = new JSDOM(html, { url: base + '/teacher/#testlar', pretendToBeVisual: true });
  t.after(() => window.close());
  const { document } = window;
  const globals = { window, document, location: window.location, Option: window.Option, fetch: browserFetch };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return next(hostedModules.has(specifier) ? new URL(hostedModules.get(specifier), root).href : specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  await import('../../apps/teacher-web/local-pilot/teacher.mjs');

  const el = id => document.getElementById(id);
  const group = legend => [...el('question-fields').querySelectorAll('fieldset')].find(
    field => field.querySelector('legend').textContent === legend);
  function input(control, value) {
    control.value = value;
    control.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  function submit(form, submitter) {
    form.dispatchEvent(new window.SubmitEvent('submit', { cancelable: true, submitter }));
  }
  function selectFile(control, file) {
    Object.defineProperty(control, 'files', { configurable: true, value: [file] });
    control.dispatchEvent(new window.Event('change'));
  }
  async function until(check, label) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (check() && !el('main').hasAttribute('aria-busy')) return;
      await pause(10);
    }
    throw Error(label + ' | ' + el('notice').textContent + ' | ' + el('problem').textContent + ' | ' + JSON.stringify(faults));
  }
  async function post(path, data) {
    const response = await browserFetch('/local-pilot/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(data),
    });
    const packet = await response.json();
    assert.equal(response.ok, true, JSON.stringify(packet));
    return packet.data;
  }

  await until(() => el('identity-name').textContent, 'teacher session');
  const txt = await (await browserFetch('/teacher/sample.txt')).arrayBuffer();
  selectFile(el('test-file'), new File([txt], 'my.txt', { type: 'text/plain' }));
  await until(() => !el('edit-file').disabled, 'TXT preview');
  el('view-file').click();
  await until(() => el('preview-content').querySelector('input'), 'file in student modal');
  assert(el('student-dialog').open);
  assert(!el('preview-content').textContent.includes('To‘g‘ri javob'));
  assert.equal(document.activeElement, el('close-preview'));
  el('student-dialog').dispatchEvent(new window.KeyboardEvent('keydown', { key:'Escape', cancelable:true }));
  assert(!el('student-dialog').open);
  assert.equal(document.activeElement, el('view-file'));
  el('edit-file').click();
  assert(el('editor-title').value);
  const prompt = () => group('Savol mazmuni');
  const option = () => group('1-javob');
  [...prompt().querySelectorAll('button')].find(control => control.textContent === 'Formula qo‘shish').click();
  const source = () => prompt().querySelector('[data-formula-input]');
  input(source(), String.raw`\UniverUnknownCommand`);
  submit(el('editor-form'), el('save-editor'));
  await until(() => el('problem').textContent.includes('1-savol'), 'bad LaTeX locates the question');
  assert.equal(el('saved-test').options.length, 0);
  input(source(), String.raw`v=\frac{s}{t}`);
  const display = prompt().querySelector('.formula-editor select');
  display.value = 'inline';
  display.dispatchEvent(new window.Event('change'));
  await until(() => prompt().querySelector('.formula-live-preview .katex'), 'live KaTeX');
  assert.equal(prompt().querySelector('.formula-live-preview .katex-display'), null);

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="10" height="10" fill="red"/></svg>';
  selectFile(option().querySelector('[type=file]'), new File([svg], 'diagram.svg', { type: 'image/svg+xml' }));
  await until(() => option().querySelector('.block-row input:not([type])'), 'private upload');
  input(option().querySelector('.block-row input:not([type])'), 'Tajriba chizmasi');
  input(prompt().querySelector('textarea'), '<b>Bu matn</b>');
  el('student-preview').click();
  await until(() => el('preview-content').querySelector('.katex'), 'student preview');
  assert.equal(el('preview-content').querySelector('b'), null);
  const image = el('preview-content').querySelector('img');
  assert.equal(image.alt, 'Tajriba chizmasi');
  assert.equal((await browserFetch(image.src)).headers.get('content-type'), 'image/png');
  el('close-preview').click();
  assert.equal(document.activeElement, el('student-preview'));
  input(el('editor-duration'), '1,5');
  el('tab-drafts').click();
  assert(!el('tests-empty').hidden && el('tests-new').hidden);
  el('tab-new').click();
  assert.equal(el('editor-duration').value, '1,5');
  assert.equal(prompt().querySelector('textarea').value, '<b>Bu matn</b>');
  submit(el('editor-form'), el('save-editor'));
  await until(() => el('save-editor').textContent === 'O‘zgarishlarni saqlash' && !el('editor-controls').disabled, 'import and load canonical draft');
  assert(!el('tests-drafts').hidden && el('tests-new').hidden);
  assert(el('test-meta').textContent.includes('1.5 soat'));
  const savedId = el('saved-test').value;
  const before = await post('teacher/commands/readDraft', {testId:savedId});
  assert.equal(before.draft.duration_seconds, 5400);
  el('new-editor').click();
  assert.equal(el('editor-title').value, '');
  el('tab-drafts').click();
  el('edit-saved').click();
  await until(() => !el('editor-controls').disabled && el('editor-title').value === before.draft.title, 'resume from the saved list');
  assert.equal(option().querySelector('input[type=radio]').value, before.draft.questions[0].options[0].id);
  assert(option().querySelector('img[alt="Tajriba chizmasi"]'));
  input(prompt().querySelector('textarea'), 'Yangilangan savol');
  el('tab-new').click();
  assert(!el('start-new').hidden && el('tests-drafts').hidden);
  el('tab-drafts').click();
  assert.equal(prompt().querySelector('textarea').value, 'Yangilangan savol');
  submit(el('editor-form'), el('save-editor'));
  await until(() => el('save-editor').disabled && !el('editor-controls').disabled, 'save same draft');
  const after = await post('teacher/commands/readDraft', {testId:savedId});
  assert(after.revision > before.revision);
  assert.equal(after.draft.questions[0].id, before.draft.questions[0].id);
  assert.equal(after.draft.questions[0].correct_option_id, before.draft.questions[0].correct_option_id);
  assert.deepEqual(after.draft.questions[0].options, before.draft.questions[0].options);
  assert.equal(after.draft.questions[0].prompt_blocks[0].markdown, 'Yangilangan savol');
  assert.deepEqual(after.draft.instructions_blocks,before.draft.instructions_blocks);
  assert.deepEqual(after.draft.grading_config,before.draft.grading_config);
  assert.equal(el('saved-test').options.length,1);
  el('view-saved').click();
  await until(() => el('preview-content').querySelector('.katex'), 'reopen saved draft');
  assert(el('preview-content').querySelector('img[alt="Tajriba chizmasi"]'));
  el('student-dialog').click();
  assert(!el('student-dialog').open);
  assert.equal(document.activeElement,el('view-saved'));
  el('publish-button').click();
  await until(() => el('test-meta').textContent.includes('Nashr qilingan'), 'publish');

  assert(!el('tests-published').hidden && el('edit-saved').hidden);
  el('tab-drafts').click();
  assert.equal(el('saved-test').options.length, 0);
  assert.match(el('tests-empty').textContent, /qoralama/i);
  el('tab-published').click();
  el('view-saved').click();
  await until(() => el('preview-content').querySelector('img'), 'published preview');
  assert(!el('preview-content').textContent.includes('To‘g‘ri javob'));
  el('close-preview').click();

  window.location.hash = 'guruhlar';
  await until(() => !el('guruhlar').hidden, 'group workspace');
  input(el('group-name'), 'Fizika <b>8A</b>');
  submit(el('group-form'), el('group-form').querySelector('button'));
  await until(() => el('member-group').value && !el('member-form').hidden, 'new group ready for enrollment');
  const form = el('member-form');
  input(el('student-number'), '0100000001');
  submit(form, form.querySelector('[value=send]'));
  await until(() => el('problem').textContent.includes('botni hali ochmagan'), 'unknown bot chat');
  const available = el('available-list');
  await until(() => [...available.options].some(row => row.value === '0100000001'), 'ungrouped student listed');
  available.value = '0100000001';
  available.dispatchEvent(new window.Event('change'));
  assert(!el('members').textContent.includes('0100000001'));
  submit(el('available-form'), el('available-add'));
  await until(() => el('members').textContent.includes('0100000001') &&
    [...available.options].some(row => row.value === '0100000002') &&
    ![...available.options].some(row => row.value === '0100000001'), 'enrolled student moves from picker to members');
  input(el('student-number'), '0100000002');
  submit(form, form.querySelector('[value=send]'));
  await until(() => el('notice').textContent.includes('bot xabarlariga yuborildi'), 'deliver local invite');
  el('invite-button').click();
  await until(() => !el('invite-detail').hidden, 'share invite');
  assert(el('invite-url').value.startsWith('https://t.me/'));
  window.location.hash = 'testlar';
  await until(() => !el('testlar').hidden && !el('assign-form').hidden,'published assignment form');
  el('assign-form').querySelector('[value="now"]').click();
  submit(el('assign-form'), el('assign-form').querySelector('button'));
  await until(() => el('assignment-info').textContent.includes('Fizika <b>8A</b>'), 'assign');
  assert.equal(el('assignment-info').querySelector('b'), null);

  await post('student/session', { actor: 'student1' });
  const student = (await (await browserFetch('/local-pilot/student/dashboard')).json()).data;
  const attempt = await post('student/commands/startAttempt', { assignmentId: student.assignments[0].id });
  const answerLabels = ['5 m/s', 'Tezlik'];
  for (const question of attempt.questions) {
    const selected = question.options.find(option => answerLabels.includes(option.text));
    assert(selected);
    await post('student/commands/saveAnswer', {attemptId: attempt.id, questionId: question.id, optionId: selected.id, expectedRevision: 0});
  }
  const score = await post('student/commands/submitAttempt', {attemptId: attempt.id});
  el('refresh-results').click();
  await until(() => el('results-body').rows.length === 1, 'teacher score');
  assert.deepEqual([...el('results-body').rows[0].cells].slice(2).map(cell => cell.textContent),
    [score.earned + ' / ' + score.maximum, score.percentage + '%']);
  assert.equal(Number(score.percentage), 100);

  const options = ['A','B','C','D'].map(markdown => ({id: crypto.randomUUID(), blocks: [{type:'text', markdown}]}));
  el('tab-new').click();
  const canonical = {title:'Fayldan',duration_seconds:3701,grading_config:{individual_enabled:true},questions:[{id:crypto.randomUUID(), position:1, expected_revision:0,
    individual_points:'3.500', prompt_blocks:[{type:'formula',latex:'a^2',display:'inline'}], options, correct_option_id:options[1].id, explanation_blocks:[]}]};
  const mixed = {...canonical, duration_hours:1.5};
  selectFile(el('test-file'), new File([JSON.stringify(mixed)], 'mixed.json', {type:'application/json'}));
  await until(() => el('problem').textContent && el('edit-file').disabled, 'two duration units rejected');
  const sample = await (await browserFetch('/teacher/sample.json')).text();
  selectFile(el('test-file'), new File([sample], 'hours.json', {type:'application/json'}));
  await until(() => !el('edit-file').disabled, 'JSON hours accepted');
  el('edit-file').click();
  assert.equal(el('editor-duration').value, String(JSON.parse(sample).duration_hours));
  window.confirm = () => true;
  el('new-editor').click();
  selectFile(el('test-file'), new File([JSON.stringify(canonical)], 'source.json', {type:'application/json'}));
  await until(() => !el('edit-file').disabled && el('preview').textContent.includes('Fayldan'), 'canonical JSON preview');
  el('edit-file').click();
  assert.equal(source().value, 'a^2');
  assert.equal(prompt().querySelector('.formula-editor select').value, 'inline');
  assert(group('2-javob').querySelector('input[type=radio]').checked);
  assert.equal(el('question-points').value, '3.500');
  submit(el('editor-form'), el('save-editor'));
  await until(() => el('save-editor').textContent === 'O‘zgarishlarni saqlash' && !el('editor-controls').disabled, 'open saved weighted draft');
  const weightedId = el('saved-test').value;
  el('add-question').click();
  assert.equal(el('question-points').value,'');
  input(prompt().querySelector('textarea'),'Yangi savol');
  for(let i=1;i<=4;i++) input(group(i+'-javob').querySelector('textarea'),'Javob '+i);
  group('4-javob').querySelector('input[type=radio]').click();
  for(const invalid of ['', '0', '0.000', '01', '1.2345', '30.001','1e1','1,0','1.0 ']) {
    input(el('question-points'),invalid); submit(el('editor-form'),el('save-editor'));
    assert.match(el('problem').textContent,/2-savol.*Savol balini/);
  }
  for(const points of ['0.001','30.000']) {
    input(el('question-points'),points); submit(el('editor-form'),el('save-editor'));
    await until(() => !el('editor-controls').disabled && el('save-editor').disabled, 'weighted edit accepted');
    const stored = await post('teacher/commands/readDraft',{testId:weightedId});
    assert.deepEqual(stored.draft.questions.map(q=>q.individual_points), ['3.500',points]);
    assert(stored.draft.grading_config.individual_enabled);
    assert.equal(stored.draft.duration_seconds, 3701);
  }
});
