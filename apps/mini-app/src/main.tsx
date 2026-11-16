import { createRoot } from 'react-dom/client';
import './style.css';

const demoRoot = () => createRoot(document.getElementById('root')!);

// Backend-owned local client is available only through explicit DEV fixture mode.
if (import.meta.env.DEV && __AUTH_PROTOTYPE_PREVIEW__) {
  void import('./common-entry-prototype.tsx').then(({ CommonEntryPrototypeApp }) => demoRoot().render(<CommonEntryPrototypeApp />));
} else if (import.meta.env.DEV && import.meta.env.MODE === 'local_fixture') {
  void import('./local-http.tsx').then(({ LocalHttpApp }) => demoRoot().render(<LocalHttpApp />));
} else if (import.meta.env.DEV || import.meta.env.MODE === 'demo') {
  void import('./demo.tsx').then(({ DemoApp }) => demoRoot().render(<DemoApp />));
} else {
  if (import.meta.env.VITE_AUTH_ENTRY === 'common') {
    void import('./common-production-entry.tsx').then(({ mountCommonProductionEntry }) =>
      mountCommonProductionEntry(document.getElementById('root')!, { env: import.meta.env, pageOrigin: location.origin, scope: window }));
  } else {
    // A missing/unknown Clerk-first setting must not activate the historical
    // Telegram-only authentication implementation.
    demoRoot().render(<main className="shell"><section className="card"><h1>Kabinetga kirish</h1>
      <p role="status">Kabinetga ulanish hali tayyor emas. Keyinroq qayta oching.</p>
    </section></main>);
  }
}
