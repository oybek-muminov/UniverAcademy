import { TeacherCabinet, unconfiguredPort } from './cabinet.mjs';
import { renderCabinet } from './view.mjs';
const root = document.getElementById('app');
// Real Clerk/server adapter is intentionally not guessed from provisional API contracts.
const cabinet = new TeacherCabinet(unconfiguredPort, state => renderCabinet(root, state, {
  refresh: () => void cabinet.refresh(), select: tab => cabinet.select(tab),
  student: () => void cabinet.leave('student'), signout: () => void cabinet.leave('signout')
}));
void cabinet.refresh();
// Never restore a cached staff profile after Back/Forward or an auth change elsewhere.
addEventListener('pagehide', () => cabinet.suspend());
addEventListener('pageshow', event => { if (event.persisted) void cabinet.refresh(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') cabinet.suspend();
  else void cabinet.refresh();
});
