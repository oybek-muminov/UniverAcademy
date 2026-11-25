import { staffDestination } from './staff-route.mjs';
import { createStaffTransport, uuid } from './staff-transport.mjs';

export function button(doc, name, click) {
  const node = doc.createElement('button');
  node.type = 'button';
  node.textContent = name;
  node.onclick = click;
  return node;
}
export function alternateCabinet(doc, role) {
  const link = doc.createElement('a');
  link.href = role === 'teacher' ? '/admin' : '/';
  link.textContent = role === 'teacher' ? 'Admin bo‘limi' : 'O‘qituvchi kabineti';
  return link;
}
export function mountAuthenticatedWorkspace(host, options) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const destination = staffDestination(win.location);
  if (!destination) {
    host.textContent = 'Kirish hozircha mavjud emas.';
    return () => {};
  }
  const {role} = destination;
  const expected = options.identity.current();
  let boundPerson = null, controller, cleanup, disposed = false;
  // `check` exists only while a verified cabinet is on screen; it re-reads the server's permission without touching the screen.
  let check = null, checking = false, note = null, slowTimer;
  function sameIdentity() {
    const now = options.identity.current();
    return expected && now && now.userId === expected.userId && now.generation === expected.generation;
  }
  function clear() {
    controller?.abort(); controller = null;
    check = null; checking = false; note = null; win.clearTimeout(slowTimer);
    cleanup?.(); cleanup = null;
    host.replaceChildren();
  }
  function notify(text, action) {
    if (!text) { note?.remove(); note = null; return; }
    if (!note) { note = doc.createElement('div'); note.className = 'session-note'; note.setAttribute('role', 'status'); }
    const message = doc.createElement('span'); message.textContent = text;
    note.replaceChildren(message, ...(action ? [action] : []));
    host.prepend(note);
  }
  // Returning to the tab: keep the page and any unsent typing, check permission quietly in the background.
  async function recheck() {
    const run = check, own = controller;
    if (!run || checking || disposed || !sameIdentity()) return;
    checking = true;
    win.clearTimeout(slowTimer);
    slowTimer = win.setTimeout(() => { if (check === run) notify('Ruxsat tekshirilmoqda…'); }, 400);
    try {
      await run();
      if (check === run && !own.signal.aborted) notify('');
    } catch {
      // A real denial already replaced the page through `denied`. Anything else is only a failed look-up.
      if (check === run && !own.signal.aborted) notify('Ruxsatni tekshirib bo‘lmadi. Yozganlaringiz saqlangan.', button(doc, 'Qayta tekshirish', () => void recheck()));
    } finally {
      if (check === run) { win.clearTimeout(slowTimer); checking = false; }
    }
  }
  function panel(text, actions = []) {
    const section = doc.createElement('section'); section.className = 'status-card';
    const body = doc.createElement('p'); body.setAttribute('role','status'); body.textContent = text;
    section.append(body, ...actions); host.replaceChildren(section);
  }
  async function signout() {
    clear();
    try { if (sameIdentity()) await options.identity.signOut(expected); }
    catch { if (!disposed && sameIdentity()) panel('Chiqishni yakunlab bo‘lmadi.', [button(doc, 'Qayta urinish', signout)]); }
  }
  async function open() {
    clear();
    if (disposed || !sameIdentity() || doc.visibilityState === 'hidden') return;
    controller = new AbortController();
    const { signal } = controller;
    panel('Ruxsat tekshirilmoqda…');
    function denied(status) {
      if (signal.aborted) return;
      clear();
      const actions = [button(doc, 'Qayta tekshirish', open), button(doc,'Chiqish',signout)];
      if (status === 403 && role !== 'owner') actions.unshift(alternateCabinet(doc, role));
      panel(status === 403 ? 'Bu bo‘lim uchun ruxsat berilmagan.' : 'Kirish sessiyasini tekshiring.', actions);
    }
    const port = createStaffTransport({...options, role, signal, expected, onDenied:denied});
    async function dashboard() {
      const data = await port.request('dashboard');
      if (signal.aborted || !sameIdentity()) throw Error('Sessiya o‘zgardi.');
      if (data?.role !== role || !uuid(data.person_id) || boundPerson && data.person_id !== boundPerson ||
          role === 'owner' && (typeof data.name !== 'string' || !data.name.trim()) ||
          role !== 'owner' && !Array.isArray(data.groups) || role === 'teacher' && !['subjects','tests','assignments','results'].every(key => Array.isArray(data[key]))) {
        denied(403); throw Error('Kabinetni tasdiqlab bo‘lmadi.');
      }
      boundPerson = data.person_id;
      return data;
    }
    const verify = async () => { await dashboard(); };
    try {
      const [data, views] = await Promise.all([dashboard(), role === 'owner' ? null : import('./staff-views.mjs')]);
      if (signal.aborted || !sameIdentity()) return;
      check = verify;
      if (role === 'owner') {
        const section = doc.createElement('section');
        section.className = 'status-card';
        const title = doc.createElement('h1'); title.textContent = destination.title;
        const name = doc.createElement('p'); name.textContent = data.name;
        section.append(title, name, button(doc, 'Chiqish', signout));
        host.replaceChildren(section);
      } else {
        const lifecycle = {signal, dashboard, signout};
        cleanup = role === 'teacher' ? views.teacherView(host, port, data, lifecycle) : views.adminView(host, data, lifecycle);
      }
    } catch {
      if (!signal.aborted) { clear(); panel('Kabinetni yuklab bo‘lmadi.', [button(doc, 'Qayta urinish', open)]); }
    }
  }
  const unsubscribe = options.identity.subscribe(() => { clear(); if (sameIdentity()) void open(); });
  // Leaving the tab never clears the cabinet: unsent typing must survive switching windows.
  const resume = () => {
    if (doc.visibilityState === 'hidden') return;
    if (!controller) void open(); else void recheck();
  };
  const pageshow = event => {
    if (!event.persisted || doc.visibilityState === 'hidden') return;
    if (!controller) void open(); else void recheck();
  };
  win.addEventListener('pageshow', pageshow);
  doc.addEventListener('visibilitychange', resume);
  void open();
  return () => {
    disposed = true; clear(); unsubscribe();
    win.removeEventListener('pageshow', pageshow);
    doc.removeEventListener('visibilitychange', resume);
  };
}
