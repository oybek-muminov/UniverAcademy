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
  } else void Promise.all([import('./production-entry.tsx'), import('./production-connection.ts')])
    .then(([{ mountTelegramEntry }, { createProductionConnection }]) => mountTelegramEntry(document.getElementById('root')!, {
      env: import.meta.env, pageOrigin: window.location.origin, scope: window, createConnection: createProductionConnection,
    }));
}
