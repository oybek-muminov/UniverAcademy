import { hasTelegramLaunchContext } from './telegram-bridge.ts';
import { autoOpenStaffBrowser, openStaffBrowser, staffCabinets } from './staff-cabinets.ts';
import type { StaffRole } from './staff-cabinets.ts';

// The public bot menu links only to a sign-in page. It does not need React, Clerk or a Mini App session.
export function mountStaffHandoff(element: HTMLElement, role: StaffRole) {
  const {title, url} = staffCabinets[role];
  if (!hasTelegramLaunchContext(window)) {
    window.location.replace(url);
    return;
  }
  document.title = 'Univer Academy · ' + title;
  const heading = element.querySelector('h1')!;
  const status = element.querySelector('[role="status"]')!;
  heading.textContent = title;

  const link = document.createElement('a');
  link.className = 'primary cabinet-browser-button';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer external';
  link.referrerPolicy = 'no-referrer';
  link.textContent = 'Brauzerda ochish';
  link.onclick = event => { if (openStaffBrowser(role, window)) event.preventDefault(); };

  status.replaceWith(link);
  if (autoOpenStaffBrowser(role, window) === 'opened') {
    const note = document.createElement('p');
    note.setAttribute('role', 'status');
    note.textContent = 'Kabinet brauzerda ochilmoqda. Ochilmasa, tugmani bosing.';
    link.after(note);
  }
}
