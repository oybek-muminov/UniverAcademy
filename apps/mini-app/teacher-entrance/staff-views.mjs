import template from '../../teacher-web/src/workspace.html?raw';
import sampleText from '../../teacher-web/local-pilot/sample.txt?url&no-inline';
import sampleJson from '../../teacher-web/local-pilot/sample.json?url&no-inline';
import { groupStatusLabel, mountTeacherWorkspace } from '../../teacher-web/src/workspace.mjs';
import { mountTeacherEditor, showStudentView } from '../../teacher-web/local-pilot/rich-editor.mjs';
import { mountVisualFormula } from '../../teacher-web/local-pilot/visual-formula.mjs';
import { renderBlocks } from '../src/rich-blocks.mjs';
import { uuid } from './staff-transport.mjs';
import '../src/rich-blocks.css';
import '../../teacher-web/local-pilot/styles.css';

import { alternateCabinet, button } from './staff-workspace.mjs';

function checkedInvite(data) {
  const link = new URL(data.telegramUrl);
  if (link.origin !== 'https://t.me' || link.username || link.password || !/^\/[a-zA-Z0-9_]{5,32}$/.test(link.pathname) ||
      link.hash || [...link.searchParams.keys()].join(',') !== 'start' || !/^[A-Za-z0-9_-]{1,64}$/.test(link.searchParams.get('start') ?? '')) {
    throw Error('Bot havolasi yaroqsiz.');
  }
  return {telegramUrl:link.href, openUrl:link.href, label:'Telegram botni ochish', note:'Havolani guruhga qo‘shiladigan o‘quvchiga yuboring.'};
}
export function teacherView(host, port, first, lifecycle) {
  const doc = host.ownerDocument;
  // Compiled, static cabinet markup; all subsequent domain values are text nodes.
  const fragment = doc.createElement('template');
  fragment.innerHTML = template;
  host.replaceChildren(fragment.content.cloneNode(true));
  const actionBar = host.querySelector('#workspace-actions');
  actionBar.append(alternateCabinet(doc, 'teacher'), button(doc, 'Chiqish', lifecycle.signout));
  for (const [ext, url] of [['txt',sampleText], ['json',sampleJson]]) host.querySelector('a[href="./sample.' + ext + '"]').href = url;
  host.querySelector('.skip').onclick = event => {event.preventDefault(); host.querySelector('#main').focus();};
  const loading = new Map();
  function privateBlocks(container, blocks, previewSignal) {
    renderBlocks(container, blocks, {
      signal:previewSignal ?? lifecycle.signal, loadKatex:() => import('katex'),
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

export function adminView(host, initial, lifecycle) {
  const doc = host.ownerDocument;
  const main = doc.createElement('section');
  main.className = 'card';
  const title = doc.createElement('h1'); title.textContent = 'Admin kabineti';
  const groupsTitle = doc.createElement('h2'); groupsTitle.textContent = 'Guruhlar';
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
  main.append(title, groupsTitle, refresh, rows, notice, alternateCabinet(doc, 'admin'),
    button(doc,'Chiqish',lifecycle.signout));
  host.replaceChildren(main);
  paint(initial);
  return () => {};
}
