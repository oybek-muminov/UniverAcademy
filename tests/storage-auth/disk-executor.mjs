// SQL EXECUTOR DOUBLE. Statement dispatch is by name; this is not PostgreSQL,
// an RLS engine, a SQL parser, or proof that the proposed SQL runs on a real DB.
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { dirname } from "node:path";
export function durableWrite(path, value) {
  const temporary = path + ".tmp", fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export class DiskExecutor {
  events = []; now = 10000; beforeLock; failStatement; failCommit; releasedDiscard = false; extension;
  tail = Promise.resolve();
  constructor(path) { this.path = path; }
  read() { return JSON.parse(readFileSync(this.path, "utf8")); }
  async connect() {
    const prior = this.tail; let unlock;
    this.tail = new Promise((resolve) => { unlock = resolve; }); await prior;
    let draft;
    const result = (rows = []) => ({ rows, rowCount: rows.length });
    const ack = () => result([{}]);
    return { release: (discard) => { this.releasedDiscard = !!discard; this.events.push("release"); unlock(); },
      query: async ({ name, text, values: v }) => {
        this.events.push(name);
        if (this.failStatement === name) { this.failStatement = null; throw Error("SYNTHETIC_WRITE_FAILURE"); }
        if (["ua_begin","ua_clerk_begin","ua_clerk_locator_begin"].includes(name)) { draft = this.read(); return result(); }
        if (["ua_rollback","ua_clerk_rollback","ua_clerk_locator_rollback"].includes(name)) return result();
        if (["ua_commit","ua_clerk_commit"].includes(name)) {
          const failure = this.failCommit; this.failCommit = null;
          if (failure === "before") throw Error("SYNTHETIC_COMMIT_UNKNOWN");
          durableWrite(this.path, draft);
          if (failure === "after") throw Error("SYNTHETIC_COMMIT_UNKNOWN");
          return result();
        }
        if(this.extension){const handled=await this.extension({name,text,values:v},draft??this.read());if(handled!==undefined)return handled;}
        if(["ua_people_context","ua_telegram_identity_context"].includes(name))return result();
        if(name==="ua_clerk_retire_person"){for(const f of Object.values(draft.clerkFences??{}))if(f.personId===v[0]&&f.retiredAt===null)f.retiredAt=v[1];return result();}
        if(name==="ua_session_provenance")return result(Object.values(draft.families).filter(f=>f.person_id===v[0]&&f.revoked_at_ms===null&&f.expires_at_ms>v[1]).map(f=>({auth_provider:f.auth_provider})));
        if (name === "ua_people_lock") {
          if (this.beforeLock) { const fn = this.beforeLock; this.beforeLock = null; await fn(); }
          return result(v[0].filter((id) => draft.people[id]).map((id) => ({ id })));
        }
        if (name === "ua_clock") return result([{ now_ms: String(this.now) }]);
        if (name === "ua_student_load") { const p = draft.people[v[0]]; return result(p ? [{ ...p, telegram_id: String(p.telegram_id) }] : []); }
        if (name === "ua_attempt_load") { const a = draft.attempts[v[0]]; return result(a?.body.personId === v[1] ? [a] : []); }
        if (name === "ua_answers_load") return result(Object.values(draft.answers[v[0]] ?? {}).map((a) => ({ ...a,
          revision: String(a.revision), saved_at_ms: String(a.saved_at_ms), series_state_revision: String(a.series_state_revision) })));
        if (name === "ua_ordinary_load") return result(draft.results[v[0]] ? [{ exact_result: draft.results[v[0]] }] : []);
        if (name === "ua_attempt_update") {
          const a = draft.attempts[v[2]];
          if (!a || a.body.personId !== v[3] || a.body.generation !== v[4] || a.body.stateRevision !== v[5]) return result();
          a.body = JSON.parse(v[0]); return ack();
        }
        if (name === "ua_answer_cas") {
          const answers = draft.answers[v[0]] ??= {}, old = answers[v[1]];
          if (old && old.revision !== v[6]) return result();
          answers[v[1]] = { question_id: v[1], selected_option_id: v[2], revision: v[3], saved_at_ms: v[4], series_state_revision: v[5] };
          return ack();
        }
        if (name === "ua_ordinary_insert") {
          if (draft.results[v[0]]) return result(); draft.results[v[0]] = JSON.parse(v[1]); return ack();
        }
        if (name === "ua_series_update") {
          const s = draft.series[v[3] + "/" + v[4]];
          if (!s || s.currentAttemptId !== v[2] || s.generation !== v[5]) return result();
          s.stateRevision = v[0]; if (v[1]) s.officialAttemptId = v[2]; return ack();
        }
        if (name === "ua_access_load") {
          const a = draft.access[v[0]], f = a && draft.families[a.family_id];
          return result(f?.person_id === v[1] ? [{ ...a, expires_at_ms: String(a.expires_at_ms),
            family_expires_at_ms: String(f.expires_at_ms), revoked_at_ms: f.revoked_at_ms === null ? null : String(f.revoked_at_ms) }] : []);
        }
        if (name === "ua_init_consume") {
          if (draft.replays[v[0]]) return result(); draft.replays[v[0]] = v[1]; return ack();
        }
        if (name === "ua_families_revoke" || name === "ua_family_revoke") {
          for (const [id, f] of Object.entries(draft.families))
            if ((name === "ua_family_revoke" ? id === v[2] : f.person_id === v[2]) && f.revoked_at_ms === null) {
              f.revoked_at_ms = v[0]; f.logout_retain_until_ms = v[1];
            }
          return result();
        }
        if (name === "ua_family_insert") {
          if (draft.families[v[0]] || Object.values(draft.families).some((f) => f.person_id === v[1] && f.revoked_at_ms === null)) throw Error("SYNTHETIC_UNIQUE_CONSTRAINT");
          draft.families[v[0]] = { person_id: v[1], expires_at_ms: v[2], revoked_at_ms: null, logout_retain_until_ms: null,auth_provider:"telegram" }; return result();
        }
        if (name === "ua_access_insert" || name === "ua_refresh_insert") {
          const table = name === "ua_access_insert" ? draft.access : draft.refresh;
          if (table[v[0]]) throw Error("SYNTHETIC_UNIQUE_CONSTRAINT");
          table[v[0]] = name === "ua_access_insert" ? { family_id: v[1], expires_at_ms: v[2], superseded: false } : { family_id: v[1], consumed: false };
          return result();
        }
        if (name === "ua_refresh_load") {
          const p = draft.refresh[v[0]], f = p && draft.families[p.family_id];
          return result(f?.person_id === v[1] ? [{ ...p, expires_at_ms: String(f.expires_at_ms), revoked_at_ms: f.revoked_at_ms === null ? null : String(f.revoked_at_ms) }] : []);
        }
        if (name === "ua_refresh_consume") { draft.refresh[v[0]].consumed = true; return ack(); }
        if (name === "ua_access_supersede") { for (const p of Object.values(draft.access)) if (p.family_id === v[0]) p.superseded = true; return result(); }
        throw Error("UNHANDLED_STATEMENT:" + name + ":" + text.slice(0, 20));
      } };
  }
}
