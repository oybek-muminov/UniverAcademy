import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { StudentApp } from './student-app.tsx';
import { prepareTelegramEntry } from './production-runtime.ts';

type Runtime = ReturnType<typeof prepareTelegramEntry>;
function EntryCard({ notice, busy = false, retry }: { notice: string; busy?: boolean; retry?: () => void }) {
  return <main className="shell"><section className="card">
    <p className="eyebrow">UniverAcademy</p><h1>O‘quvchi kabineti</h1>
    <p role={busy ? 'status' : 'alert'}>{notice}</p>
    {retry && <button className="primary" disabled={busy} onClick={retry}>Qayta tekshirish</button>}
  </section></main>;
}

function TelegramApp({ runtime }: { runtime: Runtime }) {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const [bridgeFailed, setBridgeFailed] = useState(false);
  const start = async () => {
    setBridgeFailed(false);
    // The essential UI is mounted before the official bridge ready method.
    try { runtime.ready(); }
    catch { setBridgeFailed(true); return; }
    try { await runtime.start(); }
    catch { /* runtime owns sanitized failure state */ }
  };
  useEffect(() => { void start(); }, [runtime]);
  // Keep every rejected lifecycle promise observed, including late supersession.
  const logout = async () => { try { await runtime.logout(); } catch { /* safe runtime snapshot */ } };
  if (bridgeFailed) return <EntryCard notice="Telegram oynasi tayyor bo‘lmadi. Botdan qayta oching." />;
  if (snapshot.phase === 'ready' && snapshot.flow)
    return <StudentApp studentFlow={snapshot.flow} mode="telegram" onEnter={start} onLogout={logout} />;
  const busy = snapshot.phase === 'idle' || snapshot.phase === 'opening';
  const notice = busy ? 'Kabinet ochilmoqda…' : snapshot.phase === 'needs_launch'
    ? 'Telegram botdan kabinetni yangidan oching. Test vaqti davom etadi.'
    : snapshot.phase === 'logged_out' ? snapshot.notice + ' Telegram botdan yangidan kiring.'
    : snapshot.notice;
  return <EntryCard notice={notice} busy={busy} retry={snapshot.phase === 'error' ? () => void start() : undefined} />;
}

export function mountTelegramEntry(element: HTMLElement, options: Parameters<typeof prepareTelegramEntry>[0]) {
  const root: Root = createRoot(element);
  let runtime: Runtime | undefined;
  try {
    runtime = prepareTelegramEntry(options);
    root.render(<TelegramApp runtime={runtime} />);
  } catch {
    // Never print env values, endpoint URLs, raw SDK data or server errors in UI.
    root.render(<EntryCard notice="Kabinetga ulanish hali tayyor emas. Keyinroq qayta oching." />);
  }
  return { unmount() { runtime?.dispose(); root.unmount(); } };
}
