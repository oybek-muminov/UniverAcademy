import { useRef, useState } from 'react';
import type { StudentFlow, Student } from './flow.ts';
import './dashboard.css';
import { saveDashboardProfile } from './dashboard-profile.ts';

export function AccountDashboard({ student, flow, busy, onLogout, onDeleteAccount, deletionBusy = false }: {
  student: Student; flow: StudentFlow; busy: boolean;
  onLogout?: () => Promise<void>; onDeleteAccount?: () => void; deletionBusy?: boolean;
}) {
  const [message, setMessage] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutLock = useRef(false);
  const locked = busy || loggingOut || deletionBusy;
  async function save(form: HTMLFormElement) {
    const data = new FormData(form);
    const first = String(data.get('firstName') ?? '').trim();
    const last = String(data.get('lastName') ?? '').trim();
    if (!first || !last) { setMessage('Ism va familiyani to‘liq kiriting.'); return; }
    setMessage('');
    if (await saveDashboardProfile(flow, student.person, first, last)) setMessage('O‘zgarishlar saqlandi.');
  }
  async function logout() {
    if (!onLogout || logoutLock.current || locked) return;
    logoutLock.current = true; setLoggingOut(true); setMessage('');
    try { await onLogout(); }
    catch { setMessage('Chiqish amalga oshmadi. Qayta urinib ko‘ring.'); }
    finally { logoutLock.current = false; setLoggingOut(false); }
  }
  return <section className="account-dashboard" aria-label="Hisob boshqaruvi">
    <form className="card" onSubmit={event => { event.preventDefault(); if (!locked) void save(event.currentTarget); }}>
      <h2>Shaxsiy ma’lumotlar</h2>
      <p className="account-id">ID: {student.displayId}</p>
      <label htmlFor="dashboard-first-name">Ism</label>
      <input id="dashboard-first-name" name="firstName" defaultValue={student.firstName} required maxLength={100} autoComplete="given-name" disabled={locked} />
      <label htmlFor="dashboard-last-name">Familiya</label>
      <input id="dashboard-last-name" name="lastName" defaultValue={student.lastName} required maxLength={100} autoComplete="family-name" disabled={locked} />
      <button className="primary" disabled={locked}>{busy ? 'Saqlanmoqda…' : 'Saqlash'}</button>
    </form>
    {message && <p className="notice" role="status">{message}</p>}
    <section className="card account-actions" aria-label="Hisob amallari">
      <div className="account-action-row">
        <button className="secondary" disabled={locked || !onLogout} onClick={() => void logout()}>{loggingOut ? 'Chiqilmoqda…' : 'Chiqish'}</button>
        <button className="danger-button" disabled={locked || !onDeleteAccount} onClick={onDeleteAccount}>Hisobni o‘chirish</button>
      </div>
      {!onDeleteAccount && <small>Hisobni o‘chirish hozircha ulanmagan.</small>}
    </section>
  </section>;
}
