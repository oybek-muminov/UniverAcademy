import { createStaffTransport, uuid } from './staff-transport.mjs';

export function button(doc, name, click) {
  const node = doc.createElement('button');
  node.type = 'button';
  node.textContent = name;
  node.onclick = click;
  return node;
}
export function mountAuthenticatedWorkspace(host, options) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const expected = options.identity.current();
  let role = 'teacher', boundPerson = null, controller, cleanup, disposed = false;
  function sameIdentity() {
    const now = options.identity.current();
    return expected && now && now.userId === expected.userId && now.generation === expected.generation;
  }
  function clear() {
    controller?.abort(); controller = null;
    cleanup?.(); cleanup = null;
    host.replaceChildren();
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
  async function open(nextRole = role) {
    clear(); role = nextRole;
    if (disposed || !sameIdentity() || doc.visibilityState === 'hidden') return;
    controller = new AbortController();
    const { signal } = controller;
    panel('Ruxsat tekshirilmoqda…');
    function denied(status) {
      if (signal.aborted) return;
      clear();
      const actions = [button(doc, 'Qayta tekshirish', () => open(nextRole)), button(doc,'Chiqish',signout)];
      if (status === 403) actions.unshift(button(doc, nextRole === 'teacher' ? 'Admin bo‘limi' : 'O‘qituvchi kabineti',
        () => open(nextRole === 'teacher' ? 'admin' : 'teacher')));
      panel(status === 403 ? 'Bu bo‘lim uchun ruxsat berilmagan.' : 'Kirish sessiyasini tekshiring.', actions);
    }
    const port = createStaffTransport({...options, role:nextRole, signal, expected, onDenied:denied});
    async function dashboard() {
      const data = await port.request('dashboard');
      if (signal.aborted || !sameIdentity()) throw Error('Sessiya o‘zgardi.');
      if (data?.role !== nextRole || !uuid(data.person_id) || boundPerson && data.person_id !== boundPerson ||
          !Array.isArray(data.groups) || nextRole === 'teacher' && !['subjects','tests','assignments','results'].every(key => Array.isArray(data[key]))) {
        denied(403); throw Error('Kabinetni tasdiqlab bo‘lmadi.');
      }
      boundPerson = data.person_id;
      return data;
    }
    try {
      const [data, views] = await Promise.all([dashboard(), import('./staff-views.mjs')]);
      if (signal.aborted || !sameIdentity()) return;
      const lifecycle = {signal, dashboard, signout, teacher:() => open('teacher'), admin:() => open('admin')};
      cleanup = nextRole === 'teacher' ? views.teacherView(host, port, data, lifecycle) : views.adminView(host, data, lifecycle);
    } catch {
      if (!signal.aborted) { clear(); panel('Kabinetni yuklab bo‘lmadi.', [button(doc, 'Qayta urinish', () => open(nextRole))]); }
    }
  }
  const unsubscribe = options.identity.subscribe(() => { clear(); if (sameIdentity()) void open(); });
  let visibleRestore;
  const suspend = () => { visibleRestore = null; clear(); };
  const resume = () => {
    if (doc.visibilityState === 'hidden') suspend();
    else if (!controller) { void open(); visibleRestore = controller; }
  };
  const pageshow = event => {
    if (!event.persisted) return;
    if (doc.visibilityState === 'hidden') { suspend(); return; }
    // A standalone BFCache restore always revalidates. A paired visibility
    // event may already have started this exact authorization check.
    if (!controller || visibleRestore !== controller) void open();
    visibleRestore = null;
  };
  win.addEventListener('pagehide', suspend); win.addEventListener('pageshow', pageshow);
  doc.addEventListener('visibilitychange', resume);
  void open();
  return () => {
    disposed = true; clear(); unsubscribe();
    win.removeEventListener('pagehide', suspend); win.removeEventListener('pageshow', pageshow);
    doc.removeEventListener('visibilitychange', resume);
  };
}
