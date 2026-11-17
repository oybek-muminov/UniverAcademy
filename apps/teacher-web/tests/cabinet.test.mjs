import test from 'node:test';
import assert from 'node:assert/strict';
import { TeacherCabinet, unconfiguredPort } from '../src/cabinet.mjs';
const ready = () => ({ kind: 'ready', personId: 'person-1', name: 'Test Teacher',
  access: { teacher: true, approved: true, enabled: true }, subjects: ['Fizika'],
  groups: [{ id: 'group-1', title: 'Fizika A' }], tests: [] });
function setup(load = async () => ready(), extras = {}) {
  const states = []; const port = { load, openStudent: async () => {}, signOut: async () => {}, ...extras };
  return { states, cabinet: new TeacherCabinet(port, state => states.push(state)) };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
test('no adapter fails closed', async () => {
  const app = new TeacherCabinet(unconfiguredPort, () => {}); await app.refresh(); assert.equal(app.state.kind, 'unconfigured');
});
test('server profile is shown without changing person identity or roles', async () => {
  const { cabinet } = setup(); await cabinet.refresh(); assert.equal(cabinet.state.personId, 'person-1'); assert.deepEqual(cabinet.state.subjects, ['Fizika']);
});
for (const kind of ['signed-out', 'forbidden', 'unconfigured']) test(`${kind} never retains previous identity`, async () => {
  let result = ready(); const { cabinet } = setup(async () => result); await cabinet.refresh(); result = { kind }; await cabinet.identityChanged();
  assert.equal(cabinet.state.kind, kind); assert.equal(cabinet.state.name, undefined); assert.equal(cabinet.state.groups, undefined);
});
for (const field of ['teacher', 'approved', 'enabled']) test(`missing ${field} is not a teacher view`, async () => {
  const result = ready(); result.access[field] = false; const { cabinet } = setup(async () => result);
  await cabinet.refresh(); assert.equal(cabinet.state.kind, 'error');
});
test('loads error, unknown result, or malformed row without disclosure', async () => {
  for (const result of [{ kind: 'unexpected' }, { ...ready(), groups: [{ title: 'bad' }] }, { ...ready(), subjects: null }]) {
    const { cabinet } = setup(async () => result); await cabinet.refresh(); assert.equal(cabinet.state.kind, 'error');
  }
  const { cabinet } = setup(async () => { throw Error('secret response'); }); await cabinet.refresh();
  assert.deepEqual(cabinet.state, { kind: 'error', tab: 'overview' });
});
test('abort and epoch reject stale successful identity', async () => {
  const old = deferred(), current = deferred(); let calls = 0; const signals = [];
  const { cabinet } = setup(({ signal }) => { signals.push(signal); return ++calls === 1 ? old.promise : current.promise; });
  const one = cabinet.refresh(); const two = cabinet.identityChanged(); assert.equal(signals[0].aborted, true);
  current.resolve({ ...ready(), personId: 'person-2', name: 'Current' }); await two;
  old.resolve(ready()); await one; assert.equal(cabinet.state.name, 'Current');
});
test('stale error does not replace newer success', async () => {
  const old = deferred(); let calls = 0; const { cabinet } = setup(() => ++calls === 1 ? old.promise : Promise.resolve(ready()));
  const first = cabinet.refresh(); await cabinet.refresh(); old.reject(Error('old')); await first; assert.equal(cabinet.state.kind, 'ready');
});
test('refresh clears old profile before network finishes', async () => {
  const pending = deferred(); let calls = 0; const { cabinet } = setup(() => ++calls === 1 ? Promise.resolve(ready()) : pending.promise);
  await cabinet.refresh(); const refreshing = cabinet.refresh(); assert.equal(cabinet.state.kind, 'loading'); assert.equal(cabinet.state.personId, undefined);
  pending.resolve({ kind: 'forbidden' }); await refreshing;
});
test('only known tabs can be selected on ready state', async () => {
  const { cabinet } = setup(); cabinet.select('groups'); assert.equal(cabinet.state.tab, 'overview'); await cabinet.refresh();
  cabinet.select('groups'); assert.equal(cabinet.state.tab, 'groups'); cabinet.select('admin'); assert.equal(cabinet.state.tab, 'groups');
});
test('student mode switches view without signout or second account', async () => {
  let student = 0, signout = 0; const { cabinet } = setup(undefined, { openStudent: async () => student++, signOut: async () => signout++ });
  await cabinet.refresh(); await cabinet.leave('student'); assert.equal(student, 1); assert.equal(signout, 0); assert.equal(cabinet.state.kind, 'student');
});
test('repeat exit, reload and navigation are locked while signing out', async () => {
  const pending = deferred(); let called = 0; const { cabinet } = setup(undefined, { signOut: async () => { called++; await pending.promise; } });
  await cabinet.refresh(); const first = cabinet.leave('signout'); await cabinet.leave('signout'); await cabinet.refresh(); cabinet.select('tests');
  assert.equal(called, 1); assert.equal(cabinet.state.kind, 'leaving'); assert.equal(cabinet.state.personId, undefined);
  pending.resolve(); await first; assert.equal(cabinet.state.kind, 'signed-out');
});
test('failed exit never restores possibly revoked teacher data', async () => {
  const { cabinet } = setup(undefined, { signOut: async () => { throw Error('offline'); } });
  await cabinet.refresh(); await cabinet.leave('signout'); assert.equal(cabinet.state.kind, 'error'); assert.equal(cabinet.state.groups, undefined);
});
test('dispose cancels loads and suppresses state callbacks', async () => {
  const pending = deferred(); const { cabinet, states } = setup(() => pending.promise);
  const call = cabinet.refresh(); cabinet.dispose(); pending.resolve(ready()); await call; await cabinet.refresh();
  assert.equal(states.length, 1); assert.equal(states[0].kind, 'loading');
});
test('list data is copied and immutable', async () => {
  const result = ready(); const { cabinet } = setup(async () => result); await cabinet.refresh();
  result.groups[0].title = 'Changed'; assert.equal(cabinet.state.groups[0].title, 'Fizika A'); assert.equal(Object.isFrozen(cabinet.state.groups[0]), true);
});
test('duplicate ids and excessive lists are rejected', async () => {
  for (const groups of [[{ id: 'x', title: 'A' }, { id: 'x', title: 'B' }], Array.from({ length: 501 }, (_, i) => ({ id: String(i), title: 'A' }))]) {
    const { cabinet } = setup(async () => ({ ...ready(), groups })); await cabinet.refresh(); assert.equal(cabinet.state.kind, 'error');
  }
});
test('page suspension clears identity and resume revalidates permissions', async () => {
  let result = ready(); const { cabinet } = setup(async () => result); await cabinet.refresh();
  cabinet.suspend(); assert.equal(cabinet.state.personId, undefined); assert.equal(cabinet.state.kind, 'idle');
  result = { kind: 'forbidden' }; await cabinet.refresh(); assert.equal(cabinet.state.kind, 'forbidden');
});
test('page suspension invalidates an outstanding load', async () => {
  const pending = deferred(); const { cabinet } = setup(() => pending.promise); const load = cabinet.refresh();
  cabinet.suspend(); pending.resolve(ready()); await load; assert.equal(cabinet.state.kind, 'idle');
});
