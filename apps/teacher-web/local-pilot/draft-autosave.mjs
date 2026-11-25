// Browser-side safety copy of the test a teacher is typing. Server drafts stay the source of truth.
// Only question text, formula source, image ids and answer choices are kept here: no tokens,
// no student data. Every key is bound to the verified person id and expires after 14 days.
const PREFIX = 'ua-teacher-draft:v1:';
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CHARS = 1_500_000;
const SLOT = /^(?:new|[A-Za-z0-9-]{1,64})$/;
const PERSON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function browserStorage(win) {
  try {
    const storage = win.localStorage;
    storage.getItem(PREFIX);
    return storage;
  } catch { return null; }
}

const array = (value, max) => Array.isArray(value) && value.length <= max;
function validBlock(block) {
  if (block === null || typeof block !== 'object') return false;
  if (block.type === 'text') return typeof block.markdown === 'string';
  if (block.type === 'formula') return typeof block.latex === 'string' && typeof block.display === 'string';
  if (block.type === 'image') return typeof block.asset_id === 'string' && typeof block.alt === 'string';
  return false;
}
function validQuestion(question) {
  return question !== null && typeof question === 'object' && typeof question.id === 'string' &&
    array(question.prompt_blocks, 100) && question.prompt_blocks.every(validBlock) &&
    array(question.explanation_blocks, 100) && question.explanation_blocks.every(validBlock) &&
    typeof question.correct_option_id === 'string' && array(question.options, 10) &&
    question.options.every(option => typeof option?.id === 'string' && array(option.blocks, 100) && option.blocks.every(validBlock));
}
function validSnapshot(value) {
  return value !== null && typeof value === 'object' && value.v === 1 && Number.isFinite(value.savedAt) &&
    typeof value.title === 'string' && typeof value.durationText === 'string' &&
    Number.isFinite(value.originalSeconds) && (value.targetRevision === null || Number.isSafeInteger(value.targetRevision)) &&
    value.metadata !== null && typeof value.metadata === 'object' &&
    array(value.questions, 200) && value.questions.length > 0 && value.questions.every(validQuestion);
}
// A copy is only worth offering back when the teacher actually wrote something.
export function meaningful(snapshot) {
  const text = block => block.type === 'text' ? block.markdown : block.type === 'formula' ? block.latex : 'image';
  const filled = blocks => blocks.some(block => text(block).trim() !== '');
  return snapshot.title.trim() !== '' || snapshot.questions.some(question =>
    filled(question.prompt_blocks) || filled(question.explanation_blocks) || question.options.some(option => filled(option.blocks)));
}

const unavailable = Object.freeze({
  available: false, key: () => '', write: () => false, read: () => null, remove() {}, hasAny: () => false,
  wipe() {}, onFlush: () => () => {}, flushAll() {},
});

export function createDraftStore({ storage, owner, now = Date.now } = {}) {
  if (!storage || typeof owner !== 'string' || !PERSON.test(owner)) return unavailable;
  const base = PREFIX + owner.toLowerCase() + ':';
  const flushers = new Set();
  let closed = false;
  const key = slot => {
    if (!SLOT.test(slot)) throw new Error('invalid draft slot');
    return base + slot;
  };
  function remove(slot) {
    try { storage.removeItem(key(slot)); } catch { /* storage may be blocked */ }
  }
  function read(slot) {
    let raw;
    try { raw = storage.getItem(key(slot)); } catch { return null; }
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      if (validSnapshot(value) && now() - value.savedAt < TTL_MS && value.savedAt <= now() + 60_000) return value;
    } catch { /* fall through and drop the broken copy */ }
    remove(slot);
    return null;
  }
  function slots(prefix) {
    const found = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name?.startsWith(prefix)) found.push(name);
      }
    } catch { /* ignore */ }
    return found;
  }
  // Expired copies (of any teacher who used this browser) never linger.
  for (const name of slots(PREFIX)) {
    try {
      const value = JSON.parse(storage.getItem(name));
      if (!validSnapshot(value) || now() - value.savedAt >= TTL_MS) storage.removeItem(name);
    } catch { try { storage.removeItem(name); } catch { /* ignore */ } }
  }
  return Object.freeze({
    available: true,
    key,
    read,
    remove,
    write(slot, snapshot) {
      if (closed) return false;
      try {
        const text = JSON.stringify({ ...snapshot, v: 1, savedAt: now() });
        if (text.length > MAX_CHARS) return false;
        storage.setItem(key(slot), text);
        return true;
      } catch { return false; }
    },
    hasAny() {
      return slots(base).some(name => {
        const snapshot = read(name.slice(base.length));
        return snapshot !== null && meaningful(snapshot);
      });
    },
    // Used by "Chiqish": removes every copy of this teacher and refuses later writes from the closing page.
    wipe() {
      closed = true;
      for (const name of slots(base)) { try { storage.removeItem(name); } catch { /* ignore */ } }
    },
    onFlush(callback) { flushers.add(callback); return () => flushers.delete(callback); },
    flushAll() { for (const callback of [...flushers]) callback(); },
  });
}
