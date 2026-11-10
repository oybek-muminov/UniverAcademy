import { DemoApp } from './demo.tsx';
import { StudentFlow } from './flow.ts';
import { StudentFailure } from './transport.ts';
import { createLocalOwnerPort } from './local-owner-port.ts';
import { STUDENT_CONTRACT_SHA256 } from './owner-client/student-client.ts';

// DEV/local_fixture entry only. The Node test harness injects a fresh synthetic
// launch into RAM before navigation. No signing helper/key or real Telegram input.
const launchSlot = window as unknown as { __UA_SYNTHETIC_INIT_DATA__?: string };
const owner = createLocalOwnerPort({ mode: 'local_fixture', contractSha256: STUDENT_CONTRACT_SHA256,
  baseUrl: window.location.origin + '/api/v1', fetcher: fetch,
  view: () => ({ title: 'Sintetik fizika', groupLabel: 'Mahalliy sintetik guruh', startAllowed: true }),
  assetUrl: () => { throw new StudentFailure('protocol', 'SYNTHETIC_MEDIA_NOT_CONFIGURED'); } });
const flow = new StudentFlow(owner.port);
async function enter() {
  if (flow.state.busy) return;
  flow.patch({ busy: true, notice: '', failure: null });
  try {
    const raw = launchSlot.__UA_SYNTHETIC_INIT_DATA__;
    delete launchSlot.__UA_SYNTHETIC_INIT_DATA__;
    if (!raw) throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED');
    await owner.auth.login(raw);
    flow.patch({ busy: false });
    await flow.enter();
  } catch (error) { flow.fail(error); }
  finally { flow.patch({ busy: false }); }
}
async function logout() {
  const pending = owner.auth.logout();
  const operation = owner.auth.logoutReceipt()?.operationId;
  flow.fail(new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED'));
  flow.patch({ notice: 'Qurilmadagi sessiya yopildi. Server tasdig‘i kutilmoqda.' });
  try {
    await pending;
    if (owner.auth.person() === null && owner.auth.logoutReceipt()?.operationId === operation)
      flow.patch({ notice: 'Server sessiya yopilganini tasdiqladi.' });
  } catch (error) {
    if (owner.auth.person() === null && owner.auth.logoutReceipt()?.operationId === operation) flow.fail(error);
  }
}
export function LocalHttpApp() { return <DemoApp studentFlow={flow} localHttp onEnter={enter} onLogout={logout} />; }
