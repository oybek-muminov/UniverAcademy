import './style.css';
import { staffHandoffRole } from './staff-cabinets.ts';

const element = document.getElementById('root')!;

async function renderDemo(App: import('react').ComponentType) {
  const [{ createRoot }, { createElement }] = await Promise.all([import('react-dom/client'), import('react')]);
  createRoot(element).render(createElement(App));
}

// Only the selected route loads React and the code it uses.
if (location.pathname === '/account-deletion-status') {
  void import('./account-deletion-candidate/recovery-entry.tsx').then(({mountDeletionRecovery}) =>
    mountDeletionRecovery(element, {env:import.meta.env,pageOrigin:location.origin,storage:()=>localStorage}));
} else if (location.pathname.startsWith('/open-staff/')) {
  const role = staffHandoffRole(location.pathname);
  if (role) {
    void import('./staff-menu-handoff.ts').then(({mountStaffHandoff}) => mountStaffHandoff(element, role));
  } else {
    element.querySelector('[role="status"]')!.textContent = 'Kabinet manzili topilmadi.';
  }
} else if (import.meta.env.DEV && __AUTH_PROTOTYPE_PREVIEW__) {
  void import('./common-entry-prototype.tsx').then(({CommonEntryPrototypeApp}) => renderDemo(CommonEntryPrototypeApp));
} else if (import.meta.env.DEV && import.meta.env.MODE === 'local_fixture') {
  void import('./local-http.tsx').then(({LocalHttpApp}) => renderDemo(LocalHttpApp));
} else if (import.meta.env.DEV || import.meta.env.MODE === 'demo') {
  void import('./demo.tsx').then(({DemoApp}) => renderDemo(DemoApp));
} else if (import.meta.env.VITE_AUTH_ENTRY === 'common') {
  void import('./common-production-entry.tsx').then(({ mountCommonProductionEntry }) =>
    mountCommonProductionEntry(element, { env: import.meta.env, pageOrigin: location.origin, scope: window }));
} else {
  const status = element.querySelector('[role="status"]');
  if (status) status.textContent = 'Kabinetga ulanish hali tayyor emas. Keyinroq qayta oching.';
}
