import { createOwnerTransport, uuid } from './owner-transport.mjs';
import { ownerTitle } from './owner-route.mjs';


const subjectNames = { physics: 'Fizika' };
const cabinetId = value => typeof value === 'string' && /^[0-9]{10}$/.test(value);
const reasons = {
  not_student: 'Bu odam o‘quvchi emas (allaqachon xodim).',
  incomplete: 'Bu o‘quvchi ro‘yxatdan o‘tishni tugatmagan.',
  in_group: 'Bu o‘quvchi guruhda. Avval uni guruhdan chiqarish kerak.',
};
const faultTexts = {
  TARGET_NOT_STUDENT: 'Bu odam o‘quvchi emas, shuning uchun ustoz qilib bo‘lmaydi.',
  TARGET_INCOMPLETE: reasons.incomplete,
  TARGET_IN_GROUP: reasons.in_group,
  NOT_FOUND: 'Bunday ID topilmadi.',
  TEACHER_APPOINTMENT_UNAVAILABLE: 'Ustoz tayinlash hozir mavjud emas.',
};
const historyTime = new Intl.DateTimeFormat('uz-Latn-UZ',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Tashkent'});
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const overviewLabels = {
  activeTeachers: 'Faol ustozlar', activeStudents: 'Faol o‘quvchilar', activeGroups: 'Faol guruhlar',
  openAssignments: 'Hozir ochiq topshiriqlar', submittedLast7Days: 'So‘nggi 7 kundagi topshirishlar',
  pendingGroups: 'Tasdiq kutayotgan guruhlar', groupsWithoutUpcomingAssignment: 'Ochiq yoki rejalangan topshirig‘i yo‘q faol guruhlar',
};
// Only well-formed teachers from the server are shown; anything else is dropped, never displayed as text of unknown shape.
const cleanTeachers = list => (Array.isArray(list) ? list : []).filter(t => t && typeof t.name === 'string' && t.name.trim() && cabinetId(t.univeracademy_id) &&
  Array.isArray(t.subjects) && t.subjects.every(x => typeof x === 'string')).slice(0, 200);

// The Owner's page. Every screen is rebuilt from a fresh server answer for exactly this signed-in session;
// a changed session, a denial or a wrong answer replaces the page with a closed notice.
export function mountOwnerCabinet(host, options) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const expected = options.identity.current();
  let controller, boundPerson = null, disposed = false, notice = '';
  const sameIdentity = () => {
    const now = options.identity.current();
    return expected && now && now.userId === expected.userId && now.generation === expected.generation;
  };
  const button = (name, click) => { const node = doc.createElement('button'); node.type = 'button'; node.textContent = name; node.onclick = click; return node; };
  function clear() { controller?.abort(); controller = null; host.replaceChildren(); }
  function panel(text, actions = []) {
    const section = doc.createElement('section'); section.className = 'status-card';
    const body = doc.createElement('p'); body.setAttribute('role', 'status'); body.textContent = text;
    section.append(body, ...actions); host.replaceChildren(section);
  }
  async function signout() {
    clear();
    try { if (sameIdentity()) await options.identity.signOut(expected); }
    catch { if (!disposed && sameIdentity()) panel('Chiqishni yakunlab bo‘lmadi.', [button('Qayta urinish', signout)]); }
  }

  // One screen from one fresh server answer: who is signed in, the Teachers made so far, and how to make a new one.
  function render(data, port, signal, flash) {
    const element = (tag, text, className) => { const node = doc.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    const section = element('section', undefined, 'status-card');
    section.append(element('h1', ownerTitle), element('p', data.name));
    if (flash) { const done = element('p', flash); done.setAttribute('role', 'status'); section.append(done); }
    const counters = Object.entries(overviewLabels);
    if (data.overview && counters.every(([key]) => nonnegativeInteger(data.overview[key]))) {
      section.append(element('h2', 'Umumiy holat'));
      for (const [start, end] of [[0, 5], [5, counters.length]]) {
        if (start) section.append(element('h3', 'E’tibor kerak'));
        const summary = element('dl');
        for (const [key, label] of counters.slice(start, end)) summary.append(element('dt', label), element('dd', String(data.overview[key])));
        section.append(summary);
      }
    }
    const teachers = cleanTeachers(data.teachers);
    section.append(element('h2', 'Ustozlar'));
    if (!teachers.length) section.append(element('p', 'Hozircha ustoz yo‘q.'));
    else {
      const list = element('ul');
      for (const t of teachers) list.append(element('li', t.name + ' · ID ' + t.univeracademy_id + (t.subjects.length ? ' · ' + t.subjects.map(x => subjectNames[x] ?? x).join(', ') : '') + (nonnegativeInteger(t.activeGroupCount) ? ' · Faol guruhlar: ' + t.activeGroupCount : '')));
      section.append(list);
    }
    if (Array.isArray(data.appointmentHistory)) {
      section.append(element('h2', 'Ustoz tayinlash tarixi'));
      const events = data.appointmentHistory.slice(0, 12).filter(x => x && nonnegativeInteger(x.atMs) &&
        x.atMs <= 253402300799999 && typeof x.actorName === 'string' && typeof x.targetName === 'string');
      if (!events.length) section.append(element('p', 'Hozircha tayinlash qayd etilmagan.'));
      else {
        const log = element('dl');
        for (const event of events) log.append(element('dt', historyTime.format(event.atMs)),
          element('dd', (event.actorName.trim() || 'Ega') + ': ' + (event.targetName.trim() || 'Hisob mavjud emas')));
        section.append(log);
      }
    }
    if (Array.isArray(data.accountRequestHistory)) {
      const requests = element('section');
      requests.append(element('h2', 'Hisobni o‘chirish so‘rovlari'));
      const entries = data.accountRequestHistory.slice(0, 12).filter(x => x && nonnegativeInteger(x.atMs) &&
        x.atMs <= 253402300799999 && typeof x.teacherName === 'string' && x.teacherName.trim());
      if (!entries.length) requests.append(element('p', 'Hozircha ustozlardan so‘rov qayd etilmagan.'));
      else {
        requests.append(element('p', 'Bu ro‘yxat faqat ko‘rish uchun. Hech qanday hisob avtomatik o‘chirilmaydi.'));
        const log = element('dl');
        for (const entry of entries) log.append(element('dt', historyTime.format(entry.atMs)), element('dd', entry.teacherName));
        requests.append(log);
      }
      section.append(requests);
    }
    section.append(element('h2', 'O‘qituvchi tayinlash'));
    if (data.canAssignTeacher !== true) section.append(element('p', 'Ustoz tayinlash hozir mavjud emas. O‘quvchini ID bo‘yicha topish mumkin.'));
    const label = element('label', 'O‘quvchining 10 xonali UniverAcademy ID raqami');
    const input = doc.createElement('input');
    input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 10; input.autocomplete = 'off'; input.name = 'univeracademy_id';
    label.append(doc.createElement('br'), input);
    const find = button('Topish', () => void lookup());
    const result = element('div'); result.setAttribute('aria-live', 'polite');
    section.append(label, find, result, doc.createElement('hr'), button('Chiqish', signout));
    host.replaceChildren(section);
    let busy = false, found = null, key = null;
    const say = (text, ...actions) => { const line = element('p', text); line.setAttribute('role', 'status'); result.replaceChildren(line, ...actions); };
    const guard = async job => {
      if (busy || signal.aborted || !sameIdentity()) return;
      busy = true; find.disabled = true;
      try { await job(); }
      catch (error) {
        if (signal.aborted || !sameIdentity()) return;
        if (error.uncertain) say('Natija noma‘lum. Ro‘yxatni yangilab tekshiring.', button('Yangilash', open));
        else say(faultTexts[error.code] ?? 'Bajarib bo‘lmadi. Qayta urinib ko‘ring.');
      } finally { busy = false; find.disabled = false; }
    };
    async function lookup() {
      const id = input.value.trim();
      found = null; key = null;
      if (!cabinetId(id)) { say('ID aynan 10 ta raqamdan iborat bo‘lishi kerak.'); return; }
      await guard(async () => {
        const student = await port.findStudent(id);
        if (signal.aborted || !sameIdentity() || input.value.trim() !== id) return;
        if (!student || student.found !== true || student.univeracademy_id !== id || typeof student.name !== 'string' || !student.name.trim()) { say('Bunday ID topilmadi.'); return; }
        if (student.eligible !== true) { say(student.name + ' · ID ' + id + '. ' + (reasons[student.reason] ?? 'Ustoz qilib bo‘lmaydi.')); return; }
        if (data.canAssignTeacher !== true) { say(student.name + ' · ID ' + id + '. Ustoz tayinlash hozir mavjud emas.'); return; }
        found = { id, name: student.name }; key = crypto.randomUUID();
        say(student.name + ' · ID ' + id + '. Fizika ustozi qilinsinmi?', button('Ustoz qilish', confirm));
      });
    }
    function confirm() {
      if (!found || found.id !== input.value.trim() || data.canAssignTeacher !== true) return;
      const target = found, commandKey = key;
      say(target.name + ' fizika ustozi bo‘ladi va unga Telegramda xabar boradi. Tasdiqlaysizmi?',
        button('Ha, ustoz qilish', () => void guard(async () => {
          if (found !== target || input.value.trim() !== target.id) return;
          const made = await port.assignTeacher(target.id, commandKey);
          if (signal.aborted || !sameIdentity()) return;
          if (made?.univeracademy_id !== target.id) throw Object.assign(new Error('answer'), {});
          notice = target.name + ' endi fizika ustozi. Unga Telegramda xabar yuboriladi.';
          void open();
        })), button('Bekor qilish', () => { found = null; key = null; say('Bekor qilindi.'); }));
    }
    input.addEventListener('input', () => { found = null; key = null; result.replaceChildren(); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void lookup(); } });
  }
  async function open() {
    clear();
    if (disposed || !sameIdentity() || doc.visibilityState === 'hidden') return;
    controller = new AbortController();
    const { signal } = controller;
    panel('Ruxsat tekshirilmoqda…');
    const denied = status => {
      if (signal.aborted) return;
      clear();
      panel(status === 403 ? 'Bu kabinet faqat Ega uchun.' : 'Kirish sessiyasini tekshiring.', [button('Qayta tekshirish', open), button('Chiqish', signout)]);
    };
    const port = createOwnerTransport({ ...options, signal, expected, onDenied: denied });
    try {
      const data = await port.dashboard();
      if (signal.aborted || !sameIdentity()) return;
      if (data?.role !== 'owner' || !uuid(data.person_id) || boundPerson && data.person_id !== boundPerson || typeof data.name !== 'string' || !data.name.trim()) {
        denied(403); return;
      }
      boundPerson = data.person_id;
      render(data, port, signal, notice);
      notice = '';
    } catch { if (!signal.aborted) { clear(); panel('Kabinetni yuklab bo‘lmadi.', [button('Qayta urinish', open)]); } }
  }
  const unsubscribe = options.identity.subscribe(() => { clear(); if (sameIdentity()) void open(); });
  const resume = () => { if (doc.visibilityState !== 'hidden' && !controller) void open(); };
  doc.addEventListener('visibilitychange', resume);
  void open();
  return () => { disposed = true; clear(); unsubscribe(); doc.removeEventListener('visibilitychange', resume); };
}
