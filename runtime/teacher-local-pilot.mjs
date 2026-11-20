import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { parseTeacherTestText } from './teacher-pilot-text-import.mjs';
import { imageLimits, privatePng } from './teacher-local-ui/private-image.mjs';
import { createTeacherPilot } from './teacher-pilot-domain.mjs';
import { teacherPilotBotLinks, teacherPilotBotStart } from '../apps/telegram-bot/src/teacher-pilot-invite.mjs';

const staticRoutes = new Map([
  ['/teacher/workspace.mjs', '../apps/teacher-web/src/workspace.mjs'],
  ['/', './teacher-local-ui/index.html'],
  ['/admin/', './teacher-local-ui/admin.html'],
  ['/admin/admin.mjs', './teacher-local-ui/admin.mjs'],
  ['/bot/', './teacher-local-ui/bot.html'],
  ['/bot/bot.mjs', './teacher-local-ui/bot.mjs'],
  ['/pilot/rich-blocks.css', '../apps/mini-app/src/rich-blocks.css'],
  ['/pilot/rich-blocks.mjs', '../apps/mini-app/src/rich-blocks.mjs'],
  ['/pilot/blocks.mjs', '../apps/mini-app/local-teacher-pilot/blocks.mjs'],
  ['/pilot/vendor/katex.mjs', './teacher-local-ui/node_modules/katex/dist/katex.mjs'],
  ['/pilot/vendor/katex.min.css', './teacher-local-ui/node_modules/katex/dist/katex.min.css'],
  ['/pilot.css', './teacher-local-ui/style.css'],
  ['/teacher/', '../apps/teacher-web/local-pilot/index.html'],
  ['/student/', '../apps/mini-app/local-teacher-pilot/index.html'],
]);
for (const file of ['teacher.mjs', 'rich-editor.mjs', 'visual-formula.mjs', 'styles.css', 'sample.json', 'sample.txt']) {
  staticRoutes.set('/teacher/' + file, '../apps/teacher-web/local-pilot/' + file);
}
for (const file of ['student.mjs', 'styles.css']) {
  staticRoutes.set('/student/' + file, '../apps/mini-app/local-teacher-pilot/' + file);
}
const mediaTypes = { html: 'text/html', mjs: 'text/javascript', css: 'text/css', json: 'application/json', txt: 'text/plain' };
const actors = { teacher: ['teacher', 'teacher2'], student: ['student1', 'student2'], admin: ['admin'] };
const actions = {
  teacher: new Set(['createGroup', 'addMember', 'createInvite', 'sendInvite', 'previewTest', 'importTest', 'publishTest', 'assignTest']),
  admin: new Set(['approveGroup']),
  student: new Set(['acceptInvite', 'startAttempt', 'resumeAttempt', 'saveAnswer', 'submitAttempt']),
};
const maxBytes = 512 * 1024;

function fault(status, code) {
  return Object.assign(new Error(code), { status, code });
}
async function boundedBytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw fault(413, 'FILE_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw fault(413, 'FILE_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw fault(415, 'JSON_REQUIRED');
  }
  const bytes = await boundedBytes(req, maxBytes);
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw Error();
    return body;
  } catch {
    throw fault(400, 'INVALID_JSON');
  }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function localOrigin(req) {
  const peer = req.socket.remoteAddress;
  const localPeers = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const allowedHosts = ['127.0.0.1', 'localhost', '[::1]'].map(host => host + ':' + req.socket.localPort);
  if (!localPeers.includes(peer) || !allowedHosts.includes(req.headers.host)) throw fault(403, 'LOOPBACK_ONLY');
  const origin = 'http://' + req.headers.host;
  if (req.headers.origin && req.headers.origin !== origin) throw fault(403, 'ORIGIN_DENIED');
  return origin;
}
function cookieValue(req, role) {
  return (req.headers.cookie ?? '').split(/;\s*/).find(part => part.startsWith('ua_demo_' + role + '='))?.split('=')[1];
}

