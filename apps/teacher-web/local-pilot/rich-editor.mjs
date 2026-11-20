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
export function showStudentView(box, draft, renderBlocks) {
  box.replaceChildren(node('h3', 'O‘quvchi ko‘rinishi · ' + draft.title));
  for (const [index, question] of draft.questions.entries()) {
    const field = document.createElement('fieldset');
    field.append(node('legend', (index + 1) + '-savol'));
    const content = document.createElement('div');
    content.className = 'preview-blocks';
    renderBlocks(content, question.prompt_blocks);
    field.append(content);
    for (const [i, option] of question.options.entries()) {
      const label = document.createElement('label');
      label.className = 'preview-option';
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = box.id + '-' + question.id;
      const answer = node('span', 'ABCD'[i] + '. ');
      const blocks = document.createElement('span');
      blocks.className = 'preview-blocks';
      renderBlocks(blocks, option.blocks);
      label.append(radio, answer, blocks);
      field.append(label);
    }
    box.append(field);
  }
  box.hidden = false;
  box.tabIndex = -1;
  box.focus();
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
  Object.assign(duration, { type: 'number', min: '1', max: '86400', value: '1800', required: true });
  meta.append(labelled('Test nomi', title), labelled('Vaqt (soniya)', duration));
  const nav = document.createElement('div');
  nav.className = 'line-form editor-nav';
  nav.append(labelled('Savol', item('select', 'editor-question')),
    action('add-question', 'Savol qo‘shish'), action('remove-question', 'Savolni o‘chirish'));
  const buttons = document.createElement('div');
  buttons.className = 'editor-actions actions';
  const save = action('save-editor', 'Test qoralamasini saqlash', 'submit');
  save.className = 'primary';
  buttons.append(action('student-preview', 'O‘quvchi ko‘rinishi'), save);
  const hint = node('p', 'PNG uchun 2 MiB, SVG uchun 256 KiB gacha rasm yuklashingiz mumkin.');
  hint.className = 'hint';
  form.append(meta, nav, hint, item('div', 'question-fields'), buttons);
  const preview = item('section', 'editor-preview');
  preview.setAttribute('aria-label', 'O‘quvchi ko‘rinishi');
  preview.hidden = true;
  root.replaceChildren(form, preview);
}

// The host supplies the official block renderer, scoped media upload and a QuestionWrite draft saver.
// Return true from saveDraft only after the write is acknowledged; preserve input on failed saves.
export function mountTeacherEditor(root, {renderBlocks, mountVisualFormula, uploadImage, saveDraft, notify: notice}) {
  makeLayout(root);
  const el = id => root.querySelector('#' + id);
  let questions = [newQuestion()];
  let current = 0;
  let mediaPending = 0;
  let edits = 0;
  let metadata = {};

  function hideStudentPreview() {
    el('editor-preview').hidden = true;
    el('editor-preview').replaceChildren();
  }
  function changed() {
    edits++;
    hideStudentPreview();
  }
  function blockGroup(blocks, legend, option) {
    const group = document.createElement('fieldset');
    group.append(node('legend', legend));
    if (option) {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'answer-key';
      radio.checked = questions[current].correct_option_id === option.id;
      radio.onchange = () => { questions[current].correct_option_id = option.id; changed(); };
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
      mediaPending++;
      try {
        notice('Rasm yuklanmoqda…');
        const id = await uploadImage(image);
        blocks.push({ type: 'image', asset_id: id, alt: '' });
        changed(); drawEditor(); notice('Rasm yuklandi. Uning tavsifini yozing.');
      } catch (error) { notice('', error.message); }
      finally { mediaPending--; }
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
    const fields = [blockGroup(question.prompt_blocks, 'Savol mazmuni')];
    for (const [i, option] of question.options.entries()) {
      fields.push(blockGroup(option.blocks, 'ABCD'[i] + ' varianti', option));
    }
    el('question-fields').replaceChildren(...fields);
  }
  function populated(blocks) {
    return blocks.filter(block => block.type === 'image' || (block.type === 'formula' ? block.latex : block.markdown).trim());
  }
  function buildDraft(requireKey) {
    const title = el('editor-title').value.trim();
    if (!title) { el('editor-title').focus(); throw Error('Test nomini kiriting.'); }
    const duration = el('editor-duration').valueAsNumber;
    if (!Number.isInteger(duration) || duration < 1 || duration > 86400) {
      el('editor-duration').focus(); throw Error('Vaqtni 1–86400 soniya oralig‘ida kiriting.');
    }
    if (mediaPending) throw Error('Rasm yuklanishini kuting.');
    const result = questions.map((question, i) => {
      const prompt = populated(question.prompt_blocks);
      const options = question.options.map(option => ({ ...option, blocks: populated(option.blocks) }));
      let issue = '';
      if (!prompt.length) issue = 'Savol mazmunini kiriting.';
      else if (options.some(option => !option.blocks.length)) issue = 'To‘rtta variantning har biriga javob kiriting.';
      else if (requireKey && !question.correct_option_id) issue = 'To‘g‘ri javobni belgilang.';
      else if ([...prompt, ...options.flatMap(option => option.blocks)].some(block => block.type === 'image' && !block.alt.trim())) {
        issue = 'Har bir rasmning qisqa tavsifini kiriting.';
      }
      if (issue) { current = i; drawEditor(); throw Error((i + 1) + '-savol. ' + issue); }
      return { ...question, position: i + 1, prompt_blocks: prompt, options };
    });
    return { ...metadata, title, duration_seconds: duration, questions: result };
  }
  el('editor-question').onchange = event => {
    current = questions.findIndex(question => question.id === event.target.value);
    drawEditor();
  };
  el('add-question').onclick = () => {
    if (questions.length >= 200) return;
    questions.push(newQuestion());
    current = questions.length - 1;
    changed(); drawEditor();
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
      showStudentView(el('editor-preview'), buildDraft(false), renderBlocks);
      notice('O‘quvchi ko‘rinishi ochildi.');
    } catch (error) { notice('', error.message); }
  };

  el('editor-form').onsubmit = async event => {
    event.preventDefault();
    const revision = edits;
    try {
      if (await saveDraft(buildDraft(true)) && revision === edits) {
        questions = [newQuestion()]; current = 0; edits = 0; metadata = {};
        el('editor-title').value = ''; el('editor-duration').value = '1800';
        hideStudentPreview(); drawEditor();
      }
    } catch (error) { notice('', error.message); }
  };
  function openFile(preview) {
    if (edits && !window.confirm('Muharrirdagi saqlanmagan test o‘rniga faylni ochasizmi?')) return;
    metadata = {};
    if (preview.instructions_blocks) metadata.instructions_blocks = structuredClone(preview.instructions_blocks);
    if (preview.grading_config) metadata.grading_config = structuredClone(preview.grading_config);
    el('editor-title').value = preview.title;
    el('editor-duration').value = String(preview.duration_seconds ?? 1800);
    questions = preview.questions.map(source => {
      if (source.prompt_blocks) return structuredClone(source);
      const q = newQuestion();
      q.prompt_blocks[0].markdown = source.text;
      source.options.forEach((text, i) => { q.options[i].blocks[0].markdown = text; });
      q.correct_option_id = q.options[source.correctIndex].id;
      return q;
    });
    current = 0;
    changed(); drawEditor(); el('editor-title').focus(); notice('Fayldagi savollar muharrirga olindi.');
  }
  drawEditor();
  return { openFile };
}
