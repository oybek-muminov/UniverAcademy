function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, action, className = '') {
  const node = element('button', label, className); node.type = 'button'; node.addEventListener('click', action); return node;
}
export function renderCabinet(root, state, actions) {
  const focusKey = root.contains(document.activeElement) ? document.activeElement?.dataset.focusKey : null;
  root.replaceChildren();
  const frame = element('div', undefined, 'frame'); root.append(frame);
  const header = element('header', undefined, 'header');
  const brand = element('div'); brand.append(element('span', 'UniverAcademy', 'brand'), element('p', 'O‘qituvchi kabineti', 'eyebrow'));
  header.append(brand); frame.append(header);
  if (state.kind !== 'ready') {
    const panel = element('main', undefined, 'status-card');
    panel.setAttribute('aria-live', 'polite');
    const messages = {
      idle: ['Kabinet', 'Ma’lumotlar tekshirilmoqda.'],
      loading: ['Tekshirilmoqda', 'Hisob va o‘qituvchi huquqlari tekshirilmoqda.'],
      leaving: ['Kutilmoqda', 'Hisob amali bajarilmoqda.'],
      'signed-out': ['Hisobga kirish kerak', 'O‘qituvchi kabineti uchun mavjud hisobingiz bilan kiring.'],
      forbidden: ['O‘qituvchi huquqi berilmagan', 'O‘qituvchi lavozimini admin yoki ega tayinlaydi. O‘quvchi hisobingiz saqlanadi.'],
      unconfigured: ['Ulanish sozlanmagan', 'O‘qituvchi kabinetining server ulanishi hali sozlanmagan.'],
      error: ['Ma’lumotlarni olish imkoni bo‘lmadi', 'Qayta urinib ko‘ring. Oldingi hisob ma’lumotlari ko‘rsatilmaydi.'],
      student: ['O‘quvchi rejimi', 'O‘quvchi kabinetiga o‘tish bajarildi.']
    };
    const [title, description] = messages[state.kind] ?? messages.error;
    panel.append(element('h1', title), element('p', description));
    if (['error', 'signed-out', 'forbidden'].includes(state.kind)) panel.append(button('Qayta tekshirish', actions.refresh, 'primary'));
    frame.append(panel); return;
  }
  const account = element('div', undefined, 'account');
  account.append(element('span', state.name));
  if (typeof actions.student === 'function') account.append(button('O‘quvchi rejimi', actions.student));
  account.append(button('Chiqish', actions.signout)); header.append(account);
  const layout = element('div', undefined, 'layout'); frame.append(layout);
  const nav = element('nav'); nav.setAttribute('aria-label', 'Kabinet bo‘limlari');
  for (const [id, label] of [['overview', 'Umumiy'], ['groups', 'Guruhlar'], ['tests', 'Testlar']]) {
    const item = button(label, () => actions.select(id));
    item.dataset.focusKey = id;
    if (state.tab === id) item.setAttribute('aria-current', 'page'); nav.append(item);
  }
  layout.append(nav);
  const main = element('main'); layout.append(main);
  if (state.tab === 'overview') {
    main.append(element('p', 'O‘QITUVCHI', 'eyebrow'), element('h1', state.name));
    const subjects = element('section', undefined, 'card'); subjects.append(element('h2', 'Tasdiqlangan fanlar'));
    const tags = element('div', undefined, 'tags');
    state.subjects.forEach(name => tags.append(element('span', name, 'tag')));
    subjects.append(state.subjects.length ? tags : element('p', 'Hali fan biriktirilmagan.')); main.append(subjects);
    const stats = element('div', undefined, 'stats');
    for (const [label, count, tab] of [['Guruhlar', state.groups.length, 'groups'], ['Testlar', state.tests.length, 'tests']]) {
      const card = button('', () => actions.select(tab), 'stat'); card.append(element('span', label), element('strong', String(count))); stats.append(card);
    }
    main.append(stats);
  } else {
    const isGroups = state.tab === 'groups';
    main.append(element('h1', isGroups ? 'Guruhlar' : 'Testlar'));
    const list = isGroups ? state.groups : state.tests;
    const section = element('section', undefined, 'card');
    if (!list.length) section.append(element('p', isGroups ? 'Sizga hali guruh biriktirilmagan.' : 'Hali test mavjud emas.'));
    else {
      const ul = element('ul', undefined, 'rows');
      list.forEach(row => { const li = element('li'); li.append(element('span', row.title)); ul.append(li); }); section.append(ul);
    }
    main.append(section);
  }
  if (focusKey) root.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}
