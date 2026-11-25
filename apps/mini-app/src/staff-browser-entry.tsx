import { useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { hasTelegramLaunchContext } from './telegram-bridge.ts';
import { autoOpenStaffBrowser, openStaffBrowser, staffCabinets, staffPriority } from './staff-cabinets.ts';
import type { StaffRole } from './staff-cabinets.ts';

function BrowserLink({role, children, primary}: {role: StaffRole; children: ReactNode; primary?: boolean}) {
  const {url} = staffCabinets[role];
  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (openStaffBrowser(role, window)) event.preventDefault();
  }
  return <a className={primary ? 'primary cabinet-browser-button' : undefined} href={url} target="_blank" rel="noopener noreferrer external" referrerPolicy="no-referrer" onClick={open}>{children}</a>;
}

export function StaffBrowserEntry({role}: {role: StaffRole}) {
  const {title, url} = staffCabinets[role];
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!hasTelegramLaunchContext(window)) { window.location.replace(url); return; }
    if (autoOpenStaffBrowser(role, window) === 'opened') setNotice('Kabinet brauzerda ochilmoqda. Ochilmasa, tugmani bosing.');
  }, [role, url]);
  return <main className="shell"><section className="card">
    <h1>{title}</h1>
    <BrowserLink role={role} primary>Brauzerda ochish</BrowserLink>
    {notice && <p role="status">{notice}</p>}
  </section></main>;
}

export function StaffBrowserChoices() {
  return <details className="card staff-browser-choices"><summary>Xodim kabinetiga brauzerda kirish</summary>
    <ul>{staffPriority.map(role => <li key={role}><BrowserLink role={role}>{staffCabinets[role].title}</BrowserLink></li>)}</ul>
  </details>;
}
