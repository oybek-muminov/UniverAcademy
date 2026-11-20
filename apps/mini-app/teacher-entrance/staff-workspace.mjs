import template from '../../teacher-web/src/workspace.html?raw';
import sampleText from '../../teacher-web/local-pilot/sample.txt?url&no-inline';
import sampleJson from '../../teacher-web/local-pilot/sample.json?url&no-inline';
import { groupStatusLabel, mountTeacherWorkspace } from '../../teacher-web/src/workspace.mjs';
import { mountTeacherEditor, showStudentView } from '../../teacher-web/local-pilot/rich-editor.mjs';
import { mountVisualFormula } from '../../teacher-web/local-pilot/visual-formula.mjs';
import { renderBlocks } from '../src/rich-blocks.mjs';
import { createStaffTransport, uuid } from './staff-transport.mjs';
import '../src/rich-blocks.css';
import '../../teacher-web/local-pilot/styles.css';

function button(doc, name, click) {
  const node = doc.createElement('button');
  node.type = 'button';
  node.textContent = name;
  node.onclick = click;
  return node;
}
function checkedInvite(data) {
  const link = new URL(data.telegramUrl);
  if (link.origin !== 'https://t.me' || link.username || link.password || !/^\/[a-zA-Z0-9_]{5,32}$/.test(link.pathname) ||
      link.hash || [...link.searchParams.keys()].join(',') !== 'start' || !/^[A-Za-z0-9_-]{1,64}$/.test(link.searchParams.get('start') ?? '')) {
    throw Error('Bot havolasi yaroqsiz.');
  }
  return {telegramUrl:link.href, openUrl:link.href, label:'Telegram botni ochish', note:'Havolani guruhga qo‘shiladigan o‘quvchiga yuboring.'};
}
function teacherView(host, port, first, lifecycle) {
  const doc = host.ownerDocument;
  // Compiled, static cabinet markup; all subsequent domain values are text nodes.
  const fragment = doc.createElement('template');
  fragment.innerHTML = template;
  host.replaceChildren(fragment.content.cloneNode(true));
  const actionBar = host.querySelector('#workspace-actions');
  actionBar.append(button(doc, 'Admin bo‘limi', lifecycle.admin), button(doc, 'Chiqish', lifecycle.signout));
  for (const [ext, url] of [['txt',sampleText], ['json',sampleJson]]) host.querySelector('a[href="./sample.' + ext + '"]').href = url;
  host.querySelector('.skip').onclick = event => {event.preventDefault(); host.querySelector('#main').focus();};
  const loading = new Map();
  function privateBlocks(container, blocks) {
    renderBlocks(container, blocks, {
      signal:lifecycle.signal, loadKatex:() => import('katex'),
      loadAsset(block) {
        // The server rechecks scope. Never send a bearer to a URL embedded in authored content.
        const id = block.asset?.asset_id ?? block.asset_id;
        if (!uuid(id)) throw Error('Rasm topilmadi.');
        if (!loading.has(id)) loading.set(id, port.image(id).finally(() => loading.delete(id)));
        return loading.get(id);
      },
    });
  }
  const unmount = mountTeacherWorkspace(host, {
    readDashboard() {
      if (first) { const value = first; first = null; return value; }
      return lifecycle.dashboard();
    },
    readAvailableStudents:port.availableStudents, request:port.request, upload:port.upload, renderBlocks:privateBlocks, mountTeacherEditor, showStudentView, mountVisualFormula,
    sentMessage:'Taklif Telegram orqali yetkazish navbatiga qo‘yildi.', inviteLink:checkedInvite,
  });
  return unmount;
}

function adminView(host, initial, lifecycle) {
  const doc = host.ownerDocument;
  const main = doc.createElement('section');
  main.className = 'card';
  const title = doc.createElement('h1'); title.textContent = 'Guruhlar';
  const rows = doc.createElement('ul');
  const notice = doc.createElement('p'); notice.setAttribute('role','status');
  function paint(dashboard) {
    rows.replaceChildren(...dashboard.groups.map(group => {
      const row = doc.createElement('li');
      row.textContent = [group.name, group.teacherName, groupStatusLabel(group.status)].filter(Boolean).join(' · ');
      return row;
    }));
    notice.textContent = dashboard.groups.length ? '' : 'Guruhlar yo‘q.';
  }
  const refresh = button(doc, 'Yangilash', async () => {
    refresh.disabled = true;
    try {
      const data = await lifecycle.dashboard();
      if (!lifecycle.signal.aborted) paint(data);
    } catch (error) {
      if (!lifecycle.signal.aborted) notice.textContent = error.message;
    } finally { refresh.disabled = false; }
  });
  main.append(title, refresh, rows, notice, button(doc,'O‘qituvchi kabineti',lifecycle.teacher),
    button(doc,'Chiqish',lifecycle.signout));
  host.replaceChildren(main);
  paint(initial);
  return () => {};
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
      const data = await dashboard();
      if (signal.aborted || !sameIdentity()) return;
      const lifecycle = {signal, dashboard, signout, teacher:() => open('teacher'), admin:() => open('admin')};
      cleanup = nextRole === 'teacher' ? teacherView(host, port, data, lifecycle) : adminView(host, data, lifecycle);
    } catch {
      if (!signal.aborted) { clear(); panel('Kabinetni yuklab bo‘lmadi.', [button(doc, 'Qayta urinish', () => open(nextRole))]); }
    }
  }
  const unsubscribe = options.identity.subscribe(() => { clear(); if (sameIdentity()) void open(); });
  const resume = () => { if (doc.visibilityState !== 'hidden') void open(); else clear(); };
  const pageshow = event => { if (event.persisted) resume(); };
  win.addEventListener('pagehide', clear); win.addEventListener('pageshow', pageshow);
  doc.addEventListener('visibilitychange', resume);
  void open();
  return () => {
    disposed = true; clear(); unsubscribe();
    win.removeEventListener('pagehide', clear); win.removeEventListener('pageshow', pageshow);
    doc.removeEventListener('visibilitychange', resume);
  };
}
