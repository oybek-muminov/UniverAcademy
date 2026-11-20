export function groupStatusLabel(status) {
  if (status === 'active') return 'Faol guruh';
  if (status === 'archived') return 'Arxivlangan guruh';
  return 'Guruh faol emas';
}

function mountStudentPicker(el, readAvailableStudents, addMember) {
  const list = el('available-list'), add = el('available-add');
  const previous = el('available-previous'), next = el('available-next'), retry = el('available-retry');
  const status = el('available-status');
  let group = null, pages = [null], nextCursor = null, controller;

  function clear() {
    controller?.abort();
    el('available-form').removeAttribute('aria-busy');
    nextCursor = null;
    list.replaceChildren();
    el('available-label').hidden = add.hidden = true;
    add.disabled = true;
    previous.hidden = next.hidden = retry.hidden = true;
    status.textContent = '';
  }
  async function readPage() {
    clear();
    if (!group) return;
    const signal = (controller = new AbortController()).signal;
    const after = pages.at(-1);
    status.textContent = 'O‘quvchilar yuklanmoqda…';
    el('available-form').setAttribute('aria-busy', 'true');
    try {
      const data = await readAvailableStudents(group, after, signal);
      if (signal.aborted) return;
      if (!Array.isArray(data?.students) || data.students.some(row =>
        typeof row?.name !== 'string' || typeof row.univeracademy_id !== 'string' || !/^[0-9]{10}$/.test(row.univeracademy_id)) ||
        data.nextCursor !== null && (typeof data.nextCursor !== 'string' || !/^[0-9]{10}$/.test(data.nextCursor) || data.nextCursor <= (after ?? ''))) {
        throw Error('O‘quvchilar ro‘yxatini o‘qib bo‘lmadi.');
      }
      const options = data.students.map(row => new Option(row.name + ' · ' + row.univeracademy_id, row.univeracademy_id));
      list.replaceChildren(...options);
      list.selectedIndex = -1;
      el('available-label').hidden = add.hidden = !options.length;
      nextCursor = data.nextCursor;
      next.hidden = nextCursor === null;
      status.textContent = options.length ? 'Bu sahifada ' + options.length + ' ta o‘quvchi.' :
        after ? 'Bu sahifada o‘quvchi qolmagan.' : 'Hozircha guruhga kirmagan o‘quvchi yo‘q.';
    } catch (error) {
      if (signal.aborted) return;
      status.textContent = error.message || 'O‘quvchilar ro‘yxatini yuklab bo‘lmadi.';
      retry.hidden = false;
    } finally {
      if (!signal.aborted) {
        previous.hidden = pages.length === 1;
        el('available-form').removeAttribute('aria-busy');
      }
    }
  }
  function show(groupId, refresh = false) {
    if (groupId === group && !refresh) return;
    group = groupId;
    pages = [null];
    el('available-students').hidden = !group;
    void readPage();
  }
  previous.onclick = () => { if (pages.length > 1) { pages.pop(); void readPage(); } };
  next.onclick = () => { if (nextCursor) { pages.push(nextCursor); void readPage(); } };
  retry.onclick = readPage;
  list.onchange = () => { add.disabled = !list.value; };
  el('available-form').onsubmit = event => {
    event.preventDefault();
    if (group && !add.disabled && list.value) void addMember(group, list.value);
  };
  return { show, refresh() { if (group) show(group, true); } };
}

