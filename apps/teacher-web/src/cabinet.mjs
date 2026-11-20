/** Presentation only. The injected port owns Clerk and canonical server authorization.
 * No client storage, Telegram data, role mutation or guessed HTTP endpoints here. */
export class TeacherCabinet {
  #port; #emit; #epoch = 0; #abort; #disposed = false; #leaving = false;
  state = { kind: 'idle', tab: 'overview' };
  constructor(port, emit) { this.#port = port; this.#emit = emit; }
  #set(value) { if (!this.#disposed) { this.state = Object.freeze(value); this.#emit(this.state); } }
  async refresh() {
    if (this.#disposed || this.#leaving) return;
    const epoch = ++this.#epoch;
    this.#abort?.abort(); this.#abort = new AbortController();
    const tab = this.state.tab;
    this.#set({ kind: 'loading', tab }); // Clear old identity and lists immediately.
    try {
      const result = await this.#port.load({ signal: this.#abort.signal });
      if (this.#disposed || epoch !== this.#epoch) return;
      if (result?.kind !== 'ready') {
        const kind = ['signed-out', 'forbidden', 'unconfigured'].includes(result?.kind) ? result.kind : 'error';
        this.#set({ kind, tab }); return;
      }
      const profile = normalizeProfile(result);
      this.#set({ kind: 'ready', tab, ...profile });
    } catch {
      if (epoch === this.#epoch) this.#set({ kind: 'error', tab });
    }
  }
  select(tab) {
    if (this.state.kind !== 'ready' || !['overview', 'groups', 'tests'].includes(tab)) return;
    this.#set({ ...this.state, tab });
  }
  // Call synchronously on Clerk subject/session change, then reload authoritative data.
  identityChanged() { return this.refresh(); }
  async leave(action) {
    if (this.#leaving || this.#disposed || this.state.kind !== 'ready') return;
    if (action !== 'student' && action !== 'signout') return;
    this.#leaving = true; const epoch = ++this.#epoch; this.#abort?.abort();
    this.#set({ kind: 'leaving', tab: 'overview' });
    try {
      await (action === 'student' ? this.#port.openStudent() : this.#port.signOut());
      if (epoch === this.#epoch) this.#set({ kind: action === 'student' ? 'student' : 'signed-out', tab: 'overview' });
    } catch { if (epoch === this.#epoch) this.#set({ kind: 'error', tab: 'overview' }); }
    finally { if (epoch === this.#epoch) this.#leaving = false; }
  }
  suspend() {
    if (this.#disposed) return;
    ++this.#epoch; this.#abort?.abort(); this.#leaving = false;
    this.#set({ kind: 'idle', tab: 'overview' });
  }
  dispose() { this.#disposed = true; ++this.#epoch; this.#abort?.abort(); }
}

function text(value, limit = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('invalid view data');
  return value;
}
function rows(value) {
  if (!Array.isArray(value) || value.length > 500) throw new Error('invalid list');
  const seen = new Set();
  return Object.freeze(value.map(row => {
    const id = text(row?.id); if (seen.has(id)) throw new Error('duplicate row'); seen.add(id);
    return Object.freeze({ id, title: text(row.title) });
  }));
}
function normalizeProfile(result) {
  // Defense-in-depth for adapter errors; never an authorization substitute.
  if (result.access?.teacher !== true || result.access?.approved !== true || result.access?.enabled !== true) {
    throw new Error('teacher permission required');
  }
  return {
    personId: text(result.personId), name: text(result.name),
    subjects: Object.freeze(subjects(result.subjects)),
    groups: rows(result.groups), tests: rows(result.tests)
  };
}
export const unconfiguredPort = Object.freeze({
  async load() { return { kind: 'unconfigured' }; },
  async openStudent() { throw new Error('adapter required'); },
  async signOut() { throw new Error('adapter required'); }
});

function subjects(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid subjects");
  return value.map(subject => text(subject));
}
