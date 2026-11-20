// Review-only transport envelope. This is not a published, accepted API schema.
function record(value, keys) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length) throw new Error('invalid teacher response');
  return Object.fromEntries(keys.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) throw new Error('invalid teacher response');
    return [key, field.value];
  }));
}

function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('invalid teacher response');
  return value;
}

function list(value, max, map) {
  if (!Array.isArray(value) || value.length > max) throw new Error('invalid teacher response');
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i));
    if (!field || !Object.hasOwn(field, 'value')) throw new Error('invalid teacher response');
    result.push(map(field.value));
  }
  return result;
}

function rows(value) {
  const seen = new Set();
  return list(value, 500, item => {
    const row = record(item, ['id', 'title']);
    const id = text(row.id);
    if (seen.has(id)) throw new Error('invalid teacher response');
    seen.add(id);
    return { id, title: text(row.title) };
  });
}

function ready(data, boundPersonId) {
  const view = record(data, ['person_id', 'name', 'access', 'subjects', 'groups', 'tests']);
  const personId = text(view.person_id);
  if (boundPersonId && personId !== boundPersonId) return { kind: 'forbidden' };
  const access = record(view.access, ['teacher', 'approved', 'enabled']);
  if (Object.values(access).some(value => typeof value !== 'boolean')) throw new Error('invalid teacher response');
  if (!access.teacher || !access.approved || !access.enabled) return { kind: 'forbidden' };
  return {
    kind: 'ready', personId, name: text(view.name), access,
    subjects: list(view.subjects, 100, text), groups: rows(view.groups), tests: rows(view.tests)
  };
}

function currentIdentity(source) {
  const value = source.current();
  if (value === null) return null;
  if (!value || typeof value.userId !== 'string' || !value.userId || value.userId.length > 200 ||
      typeof value.generation !== 'string' || !value.generation) throw new Error('verified identity unavailable');
  return Object.freeze({ userId: value.userId, generation: value.generation });
}

const same = (a, b) => a !== null && b !== null && a.userId === b.userId && a.generation === b.generation;

export function createVerifiedBrowserAdapter({ identity, transport }) {
  if (typeof identity?.current !== 'function' || typeof identity.subscribe !== 'function' ||
      typeof identity.signOut !== 'function' || typeof transport?.read !== 'function')
    throw new Error('teacher browser integration unavailable');

  // A direct Clerk login has no prior platform person ID. Only the scoped
  // server read establishes that mapping. Pin it for this mounted session.
  let version = 0, lastVerified = null, binding = null;
  const invalidate = () => { version += 1; lastVerified = null; };
  return Object.freeze({
    invalidate,
    subscribe(notify) {
      // The injected source reports verified identity changes and available grant-revocation events.
      return identity.subscribe(() => { invalidate(); notify(); });
    },
    port: Object.freeze({
      async load({ signal }) {
        invalidate();
        const request = version;
        if (signal.aborted) throw new Error('teacher read cancelled');
        const expected = currentIdentity(identity);
        if (!expected) return { kind: 'signed-out' };
        const response = await transport.read({ expected, signal });
        if (signal.aborted || request !== version || !same(expected, currentIdentity(identity)))
          throw new Error('teacher identity changed');
        const { status, data } = record(response, ['status', 'data']);
        if (status === 401) return { kind: 'signed-out' };
        if (status === 403) return { kind: 'forbidden' };
        if (status !== 200) throw new Error('teacher read unavailable');
        const result = ready(data, same(expected, binding?.identity ?? null) ? binding.personId : null);
        if (result.kind === 'ready') {
          binding = { identity: expected, personId: result.personId };
          lastVerified = expected;
        }
        return result;
      },
      async openStudent() { throw new Error('student switching is not enabled'); },
      async signOut() {
        const expected = lastVerified;
        invalidate();
        if (!same(expected, currentIdentity(identity))) throw new Error('teacher identity changed');
        // The integration must compare the expected provider generation at dispatch,
        // so an intervening account switch cannot sign out a different session.
        await identity.signOut(expected);
      }
    })
  });
}
