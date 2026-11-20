import { TeacherCabinet, unconfiguredPort } from './cabinet.mjs';
import { createVerifiedBrowserAdapter } from './verified-browser-adapter.mjs';
import { renderCabinet } from './view.mjs';

export function mountTeacherCabinet(root, integration) {
  if (!root) return () => {};
  let adapter;
  try { adapter = integration ? createVerifiedBrowserAdapter(integration) : null; }
  catch {
    renderCabinet(root, { kind: 'unconfigured' }, {});
    return () => {};
  }
  let disposed = false, subscribed = false;
  const cabinet = new TeacherCabinet(adapter?.port ?? unconfiguredPort, state => renderCabinet(root, state, {
    refresh: () => void refresh(), select: tab => cabinet.select(tab), signout: () => void cabinet.leave('signout')
  }));
  const suspend = () => { adapter?.invalidate(); cabinet.suspend(); };
  const refresh = () => {
    if (!disposed && document.visibilityState !== 'hidden') return cabinet.refresh();
  };
  const identityChanged = () => {
    if (disposed || !subscribed) return;
    suspend(); // Clears previously rendered profile and invalidates even a pending sign-out.
    void refresh();
  };
  let unsubscribe;
  try {
    unsubscribe = adapter?.subscribe(identityChanged);
    if (adapter && typeof unsubscribe !== 'function') throw new Error('identity subscription unavailable');
    subscribed = true;
  } catch {
    disposed = true;
    cabinet.dispose();
    renderCabinet(root, { kind: 'unconfigured' }, {});
    return () => {};
  }
  const pageshow = event => { if (event.persisted) void refresh(); };
  const visibility = () => { if (document.visibilityState === 'hidden') suspend(); else void refresh(); };
  addEventListener('pagehide', suspend);
  addEventListener('pageshow', pageshow);
  document.addEventListener('visibilitychange', visibility);
  void refresh();
  return () => {
    if (disposed) return;
    disposed = true;
    cabinet.dispose();
    adapter?.invalidate();
    root.replaceChildren();
    removeEventListener('pagehide', suspend);
    removeEventListener('pageshow', pageshow);
    document.removeEventListener('visibilitychange', visibility);
    unsubscribe?.();
  };
}
