import { renderBlocks } from '/pilot/blocks.mjs';

const root = document.querySelector('#content');
const notice = document.querySelector('#notice');
const invite = new URL(location.href).searchParams.get('invite');
let dashboard, attempt, assignmentId, result, confirmSubmit = false, busy = false, needsRead = false;
let expiryTimer;
const pending = new Map();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function tell(message = '', error = false) {
  notice.textContent = message;
  notice.toggleAttribute('data-error', error);
}
const messages = {
  INVALID_INVITE: 'Taklif havolasi topilmadi. O‘qituvchidan yangi havola so‘rang.',
  INVITE_EXPIRED: 'Taklifning muddati tugagan. O‘qituvchidan yangi havola so‘rang.',
  GROUP_MEMBERSHIP_CONFLICT: 'Siz boshqa guruhga biriktirilgansiz. Guruhni almashtirish uchun adminga murojaat qiling.',
  ANSWER_REVISION_CONFLICT: 'Bu javob boshqa oynada o‘zgargan. Saqlangan holatni ko‘rib, javobingizni qayta tanlang.',
};
async function request(path, options = {}) {
  const response = await fetch('/local-pilot/student/' + path, {
    cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(15000), ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    const e = new Error(messages[payload.error?.code] || (response.status === 409
      ? 'Holat o‘zgargan. Yangilangan ma’lumotni tekshiring.'
      : 'Amal bajarilmadi. Kabinetni yangilab qayta urinib ko‘ring.'));
    e.status = response.status;
    throw e;
  }
  return payload.data;
}
function login(actor) {
  return request('session', {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({actor})});
}
async function command(action, input) {
  const body = JSON.stringify(input);
  // Store only a retry key and a digest. Answers, invitation tokens and identities do not go into storage.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify([dashboard.univeracademy_id, action, body]))));
  const slot = 'ua-pilot:' + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  let key = pending.get(slot);
  try { key ??= sessionStorage.getItem(slot); } catch { /* in-memory retry remains available */ }
  key ??= crypto.randomUUID();
  pending.set(slot, key);
  try { sessionStorage.setItem(slot, key); } catch { /* private browser storage may be unavailable */ }
  const data = await request('commands/' + action, {
    method: 'POST', headers: {'Content-Type':'application/json', 'Idempotency-Key':key}, body,
  });
  pending.delete(slot);
  try { sessionStorage.removeItem(slot); } catch { /* result already committed */ }
  return data;
}
function button(text, handler, secondary = false) {
  const el = element('button', text, secondary ? 'secondary' : '');
  el.type = 'button';
  el.addEventListener('click', () => run(handler));
  return el;
}
function panel() { return element('section', undefined, 'panel'); }
function actions(...nodes) {
  const row = element('div', undefined, 'actions'); row.append(...nodes); return row;
}
async function refresh() {
  dashboard = await request('dashboard');
  attempt = result = assignmentId = null;
  confirmSubmit = needsRead = false;
}
async function startPage() {
  try { await refresh(); }
  catch (e) {
    if (e.status !== 401) throw e;
    await login('student1');
    await refresh();
  }
}
async function run(fn) {
  if (busy) return;
  busy = true;
  tell();
  root.inert = true;
  root.setAttribute('aria-busy', 'true');
  try { await fn(); }
  catch (e) {
    const uncertain = !e.status || e.status >= 500;
    if (uncertain && attempt) needsRead = true;
    if (e.status === 409 || e.status === 410 || e.status === 401 || (uncertain && attempt)) {
      try {
        const id = attempt?.id, assignment = assignmentId, oldId = dashboard?.univeracademy_id;
        await refresh();
        const inProgress = dashboard.assignments.find(x => x.id === assignment && x.attemptId === id && x.status === 'in_progress');
        if (oldId === dashboard.univeracademy_id && inProgress) await resume(inProgress);
      } catch { /* the refresh button remains available */ }
    }
    tell(uncertain ? 'So‘rov tasdiqlanmadi. Saqlangan holatni tekshiring va kerak bo‘lsa qayta urinib ko‘ring.' : e.message, true);
  } finally {
    busy = false;
    root.inert = false;
    root.removeAttribute('aria-busy');
    render();
  }
}
async function resume(exam) {
  const latest = await command('resumeAttempt', {attemptId:exam.attemptId});
  if (latest.status !== 'in_progress') { await refresh(); return; }
  assignmentId = exam.id; attempt = latest; confirmSubmit = needsRead = false;
}
function showDashboard() {
  root.append(element('h1', dashboard.name), element('p', 'UniverAcademy ID · ' + dashboard.univeracademy_id, 'meta'));
  if (invite && new URL(location.href).searchParams.has('invite')) {
    const block = panel();
    block.append(element('h2','Guruhga taklif'), element('p','Taklifni shu hisob bilan qabul qilishingiz mumkin.'));
    block.append(button('Taklifni qabul qilish', async () => {
      const group = await command('acceptInvite', {token:invite});
      const url = new URL(location.href); url.searchParams.delete('invite');
      history.replaceState(null, '', url);
      await refresh();
      tell('Siz «' + group.name + '» guruhiga qo‘shildingiz.');
    }));
    root.append(block);
  }
  if (dashboard.inbox?.length) {
    const inbox = panel();
    inbox.append(element('h2','Botdan kelgan takliflar'));
    for (const message of dashboard.inbox) {
      const link = element('a', message.groupName + ' · Botda ochish', 'action secondary');
      link.href = '/bot/?start=' + encodeURIComponent(message.token);
      inbox.append(actions(link));
    }
    root.append(inbox);
  }
  const group = panel();
  group.append(element('h2','Guruhim'), element('p',dashboard.group?.name || 'Hozircha guruhga biriktirilmagansiz.'));
  root.append(group, element('h2','Testlarim', 'section-heading'));
  if (!dashboard.assignments.length) root.append(element('p','Hozircha sizga test tayinlanmagan.', 'meta'));
  for (const exam of dashboard.assignments) {
    const block = panel();
    block.append(element('h2',exam.title));
    if (exam.status === 'available') block.append(button('Testni boshlash', async () => {
      attempt = await command('startAttempt', {assignmentId:exam.id}); assignmentId = exam.id;
      if (attempt.status !== 'in_progress') await refresh();
    }));
    else if (exam.status === 'in_progress') block.append(button('Testni davom ettirish', () => resume(exam)));
    else {
      const own = dashboard.results.find(row => row.attemptId === exam.attemptId);
      if (own) block.append(button('Natijani ko‘rish', async () => { result = own; }));
      else block.append(element('p',exam.status === 'expired' ? 'Vaqt tugagan.' : 'Test yakunlangan.', 'meta'));
    }
    root.append(block);
  }
  const others = dashboard.univeracademy_id === '0100000001' ? ['student2','0100000002'] : ['student1','0100000001'];
  root.append(actions(button('Kabinetni yangilash',refresh,true),
    button('Sinov hisobiga o‘tish · ' + others[1], async () => { await login(others[0]); await refresh(); },true)));
}
function displayDate(value) {
  return new Intl.DateTimeFormat('uz-UZ', {timeZone:'Asia/Tashkent',dateStyle:'short',timeStyle:'short'}).format(new Date(value));
}
function showAttempt() {
  const exam = dashboard.assignments.find(x => x.id === assignmentId);
  const saved = attempt.answers.filter(a => a.optionId !== null).length;
  root.append(element('h1',exam?.title || 'Test'),
    element('p', 'Saqlangan javoblar: ' + saved + ' / ' + attempt.questions.length + ' · Tugash vaqti: ' + displayDate(attempt.deadlineAt) + ' (Toshkent)', 'meta'));
  for (const [index,q] of attempt.questions.entries()) {
    const row = attempt.answers.find(a => a.questionId === q.id);
    const card = panel(), fields = element('fieldset');
    fields.disabled = needsRead;
    const legend = element('legend', undefined, 'question');
    legend.append(document.createTextNode((index + 1) + '. '));
    renderBlocks(legend, q.prompt_blocks ?? q.blocks ?? [{type:'text',markdown:q.text}]);
    fields.append(legend);
    for (const opt of q.options) {
      const label = element('label',undefined,'option'), radio = element('input');
      radio.type = 'radio'; radio.name = q.id; radio.value = opt.id; radio.checked = opt.id === row?.optionId;
      radio.addEventListener('change', () => run(async () => {
        confirmSubmit = false;
        const reply = await command('saveAnswer',{attemptId:attempt.id,questionId:q.id,optionId:opt.id,expectedRevision:row?.revision ?? 0});
        attempt.answers = [...attempt.answers.filter(a => a.questionId !== q.id), reply];
        tell((index + 1) + '-savolning javobi saqlandi.');
      }));
      const option = element('span');
      renderBlocks(option, opt.blocks ?? [{type:'text',markdown:opt.text}]);
      label.append(radio,option); fields.append(label);
    }
    card.append(fields); root.append(card);
  }
  if (needsRead) {
    root.append(button('Saqlangan javoblarni yangilash', () => resume({id:assignmentId,attemptId:attempt.id})));
  } else if (confirmSubmit) {
    const box = panel();
    box.append(element('h2','Testni yakunlaysizmi?'),
      element('p','Javob berilgan savollar: ' + saved + ' / ' + attempt.questions.length + '. Yuborgach, javoblaringiz saqlanadi va urinish yakunlanadi.'),
      actions(button('Ha, javoblarni yuborish', async () => {
        const id = attempt.id, summary = await command('submitAttempt',{attemptId:id});
        await refresh();
        result = dashboard.results.find(r => r.attemptId === id) || {...summary,title:exam?.title};
      }), button('Testga qaytish', async () => { confirmSubmit = false; },true)));
    root.append(box);
  } else root.append(actions(button('Testni yakunlash',async () => { confirmSubmit = true; }),
    button('Saqlangan javoblarni yangilash',() => resume({id:assignmentId,attemptId:attempt.id}),true),
    button('Kabinetga qaytish',refresh,true)));
  const remaining = Date.parse(attempt.deadlineAt) - Date.now();
  if (remaining > 0 && remaining < 2147483000) expiryTimer = setTimeout(() => run(refresh), remaining + 250);
}
function render() {
  clearTimeout(expiryTimer);
  root.replaceChildren();
  if (!dashboard) {
    root.append(element('h1','O‘quvchi kabineti'),button('Qayta ulanish',startPage));
  } else if (result) {
    const box = panel();
    root.append(element('h1','Test natijasi'));
    box.append(element('h2',result.title || 'Test'),element('p',result.earned + ' / ' + result.maximum + ' ball','score'),
      element('p',result.percentage + '%'),button('Kabinetga qaytish',refresh,true));
    root.append(box);
  } else if (attempt) showAttempt();
  else showDashboard();
}
run(startPage);
