import { createOwnerTransport, uuid } from './owner-transport.mjs';
import { ownerTitle } from './owner-route.mjs';

// The Owner's page. Every screen is rebuilt from a fresh server answer for exactly this signed-in session;
// a changed session, a denial or a wrong answer replaces the page with a closed notice.
export function mountOwnerCabinet(host, options) {
  const doc = host.ownerDocument, win = doc.defaultView;
  const expected = options.identity.current();
  let controller, boundPerson = null, disposed = false;
  const sameIdentity = () => {
    const now = options.identity.current();
    return expected && now && now.userId === expected.userId && now.generation === expected.generation;
  };
  const button = (name, click) => { const node = doc.createElement('button'); node.type = 'button'; node.textContent = name; node.onclick = click; return node; };
  function clear() { controller?.abort(); controller = null; host.replaceChildren(); }
  function panel(text, actions = []) {
    const section = doc.createElement('section'); section.className = 'status-card';
    const body = doc.createElement('p'); body.setAttribute('role', 'status'); body.textContent = text;
    section.append(body, ...actions); host.replaceChildren(section);
  }
  async function signout() {
    clear();
    try { if (sameIdentity()) await options.identity.signOut(expected); }
    catch { if (!disposed && sameIdentity()) panel('Chiqishni yakunlab bo‘lmadi.', [button('Qayta urinish', signout)]); }
  }
  async function open() {
    clear();
    if (disposed || !sameIdentity() || doc.visibilityState === 'hidden') return;
    controller = new AbortController();
    const { signal } = controller;
    panel('Ruxsat tekshirilmoqda…');
    const denied = status => {
      if (signal.aborted) return;
      clear();
      panel(status === 403 ? 'Bu kabinet faqat Ega uchun.' : 'Kirish sessiyasini tekshiring.', [button('Qayta tekshirish', open), button('Chiqish', signout)]);
    };
    const port = createOwnerTransport({ ...options, signal, expected, onDenied: denied });
    try {
      const data = await port.dashboard();
      if (signal.aborted || !sameIdentity()) return;
      if (data?.role !== 'owner' || !uuid(data.person_id) || boundPerson && data.person_id !== boundPerson || typeof data.name !== 'string' || !data.name.trim()) {
        denied(403); return;
      }
      boundPerson = data.person_id;
      const section = doc.createElement('section'); section.className = 'status-card';
      const title = doc.createElement('h1'); title.textContent = ownerTitle;
      const name = doc.createElement('p'); name.textContent = data.name;
      section.append(title, name, button('Chiqish', signout));
      host.replaceChildren(section);
    } catch { if (!signal.aborted) { clear(); panel('Kabinetni yuklab bo‘lmadi.', [button('Qayta urinish', open)]); } }
  }
  const unsubscribe = options.identity.subscribe(() => { clear(); if (sameIdentity()) void open(); });
  const resume = () => { if (doc.visibilityState !== 'hidden' && !controller) void open(); };
  doc.addEventListener('visibilitychange', resume);
  void open();
  return () => { disposed = true; clear(); unsubscribe(); doc.removeEventListener('visibilitychange', resume); };
}