// Mounted by both the standalone local rehearsal and the authenticated staff entrance.
// Sessions, authorization, media transport and invitation destinations belong to each host.
export function mountTeacherWorkspace(root, {
  readDashboard, readAvailableStudents, request, upload, renderBlocks, mountTeacherEditor, showStudentView,
  mountVisualFormula, inviteLink, sentMessage, hashNavigation = false,
}) {
  const controls = new Map([...root.querySelectorAll('[id]')].map(item => [item.id, item]));
  const el = id => controls.get(id);
  const maxBytes = 512 * 1024;
  let disposed = false;
  let dashboard;
  let preview;
  let fileVersion = 0;
  let editingId = null, savedSelection = 0;
  let readVersion = 0;
  let writing = false;
  const retries = new Map();
  const invites = new Map();
  const picker = mountStudentPicker(el, readAvailableStudents, addStudent);

  function node(tag, text) {
    const item = document.createElement(tag);
    item.textContent = text;
    return item;
  }
  function selectRows(id, rows, selected, label) {
    const select = el(id);
    const previous = selected ?? select.value;
    select.replaceChildren(...rows.map(row => new Option(label(row), row.id)));
    if (rows.some(row => row.id === previous)) select.value = previous;
  }
  function notice(text = '', error = '') {
    if (disposed) return;
    el('notice').textContent = text;
    el('problem').textContent = error;
  }

  async function load(selection = {}) {
    const version = ++readVersion;
    const next = await readDashboard();
    if (disposed || version !== readVersion) return;
    dashboard = next;
    el('identity-name').textContent = next.name;
    if (next.subjects) {
      for (const id of ['group-subject', 'test-subject']) {
        selectRows(id, next.subjects, undefined, subject => subject.title);
        el(id).disabled = !next.subjects.length || (id === 'test-subject' && Boolean(editingId));
        el(id + '-label').hidden = false;
      }
    }
    selectRows('member-group', next.groups, selection.group, group => group.name);
    selectRows('saved-test', next.tests, selection.test, test => test.title);
    selectRows('result-group', next.groups, undefined, group => group.name);
    renderGroup();
    renderTest(selection.group);
    renderResults();
  }
  async function refresh() {
    if (writing) return;
    try {
      await load();
      el('problem').textContent = '';
    } catch (error) { notice('', error.message); }
  }
  async function command(action, input, success, complete) {
    if (disposed || writing || !dashboard) return;
    writing = true;
    el('main').setAttribute('aria-busy', 'true');
    if (dashboard.subjects && (action === 'importTest' || action === 'createGroup')) {
      const subjectId = el(action === 'createGroup' ? 'group-subject' : 'test-subject').value;
      if (!subjectId) {
        el('main').removeAttribute('aria-busy'); writing = false;
        notice('', 'Ruxsat berilgan fanni tanlang.'); return;
      }
      input = { ...input, subjectId };
    }
    const fingerprint = JSON.stringify([action, input]);
    const key = retries.get(fingerprint) ?? crypto.randomUUID();
    let data;
    try {
      data = await request('commands/' + action, input, key);
    } catch (error) {
      if (error.uncertain) retries.set(fingerprint, key);
      else retries.delete(fingerprint);
      notice('', error.message);
      writing = false;
      el('main').removeAttribute('aria-busy');
      return;
    }
    if (disposed) return;
    retries.delete(fingerprint);
    try {
      const selection = complete?.(data) ?? {};
      notice(success);
      await load(selection);
    } catch (error) {
      notice(success, error.message);
    } finally {
      writing = false;
      el('main').removeAttribute('aria-busy');
    }
    return data;
  }

  function renderGroup() {
    const group = dashboard.groups.find(row => row.id === el('member-group').value);
    picker.show(currentPage === 'guruhlar' && group?.status === 'active' ? group.id : null);
    el('group-content').hidden = !group;
    el('group-empty').hidden = Boolean(group);
    if (!group) return;
    const active = group.status === 'active';
    el('group-status').textContent = groupStatusLabel(group.status);
    el('member-form').hidden = !active;
    el('invite-section').hidden = !active;
    const rows = group.members.map(member => {
      const li = node('li', member.name);
      li.append(node('span', member.univeracademy_id));
      return li;
    });
    el('members').replaceChildren(...rows);
    if (active && !rows.length) el('members').append(node('li', 'Guruhga hozircha o‘quvchi qo‘shilmagan.'));
    const invite = invites.get(group.id);
    el('invite-detail').hidden = !active || !invite;
    if (!active || !invite) return;
    el('invite-url').value = invite.telegramUrl;
    el('open-invite').href = invite.openUrl;
    el('open-invite').textContent = invite.label;
    el('invite-note').textContent = invite.note;
  }
  function renderTest(preferredGroup) {
    const test = dashboard.tests.find(row => row.id === el('saved-test').value);
    if (el('saved-preview').dataset.test !== test?.id) {
      el('saved-preview').hidden = true;
      el('saved-preview').replaceChildren();
    }
    el('test-content').hidden = !test;
    el('tests-empty').hidden = Boolean(test);
    if (!test) return;
    const published = test.status === 'published';
    const state = published ? 'Nashr qilingan' : 'Qoralama';
    el('test-meta').textContent = [state, test.questionCount + ' ta savol', test.duration_seconds + ' soniya'].join(' · ');
    el('publish-button').hidden = published;
    el('edit-saved').hidden = test.status !== 'draft';
    const assigned = dashboard.assignments.filter(row => row.testId === test.id);
    const groups = dashboard.groups.filter(group => group.status === 'active' && (!test.subjectId || group.subjectId === test.subjectId));
    const available = groups.filter(group => !assigned.some(row => row.groupId === group.id));
    const selected = available.some(group => group.id === preferredGroup) ? preferredGroup : undefined;
    selectRows('assignment-group', available, selected, group => group.name);
    el('assign-form').hidden = !published || !available.length;
    const assignedNames = groups.filter(group => assigned.some(row => row.groupId === group.id)).map(group => group.name);
    let message = assignedNames.length ? 'Tayinlangan guruhlar: ' + assignedNames.join(', ') : '';
    if (published && !groups.length) message = 'Testni tayinlash uchun shu fandan faol guruh yarating.';
    el('assignment-info').textContent = message;
  }
  function renderResults() {
    const groupId = el('result-group').value;
    const results = dashboard.results.filter(result => result.groupId === groupId);
    el('result-group').disabled = !dashboard.groups.length;
    el('results-empty').hidden = Boolean(results.length);
    el('results-empty').textContent = groupId ? 'Bu guruhda hali topshirilgan test yo‘q.' : 'Natijalarni ko‘rish uchun avval guruh yarating.';
    el('results-wrap').hidden = !results.length;
    el('results-body').replaceChildren(...results.map(result => {
      const row = document.createElement('tr');
      for (const value of [result.studentName, result.title, result.earned + ' / ' + result.maximum, result.percentage + '%']) {
        row.append(node('td', value));
      }
      return row;
    }));
  }
  el('group-form').onsubmit = event => {
    event.preventDefault();
    const name = el('group-name').value.trim();
    if (!name) return notice('', 'Guruh nomini kiriting.');
    command('createGroup', { name }, 'Guruh yaratildi.', data => {
      el('group-name').value = '';
      return { group: data.id };
    });
  };
  el('member-form').onsubmit = event => {
    event.preventDefault();
    const id = el('student-number').value;
    if (!/^[0-9]{10}$/.test(id)) return notice('', 'UniverAcademy ID uchun aynan 10 ta raqam kiriting.');
    const groupId = el('member-group').value;
    if (event.submitter?.value === 'send') {
      command('sendInvite', { groupId, univeracademy_id: id }, sentMessage);
      return;
    }
    void addStudent(groupId, id);
  };
  async function addStudent(groupId, id) {
    if (disposed || writing || groupId !== el('member-group').value) return;
    await command('addMember', { groupId, univeracademy_id: id }, 'O‘quvchi guruhga qo‘shildi.', () => {
      if (el('member-group').value === groupId) el('student-number').value = '';
    });
    if (!disposed && el('member-group').value === groupId) picker.refresh();
  }
  el('invite-button').onclick = () => {
    const groupId = el('member-group').value;
    command('createInvite', { groupId }, 'Guruh uchun yangi taklif havolasi yaratildi.', data => {
      invites.set(groupId, inviteLink(data));
    });
  };
  el('copy-invite').onclick = async () => {
    const field = el('invite-url');
    try {
      await navigator.clipboard.writeText(field.value);
      notice('Taklif havolasi nusxalandi.');
    } catch {
      field.focus();
      field.select();
      notice('Havola belgilandi. Uni qurilmangizning nusxalash buyrug‘i bilan nusxalang.');
    }
  };

  function validInputBlocks(blocks) {
    return Array.isArray(blocks) && blocks.length > 0 && blocks.every(block =>
      block?.type === 'text' && typeof block.markdown === 'string'
      || block?.type === 'formula' && typeof block.latex === 'string' && ['inline','block'].includes(block.display)
      || block?.type === 'image' && typeof block.asset_id === 'string' && typeof block.alt === 'string'
    );
  }
  function filePreview(value) {
    if (!value || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160) {
      throw Error('Test nomini kiriting (title, 1–160 belgi).');
    }
    if (!Array.isArray(value.questions) || !value.questions.length || value.questions.length > 200) {
      throw Error('Testga 1 tadan 200 tagacha savol kiriting.');
    }
    if (value.duration_seconds !== undefined && (!Number.isInteger(value.duration_seconds) || value.duration_seconds < 1 || value.duration_seconds > 86400)) {
      throw Error('Vaqt 1–86400 oralig‘idagi butun son bo‘lishi kerak (duration_seconds).');
    }
    for (const [i, question] of value.questions.entries()) {
      if (question?.prompt_blocks) {
        if (typeof question.id !== 'string' || !Number.isInteger(question.position) || !validInputBlocks(question.prompt_blocks)
          || !Array.isArray(question.options) || question.options.length !== 4
          || !question.options.every(option => typeof option?.id === 'string' && validInputBlocks(option.blocks))
          || !question.options.some(option => option.id === question.correct_option_id) || !Array.isArray(question.explanation_blocks)) {
          throw Error((i + 1) + '-savolda savol bloklari, to‘rtta variant va to‘g‘ri variant identifikatorini tekshiring.');
        }
        continue;
      }
      if (typeof question?.text !== 'string' || !question.text.trim()
        || !Array.isArray(question.options) || question.options.length !== 4
        || !question.options.every(option => typeof option === 'string' && option.trim())
        || !Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex > 3) {
        throw Error((i + 1) + '-savolni tekshiring. Savol matni, 4 ta variant va 0 dan 3 gacha to‘g‘ri javob indeksi (correctIndex) kerak.');
      }
    }
    return value;
  }
  function drawPreview(test) {
    const box = el('preview');
    const title = node('h3', test.title);
    const lines = test.questions.map((question, i) => {
      const details = document.createElement('details');
      const summary = node('summary', (i + 1) + '. ');
      if (question.prompt_blocks) renderBlocks(summary, question.prompt_blocks);
      else summary.append(question.text);
      details.append(summary);
      const options = document.createElement('ul');
      for (const [index, value] of question.options.entries()) {
        const option = node('li', '');
        if (question.prompt_blocks) renderBlocks(option, value.blocks);
        else option.textContent = value;
        if (question.prompt_blocks ? value.id === question.correct_option_id : index === question.correctIndex) option.append(' · To‘g‘ri javob');
        options.append(option);
      }
      details.append(options);
      return details;
    });
    box.replaceChildren(title, ...lines);
    box.hidden = false;
    el('edit-file').disabled = false;
    el('save-draft').disabled = false;
  }
  function resetPreview() {
    preview = undefined;
    el('preview').replaceChildren();
    el('preview').hidden = true;
    el('edit-file').disabled = true;
    el('save-draft').disabled = true;
  }
  el('test-file').onchange = async () => {
    const version = ++fileVersion;
    resetPreview();
    notice();
    const file = el('test-file').files[0];
    if (!file) return;
    try {
      if (file.size > maxBytes) throw Error('Fayl juda katta. Bitta yuklama uchun hajm chegarasi 512 KiB.');
      let source;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw Error('Faylni UTF-8 kodlashda saqlang va qayta tanlang.'); }
      let test;
      if (/\.txt$/i.test(file.name)) test = await request('import-preview', { text: source });
      else if (/\.json$/i.test(file.name)) {
        try { test = JSON.parse(source); } catch { throw Error('JSON tuzilishida xato bor. Faylni namuna bilan solishtiring.'); }
      } else throw Error('TXT yoki JSON faylni tanlang. Namunani shu sahifadan olishingiz mumkin.');
      if (disposed || version !== fileVersion) return;
      preview = filePreview(test);
      drawPreview(preview);
      notice('Fayl o‘qildi. ' + preview.questions.length + ' ta savolni tekshirishingiz mumkin.');
    } catch (error) { if (version === fileVersion) notice('', error.message); }
  };
  el('test-form').onsubmit = event => {
    event.preventDefault();
    if (!preview) return;
    const version = fileVersion;
    command('importTest', preview, 'Test qoralamasi saqlandi.', data => {
      if (fileVersion === version) {
        el('test-file').value = '';
        resetPreview();
      }
      return { test: data.id };
    });
  };
  el('publish-button').onclick = () => {
    const testId = el('saved-test').value;
    if (!editor.readyToPublish(testId)) return notice('', 'Nashr qilishdan oldin qoralamadagi o‘zgarishlarni saqlang.');
    command('publishTest', { testId }, 'Test nashr qilindi.', () => { editor.published(testId); });
  };
  el('assign-form').onsubmit = event => {
    event.preventDefault();
    command('assignTest', { testId: el('saved-test').value, groupId: el('assignment-group').value }, 'Test guruhga tayinlandi.');
  };
  el('member-group').onchange = renderGroup;
  el('saved-test').onchange = () => { savedSelection++; renderTest(); };
  el('result-group').onchange = renderResults;
  el('refresh-groups').onclick = () => { picker.refresh(); void refresh(); };
  el('refresh-results').onclick = refresh;

  let currentPage = 'guruhlar';
  function showPage(page) {
    if (['guruhlar', 'testlar', 'natijalar'].includes(page)) currentPage = page;
    if (dashboard) renderGroup();
    for (const section of root.querySelectorAll('.page')) section.hidden = section.id !== currentPage;
    for (const link of root.querySelectorAll('nav a')) {
      if (link.hash === '#' + currentPage) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }
  const navigate = () => { showPage(location.hash.slice(1)); notice(); refresh(); };
  const focus = () => { if (dashboard && !disposed) refresh(); };
  if (hashNavigation) window.addEventListener('hashchange', navigate);
  else for (const link of root.querySelectorAll('nav a')) link.onclick = event => {
    event.preventDefault(); showPage(link.hash.slice(1)); notice(); refresh();
  };
  window.addEventListener('focus', focus);
  showPage(hashNavigation ? location.hash.slice(1) : '');
  refresh();
  el('view-saved').onclick = async () => {
    const testId = el('saved-test').value;
    try {
      const draft = await request('commands/previewTest', { testId }, crypto.randomUUID());
      if (disposed || el('saved-test').value !== testId) return;
      const box = el('saved-preview');
      box.dataset.test = testId;
      showStudentView(box, draft, renderBlocks);
      notice('Saqlangan test ochildi.');
    } catch (error) { notice('', error.message); }
  };

  const editor = mountTeacherEditor(el('question-editor'), {
    renderBlocks, mountVisualFormula, uploadImage: upload, notify: notice,
    async readDraft(testId) {
      const result = await request('commands/readDraft', {testId}, crypto.randomUUID());
      if (result?.id !== testId || !Number.isSafeInteger(result.revision) || result.revision < 0) throw Error('Qoralamani ochib bo‘lmadi.');
      filePreview(result.draft);
      return result;
    },
    saveDraft(draft, target) {
      const action = target ? 'updateDraft' : 'importTest';
      const input = target ? {testId: target.id, expectedRevision: target.revision, draft} : draft;
      return command(action, input, 'Test qoralamasi saqlandi.', data => {
        el('saved-preview').hidden = true;
        el('saved-preview').replaceChildren();
        return { test: data.id };
      });
    },
    onTargetChange(id) {
      editingId = id;
      if (!dashboard?.subjects) return;
      const subject = dashboard.tests.find(test => test.id === id)?.subjectId;
      if (subject) el('test-subject').value = subject;
      el('test-subject').disabled = Boolean(id) || !dashboard.subjects.length;
    },
  });
  el('edit-saved').onclick = () => {
    const id = el('saved-test').value;
    const selection = savedSelection;
    const selectedDraft = () => !disposed && savedSelection === selection && el('saved-test').value === id && dashboard.tests.some(test => test.id === id && test.status === 'draft');
    if (selectedDraft()) void editor.openSaved(id, selectedDraft);
  };
  el('edit-file').onclick = () => { if (preview) editor.openFile(preview); };

  return () => {
    disposed = true;
    editor.dispose();
    picker.show(null);
    fileVersion++; readVersion++;
    window.removeEventListener('focus', focus);
    if (hashNavigation) window.removeEventListener('hashchange', navigate);
  };
}