// Separate process and URL namespace for a local rehearsal. Production never imports this module.
export function createTeacherPilotServer(options = {}) {
  const pilot = createTeacherPilot(options);
  const sessions = new Map();
  const images = new Map();
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const origin = localOrigin(req);
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw fault(400, 'BAD_PATH');
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw fault(400, 'BAD_PATH');
      const font = /^\/pilot\/vendor\/fonts\/(KaTeX_[A-Za-z0-9-]+\.(woff2?|ttf))$/.exec(url.pathname);
      if (req.method === 'GET' && font) {
        let bytes;
        try { bytes = await readFile(new URL('./teacher-local-ui/node_modules/katex/dist/fonts/' + font[1], import.meta.url)); }
        catch { throw fault(404, 'NOT_FOUND'); }
        res.writeHead(200, { 'Content-Type':'font/' + font[2] }); return res.end(bytes);
      }
      if (req.method === 'GET' && staticRoutes.has(url.pathname)) {
        const file = staticRoutes.get(url.pathname);
        let bytes = await readFile(new URL(file, import.meta.url));
        if (url.pathname === '/teacher/') {
          const workspace = await readFile(new URL('../apps/teacher-web/src/workspace.html', import.meta.url), 'utf8');
          bytes = bytes.toString('utf8').replace('<!--teacher-workspace-->', workspace);
        }
        res.writeHead(200, { 'Content-Type': mediaTypes[file.split('.').at(-1)] + '; charset=utf-8' });
        return res.end(bytes);
      }
      if (req.method === 'POST' && url.pathname === '/local-pilot/bot/start') {
        const { command } = await jsonBody(req);
        const result = teacherPilotBotStart(command);
        if (!result) throw fault(400, 'INVALID_INVITE_COMMAND');
        return json(res, 200, { data: result });
      }
      const media = /^\/local-pilot\/(teacher|student)\/media(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
      if (media) {
        const [,role,id] = media;
        const session = sessions.get(cookieValue(req,role));
        if (session?.role !== role) throw fault(401,'DEMO_SESSION_REQUIRED');
        if (req.method === 'POST' && role === 'teacher' && !id) {
          const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (!Object.hasOwn(imageLimits,type)) throw fault(415,'IMAGE_TYPE_REQUIRED');
          const png = await privatePng(await boundedBytes(req,imageLimits[type]),type);
          const asset = { id:randomUUID(),contentType:'image/png' };
          await pilot.registerMedia(session.actor,asset);
          images.set(asset.id,png);
          return json(res,200,{ data:asset });
        }
        if (req.method === 'GET' && id && await pilot.canReadMedia(session.actor,id) && images.has(id)) {
          res.writeHead(200,{ 'Content-Type':'image/png','X-Content-Type-Options':'nosniff' });
          return res.end(images.get(id));
        }
        throw fault(404,'NOT_FOUND');
      }
      const match = /^\/local-pilot\/(teacher|student|admin)\/(dashboard|session|import-preview|commands\/([a-zA-Z]+))$/.exec(url.pathname);
      if (!match) throw fault(404, 'NOT_FOUND');
      const [, role, operation, action] = match;
      const token = cookieValue(req, role);
      if (req.method === 'POST' && operation === 'session') {
        const { actor } = await jsonBody(req);
        if (!actors[role].includes(actor)) throw fault(403, 'DEMO_ROLE_DENIED');
        const sessionId = randomBytes(24).toString('base64url');
        if (token) sessions.delete(token);
        sessions.set(sessionId, { actor, role });
        res.setHeader('Set-Cookie', 'ua_demo_' + role + '=' + sessionId + '; Path=/local-pilot/' + role + '; HttpOnly; SameSite=Strict');
        return json(res, 200, { data: { actor, role } });
      }
      const session = sessions.get(token);
      if (!session || session.role !== role) throw fault(401, 'DEMO_SESSION_REQUIRED');
      if (req.method === 'POST' && operation === 'import-preview') {
        if (role !== 'teacher') throw fault(403, 'FORBIDDEN');
        return json(res, 200, { data: parseTeacherTestText((await jsonBody(req)).text) });
      }
      if (req.method === 'GET' && operation === 'dashboard') {
        return json(res, 200, { data: await pilot.read(session.actor) });
      }
      if (req.method !== 'POST' || !action) throw fault(405, 'METHOD_NOT_ALLOWED');
      if (!actions[role].has(action)) throw fault(403, 'FORBIDDEN');
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw fault(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const input = await jsonBody(req);
      let data = await pilot.command(session.actor, action, input, key);
      if (action === 'createInvite' || action === 'sendInvite') data = { ...data, ...teacherPilotBotLinks(data.token) };
      return json(res, 200, { data });
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      const code = status < 500 && typeof error.code === 'string' ? error.code : 'PILOT_UNAVAILABLE';
      // Only domain-supplied validation details intended for the upload form may leave the server.
      const detail = typeof error.detail === 'string' && status === 422 ? error.detail.slice(0, 260) : code;
      if (!res.headersSent) json(res, status, { error: { code, message: detail } });
      else res.end();
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4178);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('PORT 0–65535 oralig‘ida bo‘lishi kerak');
  const server = createTeacherPilotServer();
  server.on('error', error => { console.error('Mahalliy pilot ochilmadi:', error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log('UniverAcademy mahalliy piloti: http://127.0.0.1:' + server.address().port + '/');
  });
}
