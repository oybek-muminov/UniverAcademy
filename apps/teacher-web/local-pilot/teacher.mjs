import { mountVisualFormula } from './visual-formula.mjs';
import { mountTeacherEditor, showStudentView } from './rich-editor.mjs';
import { renderBlocks } from '/pilot/blocks.mjs';

import { mountTeacherWorkspace } from '/teacher/workspace.mjs';
const prefix = '/local-pilot/teacher/';
const maxBytes = 512 * 1024;
const messages = {
  RESOURCE_REVISION_CONFLICT: 'Qoralama boshqa oynada o‘zgargan. So‘nggi nusxani «Qoralamani tahrirlash» orqali qayta oching.',
  DEMO_TITLE_SHARED: 'Bu nom testning boshqa versiyasida ham ishlatiladi. Savollarni tahrirlab saqlash uchun avvalgi nomni qoldiring.',
  VERSION_FROZEN: 'Bu test nashr qilingan. Testlar ro‘yxatini yangilang.',
  FILE_TOO_LARGE: 'Fayl juda katta. Bitta yuklama uchun hajm chegarasi 512 KiB.',
  GROUP_MEMBERSHIP_CONFLICT: 'O‘quvchi boshqa faol guruhda. Guruhini almashtirish uchun Adminga murojaat qiling.',
  LOCAL_CHAT_UNAVAILABLE: 'O‘quvchi mahalliy botni hali ochmagan. Guruh taklif havolasini nusxalab ulashing.',
  EMPTY_GROUP: 'Avval guruhga kamida bitta o‘quvchi qo‘shing.',
  GROUP_PENDING: 'Guruh hozircha faol emas. Guruhlar ro‘yxatini yangilang.',
  TEST_NOT_PUBLISHED: 'Avval testni nashr qiling.',
  NOT_FOUND: 'Yozuv topilmadi. Tanlangan guruh, test yoki UniverAcademy ID raqamini tekshiring.',
  FORBIDDEN: 'Bu amal uchun ruxsat yo‘q.',
  INVALID_TEST_FILE: 'Test fayli namuna formatiga mos kelmadi.',
  IDEMPOTENCY_CONFLICT: 'Amal tasdiqlanmadi. Kabinetni yangilang va tanlovni tekshiring.',
  DEMO_SESSION_REQUIRED: 'Mahalliy sessiya tugagan. Kabinetni yangilang.',
};
async function request(path, body, key, signal) {
  const options = { signal, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    options.method = 'POST';
    options.body = JSON.stringify(body);
    if (new TextEncoder().encode(options.body).length > maxBytes) throw Error(messages.FILE_TOO_LARGE);
    options.headers = { 'Content-Type': 'application/json' };
    if (key) options.headers['Idempotency-Key'] = key;
  }
  let response, packet;
  try {
    response = await fetch(prefix + path, options);
    packet = await response.json();
  } catch {
    throw Object.assign(Error('Server javobi kelmadi. Ulanishni tekshirib, qayta urinib ko‘ring.'), { uncertain: true });
  }
  if (!response.ok || !Object.hasOwn(packet, 'data')) {
    const { code, message } = packet?.error ?? {};
    const detail = response.status === 422 && message && message !== code ? message : messages[code];
    throw Object.assign(Error(detail || 'Amal bajarilmadi. Kabinetni yangilab, qayta urinib ko‘ring.'), {
      status: response.status, uncertain: response.status >= 500 || response.ok,
    });
  }
  return packet.data;
}
async function upload(file) {
  const type = file.type || (/\.svg$/i.test(file.name) ? 'image/svg+xml' : /\.png$/i.test(file.name) ? 'image/png' : '');
  if (!['image/png', 'image/svg+xml'].includes(type)) throw Error('Rasm uchun PNG yoki SVG faylni tanlang.');
  if (file.size > (type === 'image/png' ? 2 * 1024 * 1024 : 256 * 1024)) throw Error('PNG fayl 2 MiB, SVG fayl 256 KiB doirasida bo‘lishi kerak.');
  const response = await fetch(prefix + 'media', { method: 'POST', body: file, headers: { 'Content-Type': type }, credentials: 'same-origin' });
  const packet = await response.json();
  if (!response.ok) throw Error(packet.error?.message && packet.error.message !== packet.error.code
    ? packet.error.message : 'Rasmni yuklab bo‘lmadi. Uning hajmi va PNG yoki SVG formatini tekshiring.');
  return packet.data.id;
}

function link(label, href) {
  const a = document.createElement('a');
  a.textContent = label; a.href = href; a.target = '_blank'; a.rel = 'noopener';
  return a;
}
document.getElementById('workspace-actions').textContent = 'Mahalliy sinov';
document.getElementById('workspace-links').append(link('Mahalliy Admin sahifasi', '/admin/'), link('Mahalliy o‘quvchi kabineti', '/student/'));
mountTeacherWorkspace(document, {
  mountTeacherEditor, showStudentView, mountVisualFormula, renderBlocks, upload, request, hashNavigation: true,
  readAvailableStudents(groupId, after, signal) {
    const path = 'groups/' + encodeURIComponent(groupId) + '/available-students' + (after === null ? '' : '?after=' + encodeURIComponent(after));
    return request(path, undefined, undefined, signal);
  },
  async readDashboard() {
    try { return await request('dashboard'); } catch (error) {
      if (error.status !== 401) throw error;
      await request('session', { actor: 'teacher' });
      return request('dashboard');
    }
  },
  sentMessage: 'Taklif o‘quvchining mahalliy bot xabarlariga yuborildi.',
  inviteLink(data) {
    const local = new URL(data.localBotUrl, location.origin);
    const telegram = new URL(data.telegramUrl);
    if (local.origin !== location.origin || local.pathname !== '/bot/' || telegram.origin !== 'https://t.me') throw Error('Taklif havolasi yaroqsiz.');
    return {telegramUrl: telegram.href, openUrl: local.href, label:'Taklifni mahalliy botda ochish',
      note:'Bu havolada mahalliy sinov kodi bor. Taklifni tekshirish uchun mahalliy bot oynasini oching.'};
  },
});
