import { hoursFromSeconds, secondsFromHours } from '../../../packages/test-content/duration.mjs';
import { meaningful } from './draft-autosave.mjs';

function node(tag, text) {
  const item = document.createElement(tag);
  item.textContent = text;
  return item;
}
function newQuestion() {
  const emptyText = () => [{ type: 'text', markdown: '' }];
  return {
    id: crypto.randomUUID(), position: 1, expected_revision: 0, prompt_blocks: emptyText(),
    options: Array.from({ length: 4 }, () => ({ id: crypto.randomUUID(), blocks: emptyText() })),
    correct_option_id: '', explanation_blocks: [],
  };
}
function button(text, handler) {
  const element = node('button', text);
  element.type = 'button';
  element.onclick = handler;
  return element;
}
function labelled(text, control) {
  const label = node('label', text);
  label.append(control);
  return label;
}
export function showStudentView(box, draft, renderBlocks, signal) {
  const pending = new Map();
  const Observer = box.ownerDocument.defaultView.IntersectionObserver;
  const observer = Observer && signal ? new Observer(entries => {
    if (signal.aborted) return;
    for (const {target, isIntersecting} of entries) {
      const block = pending.get(target);
      if (!isIntersecting || !block) continue;
      observer.unobserve(target);
      pending.delete(target);
      target.replaceChildren();
      renderBlocks(target, [block], signal);
    }
  }, {root:box.closest('dialog'), rootMargin:'320px 0px'}) : null;
  if (observer) signal.addEventListener('abort', () => { observer.disconnect(); pending.clear(); }, {once:true});
  function renderPreview(container, blocks) {
    if (!observer || !blocks.some(block => block.type === 'image')) {
      renderBlocks(container, blocks, signal);
      return;
    }
    for (const block of blocks) {
      if (block.type !== 'image') { renderBlocks(container, [block], signal); continue; }
      const slot = node('span', block.alt || 'Savol tasviri');
      container.append(slot);
      pending.set(slot, block);
      observer.observe(slot);
    }
  }
  box.replaceChildren();
  if (draft.instructions_blocks?.length) {
    const instructions = document.createElement('div');
    instructions.className = 'preview-blocks';
    renderPreview(instructions, draft.instructions_blocks);
    box.append(instructions);
  }
  for (const [index, question] of draft.questions.entries()) {
    const field = document.createElement('fieldset');
    field.append(node('legend', (index + 1) + '-savol'));
    const content = document.createElement('div');
    content.className = 'preview-blocks';
    renderPreview(content, question.prompt_blocks ?? [{type:'text',markdown:question.text}]);
    field.append(content);
    for (const option of question.options) {
      const label = document.createElement('label');
      label.className = 'preview-option';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = box.id + '-' + index;
      const blocks = document.createElement('span');
      blocks.className = 'preview-blocks';
      renderPreview(blocks, typeof option === 'string' ? [{type:'text',markdown:option}] : option.blocks);
      label.append(radio, blocks);
      field.append(label);
    }
    box.append(field);
  }
}
function makeLayout(root) {
  function item(tag, id, text = '') {
    const element = node(tag, text);
    element.id = id;
    return element;
  }
  function action(id, label, type = 'button') {
    const control = item('button', id, label);
    control.type = type;
    return control;
  }
  const form = item('form', 'editor-form');
  form.noValidate = true;
  const meta = document.createElement('div');
  meta.className = 'editor-meta';
  const title = item('input', 'editor-title');
  title.maxLength = 160;
  title.required = true;
  const duration = item('input', 'editor-duration');
  Object.assign(duration, { type: 'text', inputMode: 'decimal', value: '0.5', required: true });
  meta.append(labelled('Test nomi', title), labelled('Davomiylik (soat)', duration));
  const nav = document.createElement('div');
  nav.className = 'line-form editor-nav';
  nav.append(labelled('Savol', item('select', 'editor-question')),
    action('add-question', 'Savol qo‘shish'), action('remove-question', 'Savolni o‘chirish'));
  const buttons = document.createElement('div');
  buttons.className = 'editor-actions actions';
  const save = action('save-editor', 'Test qoralamasini saqlash', 'submit');
  save.className = 'primary';
  buttons.append(action('student-preview', 'O‘quvchi ko‘rinishi'), save, action('new-editor', 'Yangidan boshlash'));
  const hint = node('p', 'PNG uchun 2 MiB, SVG uchun 256 KiB gacha rasm yuklashingiz mumkin.');
  hint.className = 'hint';
  const fields = item('fieldset', 'editor-controls');
  fields.setAttribute('aria-label', 'Test mazmuni');
  fields.append(meta, nav, hint, item('div', 'question-fields'));
  const restore = item('div', 'restore-banner');
  restore.hidden = true;
  restore.setAttribute('role', 'alert');
  const status = item('p', 'autosave-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  form.append(restore, fields, status, buttons);
  root.replaceChildren(form);
}

// The host supplies the official block renderer, scoped media upload and a QuestionWrite draft saver.
export function mountTeacherEditor(root, {renderBlocks, mountVisualFormula, uploadImage, readDraft, saveDraft, onTargetChange, onNewTest, previewStudent, notify: notice, drafts = null, autosaveMs = 1000}) {
  makeLayout(root);
  const el = id => root.querySelector('#' + id);
  let questions = [newQuestion()];
  let current = 0;
  const uploads = new Set();
  let dirty = false, busy = false, disposed = false;
  let target = null;
  let metadata = {}, originalSeconds = 1800;

  // Browser safety copy. One slot per saved draft id, plus 'new' for a test not yet on the server.
  const doc = root.ownerDocument, win = doc.defaultView;
  const store = drafts?.available ? drafts : null;
  let slot = 'new', timer = null, waitingForChoice = false;
  const clock = () => { const now = new Date(); return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'); };
  function say(text) { if (!disposed) el('autosave-status').textContent = text; }
  const snapshot = () => ({
    title: el('editor-title').value, durationText: el('editor-duration').value, originalSeconds,
    metadata: structuredClone(metadata), targetRevision: target?.revision ?? null, questions: structuredClone(questions),
  });
  function flush() {
    if (timer !== null) { win.clearTimeout(timer); timer = null; }
    if (!store || !dirty || waitingForChoice) return;
    say(store.write(slot, snapshot()) ? 'Brauzerda saqlandi, soat ' + clock() + '.' :
      'Brauzer xotirasiga saqlab bo‘lmadi. Qoralamani serverga saqlang.');
  }
  function schedule() {
    if (!store) return;
    if (waitingForChoice) { say('Avval topilgan saqlangan nusxa haqida qaror qiling.'); return; }
    if (timer === null) { say('Saqlanmoqda…'); timer = win.setTimeout(flush, autosaveMs); }
  }
  function discardCopy() {
    if (timer !== null) { win.clearTimeout(timer); timer = null; }
    store?.remove(slot);
  }
  if (!store) say('Brauzer xotirasi yopiq: yozganlaringiz o‘zi saqlanmaydi. Qoralamani tez-tez serverga saqlang.');
  const unregister = store?.onFlush(flush);
  const hiddenFlush = () => { if (doc.visibilityState === 'hidden') flush(); };
  const otherWindow = event => {
    if (store && event.key === store.key(slot) && event.newValue !== null) {
      say('Bu test boshqa oynada ham tahrirlanmoqda. Faqat bitta oynada ishlang, aks holda o‘zgarishlar bir-birini ezadi.');
    }
  };
  if (store) {
    doc.addEventListener('visibilitychange', hiddenFlush);
    win.addEventListener('pagehide', flush);
    win.addEventListener('storage', otherWindow);
  }

  function changed() {
    dirty = true;
    el('save-editor').disabled = busy;
    schedule();
  }
  function blockGroup(question, blocks, legend, option) {
    const group = document.createElement('fieldset');
    group.append(node('legend', legend));
    if (option) {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'answer-key';
      radio.value = option.id;
      radio.checked = question.correct_option_id === option.id;
      radio.onchange = () => { if (radio.checked) { question.correct_option_id = option.id; changed(); } };
      const label = labelled('To‘g‘ri javob', radio);
      label.className = 'correct-choice';
      group.append(label);
    }
    for (const [i, block] of blocks.entries()) {
      const row = document.createElement('div');
      row.className = 'block-row';
      let control;
      if (block.type === 'image') {
        const parts = document.createElement('div');
        const alt = document.createElement('input');
        alt.maxLength = 1000;
        alt.value = block.alt;
        alt.oninput = () => { block.alt = alt.value; changed(); };
        parts.append(labelled('Rasm tavsifi', alt));
        const box = document.createElement('div');
        box.className = 'preview-blocks';
        renderBlocks(box, [block]);
        parts.append(box);
        control = parts;
      } else if (block.type === 'formula') {
        control = document.createElement('div');
        control.className = 'formula-editor';
        mountVisualFormula(control, {
          value: block.latex, display: block.display, renderBlocks,
          onDisplayChange(value) { block.display = value; changed(); },
          onChange(value) { block.latex = value; changed(); },
        });
      } else {
        const input = document.createElement('textarea');
        input.maxLength = 20000;
        input.value = block.markdown;
        input.oninput = () => { block.markdown = input.value; changed(); };
        control = labelled('Matn', input);
      }
      row.append(control, button('Blokni olib tashlash', () => {
        blocks.splice(i, 1); changed(); drawEditor();
      }));
      group.append(row);
    }
    const tools = document.createElement('div');
    tools.className = 'block-tools';
    for (const [text, factory] of [
      ['Matn qo‘shish', () => ({ type: 'text', markdown: '' })],
      ['Formula qo‘shish', () => ({ type: 'formula', latex: '', display: 'block' })],
    ]) {
      tools.append(button(text, () => {
        blocks.push(factory()); changed(); drawEditor();
        const fields = [...el('question-fields').querySelectorAll('fieldset')].find(item => item.querySelector('legend')?.textContent === legend);
        [...(fields?.querySelectorAll('.block-row') ?? [])].at(-1)?.querySelector('textarea, input, select, button')?.focus();
      }));
    }
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/png,image/svg+xml,.png,.svg';
    file.onchange = async () => {
      const image = file.files[0];
      if (!image) return;
      const upload = {question};
      uploads.add(upload);
      changed();
      try {
        notice('Rasm yuklanmoqda…');
        const id = await uploadImage(image);
        if (disposed || !questions.includes(question)) return;
        blocks.push({ type: 'image', asset_id: id, alt: '' });
        changed();
        if (questions[current] === question) {
          drawEditor(); notice('Rasm yuklandi. Uning tavsifini yozing.');
        }
      } catch (error) { if (!disposed && questions[current] === question) notice('', error.message); }
      finally { uploads.delete(upload); }
    };
    const imageLabel = labelled('Rasm qo‘shish (PNG yoki SVG)', file);
    tools.append(imageLabel);
    group.append(tools);
    return group;
  }
  function drawEditor() {
    const question = questions[current];
    const options = questions.map((q, i) => new Option((i + 1) + '-savol', q.id));
    el('editor-question').replaceChildren(...options);
    el('editor-question').value = question.id;
    el('remove-question').disabled = questions.length === 1;
    el('add-question').disabled = questions.length >= 200;
    const fields = [];
    if (metadata.grading_config?.individual_enabled) {
      const points = document.createElement('input');
      points.id = 'question-points'; points.inputMode = 'decimal'; points.required = true;
      points.value = question.individual_points ?? '';
      points.oninput = () => { question.individual_points = points.value; changed(); };
      fields.push(labelled('Savol bali', points));
    }
    fields.push(blockGroup(question, question.prompt_blocks, 'Savol mazmuni'));
    for (const [i, option] of question.options.entries()) {
      fields.push(blockGroup(question, option.blocks, (i + 1) + '-javob', option));
    }
    fields.push(blockGroup(question, question.explanation_blocks, 'Yechim (ixtiyoriy)'));
    el('question-fields').replaceChildren(...fields);
  }
  function populated(blocks) {
    return blocks.filter(block => block.type === 'image' || (block.type === 'formula' ? block.latex : block.markdown).trim());
  }
  function buildDraft(requireKey) {
    const title = el('editor-title').value.trim();
    if (!title) { el('editor-title').focus(); throw Error('Test nomini kiriting.'); }
    const hours = el('editor-duration').value;
    const duration = hours === hoursFromSeconds(originalSeconds) ? originalSeconds : secondsFromHours(hours);
    if (duration === null) {
      el('editor-duration').focus(); throw Error('Davomiylikni soatda kiriting. Masalan, 0.5 yoki 1.5. Eng ko‘p davomiylik 24 soat.');
    }
    if ([...uploads].some(upload => questions.includes(upload.question))) throw Error('Rasm yuklanishini kuting.');
    const result = questions.map((question, i) => {
      const prompt = populated(question.prompt_blocks);
      const options = question.options.map(option => ({ ...option, blocks: populated(option.blocks) }));
      const explanation = populated(question.explanation_blocks);
      let issue = '';
      if (metadata.grading_config?.individual_enabled && (typeof question.individual_points !== 'string' ||
        !/^(?:0|[1-9][0-9]?)(?:\.[0-9]{1,3})?(?![\s\S])/.test(question.individual_points) ||
        Number(question.individual_points) <= 0 || Number(question.individual_points) > 30)) {
        issue = 'Savol balini 0 dan katta, 30 gacha, nuqtadan keyin ko‘pi bilan uchta raqam bilan kiriting.';
      } else if (!prompt.length) issue = 'Savol mazmunini kiriting.';
      else if (options.some(option => !option.blocks.length)) issue = 'To‘rtta variantning har biriga javob kiriting.';
      else if (requireKey && !options.some(option => option.id === question.correct_option_id)) issue = 'To‘g‘ri javobni belgilang.';
      else if ([...prompt, ...options.flatMap(option => option.blocks), ...explanation].some(block => block.type === 'image' && !block.alt.trim())) {
        issue = 'Har bir rasmning qisqa tavsifini kiriting.';
      }
      if (issue) { current = i; drawEditor(); throw Error((i + 1) + '-savol. ' + issue); }
      return { ...question, position: i + 1, prompt_blocks: prompt, options, explanation_blocks: explanation };
    });
    return { ...metadata, title, duration_seconds: duration, questions: result };
  }
  el('editor-question').onchange = event => {
    current = questions.findIndex(question => question.id === event.target.value);
    drawEditor(); notice();
  };
  el('add-question').onclick = () => {
    if (questions.length >= 200) return;
    questions.push(newQuestion());
    current = questions.length - 1;
    changed(); drawEditor(); notice();
  };
  el('remove-question').onclick = () => {
    if (questions.length < 2) return;
    questions.splice(current, 1);
    current = Math.min(current, questions.length - 1);
    changed(); drawEditor();
  };
  el('editor-title').oninput = changed;
  el('editor-duration').oninput = changed;
  el('student-preview').onclick = () => {
    try {
      const draft = buildDraft(false);
      void previewStudent(el('student-preview'), () => draft);
    } catch (error) { notice('', error.message); }
  };

  function syncControls() {
    const reload = target && target.revision === null;
    el('editor-controls').disabled = busy || Boolean(reload);
    el('editor-form').setAttribute('aria-busy', String(busy));
    el('save-editor').disabled = busy || Boolean(target && !reload && !dirty);
    el('new-editor').disabled = busy;
    el('student-preview').disabled = busy || Boolean(reload);
    el('save-editor').textContent = reload ? 'Saqlangan qoralamani qayta ochish' :
      target ? 'O‘zgarishlarni saqlash' : 'Test qoralamasini saqlash';
    onTargetChange(target?.id ?? null);
  }
  function replaceContent(preview, reference, index = 0) {
    metadata = {};
    el('restore-banner').hidden = true; el('restore-banner').replaceChildren(); waitingForChoice = false;
    if (preview.instructions_blocks) metadata.instructions_blocks = structuredClone(preview.instructions_blocks);
    if (preview.grading_config) metadata.grading_config = structuredClone(preview.grading_config);
    el('editor-title').value = preview.title;
    originalSeconds = preview.duration_seconds ?? 1800;
    el('editor-duration').value = hoursFromSeconds(originalSeconds);
    questions = preview.questions.map(source => {
      if (source.prompt_blocks) return structuredClone(source);
      const q = newQuestion();
      q.prompt_blocks[0].markdown = source.text;
      source.options.forEach((text, i) => { q.options[i].blocks[0].markdown = text; });
      q.correct_option_id = q.options[source.correctIndex].id;
      return q;
    });
    current = Math.min(index, questions.length - 1);
    target = reference;
    dirty = false;
    slot = reference?.id ?? 'new';
    drawEditor(); syncControls();
  }
  function canReplace() {
    if (busy) return false;
    if (!dirty) return true;
    if (!window.confirm('Muharrirdagi saqlanmagan o‘zgarishlarni bekor qilasizmi?')) return false;
    discardCopy();
    return true;
  }
  // A copy left by an earlier visit (closed tab, switched window, power cut) is offered back, never applied silently.
  function offerCopy() {
    const banner = el('restore-banner');
    banner.hidden = true; banner.replaceChildren(); waitingForChoice = false;
    const saved = store?.read(slot);
    if (!saved || !meaningful(saved) || dirty) return;
    waitingForChoice = true;
    const stale = target && saved.targetRevision !== target.revision;
    const when = new Date(saved.savedAt);
    const text = node('p', 'Brauzerda saqlangan, serverga yuborilmagan nusxa topildi (' +
      String(when.getDate()).padStart(2, '0') + '.' + String(when.getMonth() + 1).padStart(2, '0') + ' ' +
      String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0') + '). Davom ettirasizmi?' +
      (stale ? ' Diqqat: bu qoralama serverda keyin o‘zgargan, saqlashda to‘qnashuv chiqishi mumkin.' : ''));
    const done = () => { waitingForChoice = false; banner.hidden = true; banner.replaceChildren(); };
    banner.append(text,
      button('Davom ettirish', () => { done(); applyCopy(saved); }),
      button('O‘chirib tashlash', () => { store.remove(slot); done(); say(''); }));
    banner.hidden = false;
  }
  function applyCopy(saved) {
    metadata = saved.metadata;
    originalSeconds = saved.originalSeconds;
    el('editor-title').value = saved.title;
    el('editor-duration').value = saved.durationText;
    questions = saved.questions;
    current = 0;
    dirty = true;
    drawEditor(); syncControls();
    changed(); notice('Saqlangan nusxa tiklandi.');
  }
  async function loadCanonical(id, stillSelected, index) {
    const result = await readDraft(id);
    if (disposed || !stillSelected()) return false;
    replaceContent(result.draft, {id, revision: result.revision}, index);
    return true;
  }
  async function openSaved(id, stillSelected) {
    if (!canReplace()) return;
    busy = true; syncControls(); notice('Qoralama ochilmoqda…');
    let opened = false;
    try {
      opened = await loadCanonical(id, stillSelected, 0);
      if (opened) { notice('Qoralama tahrirlash uchun ochildi.'); offerCopy(); }
    } catch (error) { if (!disposed && stillSelected()) notice('', error.message); }
    finally { if (!disposed) { busy = false; syncControls(); } }
    if (opened && !disposed) el('editor-title').focus();
  }
  el('editor-form').onsubmit = async event => {
    event.preventDefault();
    if (busy || disposed || (target && target.revision !== null && !dirty)) return;
    busy = true; syncControls();
    try {
      const creating = !target;
      if (creating || target.revision !== null) {
        const receipt = await saveDraft(buildDraft(true), target);
        if (!receipt || disposed) return;
        if (typeof receipt.id !== 'string' || !receipt.id || (!creating && (receipt.id !== target.id ||
          !Number.isSafeInteger(receipt.revision) || receipt.revision <= target.revision))) throw Error('Qoralama versiyasini tekshirib bo‘lmadi.');
        // Import generates canonical question and option IDs. Bind the acknowledged
        // test immediately so even a failed follow-up read cannot create a duplicate.
        target = {id:receipt.id, revision: creating ? null : receipt.revision};
        dirty = false;
        // The server now holds this version, so the browser copy of it is no longer needed.
        discardCopy(); slot = receipt.id; say('Serverga saqlandi.');
      }
      if (target.revision === null && await loadCanonical(target.id, () => true, current)) notice('Test qoralamasi saqlandi.');
    } catch (error) {
      if (!disposed) notice('', target?.revision === null ? 'Qoralama saqlangan. Davom etish uchun uni qayta oching.' : error.message);
    } finally { if (!disposed) { busy = false; syncControls(); } }
  };
  function reset() {
    replaceContent({title:'', duration_seconds:1800, questions:[newQuestion()]}, null);
  }
  function newTest() {
    if (!canReplace()) return false;
    discardCopy();
    reset(); onNewTest(); el('editor-title').focus(); notice();
    return true;
  }
  el('new-editor').onclick = newTest;
  function openFile(preview) {
    if (!canReplace()) return;
    replaceContent(preview, null);
    changed(); el('editor-title').focus(); notice('Fayldagi savollar muharrirga olindi.');
  }
  drawEditor();
  offerCopy();
  return {
    openFile, openSaved, newTest,
    readyToPublish(id) { return !busy && (target?.id !== id || !dirty); },
    published(id) { if (target?.id === id) { discardCopy(); reset(); } },
    dispose() {
      flush();
      disposed = true;
      unregister?.();
      doc.removeEventListener('visibilitychange', hiddenFlush);
      win.removeEventListener('pagehide', flush);
      win.removeEventListener('storage', otherWindow);
    },
  };
}
