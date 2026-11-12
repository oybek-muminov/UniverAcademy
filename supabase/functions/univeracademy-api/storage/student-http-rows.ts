import { fail } from "../fault.ts";
import type { AssignmentRecord, Person, SeriesRecord, StudentState } from "../student-state.ts";
import { AttemptRows, decodePublished, decodeRatio } from "./attempt-rows.ts";
import { integer, own, query } from "./postgres-transaction.ts";
import type { LockedTransaction } from "./postgres-transaction.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const digest = (s: string) => /^[0-9a-f]{64}$/.test(s);
export class StudentHttpRows {
  private readonly attempts = new AttemptRows();
  private readonly options:{boundClerk?:boolean;externalAuthWriter?:boolean};
  constructor(options:{boundClerk?:boolean;externalAuthWriter?:boolean}={}){this.options=options;}
  async loadAuthentication(tx: LockedTransaction, personId: string): Promise<StudentState> {
    own(tx, personId);
    const p = (await query(tx, "ua_http_person", "SELECT telegram_id::text,enabled,roles,profile FROM ua_private.people WHERE id=$1", [personId])).rows[0];
    if (!p) fail("NOT_FOUND", 404);
    const profile = p.profile as Person["profile"];
    if (profile.person_id !== personId || !same(profile.roles, p.roles) || typeof p.enabled !== "boolean") fail("RESPONSE_INVARIANT_FAILED", 500);
    const s: StudentState = { people: { [personId]: { telegramId: p.telegram_id===null?null:integer(p.telegram_id), enabled: p.enabled, profile } },
      families: {},access: {},refresh: {},consumedInitData: {},grants: {[personId]:{}},assignments: {},series: {},attempts: {},receipts: {},bonuses: {},cancellations: {} };
    const families = await query(tx, "ua_http_families", "SELECT id::text,person_id::text,expires_at_ms::text,revoked_at_ms::text,logout_retain_until_ms::text,auth_provider FROM ua_private.student_families WHERE person_id=$1", [personId]);
    for (const f of families.rows) s.families[f.id as string] = { personId: f.person_id as string, expiresAt: integer(f.expires_at_ms),
      revokedAt: f.revoked_at_ms === null ? null : integer(f.revoked_at_ms), logoutRetainUntil: f.logout_retain_until_ms === null ? null : integer(f.logout_retain_until_ms),...(f.auth_provider===null?{}:{authProvider:f.auth_provider as "clerk"|"telegram"}) };
    if(Object.values(s.families).some(f=>f.personId!==personId))fail("RESPONSE_INVARIANT_FAILED",500);
    if(!this.options.boundClerk&&Object.values(s.families).some(f=>f.revokedAt===null&&tx.now<f.expiresAt&&f.authProvider!=="telegram"))fail("SERVICE_UNAVAILABLE",503);
    for (const a of (await query(tx, "ua_http_access", "SELECT a.digest,a.family_id::text,a.expires_at_ms::text,a.superseded FROM ua_private.student_access a JOIN ua_private.student_families f ON f.id=a.family_id WHERE f.person_id=$1", [personId])).rows)
      s.access[a.digest as string] = { familyId: a.family_id as string, expiresAt: integer(a.expires_at_ms), superseded: a.superseded as boolean };
    for (const r of (await query(tx, "ua_http_refresh", "SELECT r.digest,r.family_id::text,r.consumed FROM ua_private.student_refresh r JOIN ua_private.student_families f ON f.id=r.family_id WHERE f.person_id=$1", [personId])).rows)
      s.refresh[r.digest as string] = { familyId: r.family_id as string, consumed: r.consumed as boolean };
    for (const r of (await query(tx, "ua_http_replays", "SELECT digest FROM ua_private.init_data_replays WHERE person_id=$1", [personId])).rows) s.consumedInitData[r.digest as string] = true;
    return s;
  }
  async load(tx: LockedTransaction, personId: string): Promise<StudentState> {
    return this.loadDomain(tx,personId,await this.loadAuthentication(tx,personId));
  }
  async loadDomain(tx: LockedTransaction, personId: string, s: StudentState): Promise<StudentState> {
    own(tx,personId);
    if(!same(Object.keys(s.people),[personId])||s.people[personId].profile.person_id!==personId||
      Object.values(s.families).some(f=>f.personId!==personId)) fail("RESPONSE_INVARIANT_FAILED",500);
    for (const g of (await query(tx, "ua_http_grants", "SELECT g.assignment_id::text,(g.rostered AND m.active) AS rostered,m.epoch::text AS membership_epoch,g.grant_epoch::text FROM ua_private.grants g JOIN ua_private.memberships m ON m.person_id=g.person_id WHERE g.person_id=$1", [personId])).rows)
      s.grants[personId][g.assignment_id as string] = { rostered: g.rostered as boolean,membershipEpoch: integer(g.membership_epoch),grantEpoch: integer(g.grant_epoch) };
    const assignments = await query(tx, "ua_http_assignments", `SELECT a.record FROM ua_private.assignments a WHERE EXISTS(SELECT 1 FROM ua_private.grants g WHERE g.assignment_id=a.id AND g.person_id=$1) OR EXISTS(SELECT 1 FROM ua_private.attempts t WHERE t.assignment_id=a.id AND t.person_id=$1)`, [personId]);
    for (const row of assignments.rows) {
      const a = row.record as Omit<AssignmentRecord,"published"> & {published: Parameters<typeof decodePublished>[0]};
      s.assignments[a.admission.assignmentId] = { ...a,published: decodePublished(a.published) };
    }
    for (const row of (await query(tx, "ua_http_series", "SELECT demo_id::text,id::text,current_attempt_id::text,generation::text,normal_attempt_used,official_attempt_id::text,recovery_state,recovery_window FROM ua_private.exam_series WHERE person_id=$1", [personId])).rows) {
      s.series[personId+"/"+row.demo_id] = { id: row.id as string,currentAttemptId: row.current_attempt_id as string,
        generation: integer(row.generation),normalAttemptUsed: row.normal_attempt_used as boolean,officialAttemptId: row.official_attempt_id as string|null,
        recoveryState: row.recovery_state as SeriesRecord["recoveryState"],recovery: row.recovery_window as SeriesRecord["recovery"] };
    }
    for (const row of (await query(tx,"ua_http_attempt_ids","SELECT id::text FROM ua_private.attempts WHERE person_id=$1 ORDER BY id",[personId])).rows)
      s.attempts[row.id as string] = await this.attempts.load(tx,personId,row.id as string);
    for (const r of (await query(tx,"ua_http_receipts","SELECT key,payload,attempt_id::text FROM ua_private.command_receipts WHERE person_id=$1",[personId])).rows)
      s.receipts[r.key as string] = {payload:r.payload as string,attemptId:r.attempt_id as string};
    for (const row of (await query(tx,"ua_http_bonuses","SELECT attempt_id::text,record FROM ua_private.statistical_bonuses WHERE person_id=$1",[personId])).rows) {
      const b=row.record as Omit<StudentState["bonuses"][string],"earned">&{earned:Parameters<typeof decodeRatio>[0]};
      s.bonuses[row.attempt_id as string]={...b,earned:decodeRatio(b.earned)};
    }
    for (const row of (await query(tx,"ua_http_cancellations","SELECT attempt_id::text,record FROM ua_private.attempt_cancellations WHERE person_id=$1",[personId])).rows)
      s.cancellations[row.attempt_id as string]=row.record as StudentState["cancellations"][string];
    return s;
  }
  async flush(tx: LockedTransaction, personId: string, before: StudentState, after: StudentState): Promise<void> {
    own(tx,personId);
    if (!same(Object.keys(after.people),[personId])) fail("SESSION_REVOKED",401); // Initial identity creation is not implemented here.
    const a=after.people[personId], b=before.people[personId];
    const identity=(p:Person)=>({telegramId:p.telegramId,enabled:p.enabled,personId:p.profile.person_id,roles:p.profile.roles,
      group:p.profile.active_group_id,qadam:p.profile.qadam_id});
    if(!same(identity(a),identity(b))) fail("RESPONSE_INVARIANT_FAILED",500);
    if(!this.options.externalAuthWriter&&!same(a.profile,b.profile)) {
      const r=await query(tx,"ua_http_profile_write","UPDATE ua_private.people SET profile=$1::jsonb WHERE id=$2 RETURNING id",[JSON.stringify(a.profile),personId]);
      if(r.rowCount!==1) fail("RESPONSE_INVARIANT_FAILED",500);
    }
    const snapshot=(s:StudentState)=>JSON.stringify({grants:s.grants,assignments:s.assignments,bonuses:s.bonuses,cancellations:s.cancellations},(_,v)=>typeof v==="bigint"?v.toString():v);
    if(snapshot(before)!==snapshot(after)) fail("RESPONSE_INVARIANT_FAILED",500);
    for(const key of Object.keys(after.consumedInitData)) if(!before.consumedInitData[key]) {
      if(!digest(key)) fail("RESPONSE_INVARIANT_FAILED",500);
      const r=await query(tx,"ua_init_consume","INSERT INTO ua_private.init_data_replays(digest,person_id,consumed_at_ms) VALUES($1,$2,$3) ON CONFLICT(digest) DO NOTHING RETURNING digest",[key,personId,tx.now]);
      if(r.rowCount!==1) fail("INIT_DATA_REPLAY",409);
    }
    if(!this.options.externalAuthWriter){
    if(Object.entries(after.families).some(([id,f])=>!before.families[id]&&f.authProvider==="telegram"))
      await query(tx,"ua_clerk_retire_person","UPDATE ua_private.clerk_student_sessions SET retired_at_ms=COALESCE(retired_at_ms,$2) WHERE person_id=$1",[personId,tx.now]);
    for(const [id,f] of Object.entries(after.families)) if(!same(before.families[id],f)) {
      if(f.personId!==personId) fail("RESPONSE_INVARIANT_FAILED",500);
      const old=before.families[id];
      if(old && (old.expiresAt!==f.expiresAt || old.authProvider!==f.authProvider || (old.revokedAt!==null && !same(old,f)))) fail("RESPONSE_INVARIANT_FAILED",500);
      if(!old&&f.authProvider!=="telegram")fail("SERVICE_UNAVAILABLE",503);
      const r=await query(tx,"ua_http_family_merge",`INSERT INTO ua_private.student_families(id,person_id,expires_at_ms,revoked_at_ms,logout_retain_until_ms,auth_provider) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET revoked_at_ms=COALESCE(ua_private.student_families.revoked_at_ms,EXCLUDED.revoked_at_ms),logout_retain_until_ms=CASE WHEN ua_private.student_families.revoked_at_ms IS NULL THEN EXCLUDED.logout_retain_until_ms ELSE ua_private.student_families.logout_retain_until_ms END WHERE ua_private.student_families.person_id=EXCLUDED.person_id AND ua_private.student_families.auth_provider IS NOT DISTINCT FROM EXCLUDED.auth_provider RETURNING id`,[id,personId,f.expiresAt,f.revokedAt,f.logoutRetainUntil,f.authProvider??null]);
      if(r.rowCount!==1) fail("RESPONSE_INVARIANT_FAILED",500);
    }
    for(const [key,p] of Object.entries(after.access)) if(!same(before.access[key],p)) {
      if(!digest(key)||!after.families[p.familyId]) fail("RESPONSE_INVARIANT_FAILED",500);
      const r=await query(tx,"ua_http_access_merge",`INSERT INTO ua_private.student_access(digest,family_id,expires_at_ms,superseded) VALUES($1,$2,$3,$4) ON CONFLICT(digest) DO UPDATE SET superseded=ua_private.student_access.superseded OR EXCLUDED.superseded WHERE ua_private.student_access.family_id=EXCLUDED.family_id AND ua_private.student_access.expires_at_ms=EXCLUDED.expires_at_ms RETURNING digest`,[key,p.familyId,p.expiresAt,p.superseded]);
      if(r.rowCount!==1) fail("RESPONSE_INVARIANT_FAILED",500);
    }
    for(const [key,p] of Object.entries(after.refresh)) if(!same(before.refresh[key],p)) {
      if(!digest(key)||!after.families[p.familyId]) fail("RESPONSE_INVARIANT_FAILED",500);
      const r=await query(tx,"ua_http_refresh_merge",`INSERT INTO ua_private.student_refresh(digest,family_id,consumed) VALUES($1,$2,$3) ON CONFLICT(digest) DO UPDATE SET consumed=ua_private.student_refresh.consumed OR EXCLUDED.consumed WHERE ua_private.student_refresh.family_id=EXCLUDED.family_id RETURNING digest`,[key,p.familyId,p.consumed]);
      if(r.rowCount!==1) fail("RESPONSE_INVARIANT_FAILED",500);
    }
    }
    // Insert first attempts before linking the new series. Proposed schema needs
    // deferred series/current-attempt FK checks; actual DDL remains unverified.
    for(const [id,r] of Object.entries(after.attempts)) if(!before.attempts[id]) await this.attempts.insert(tx,r);
    for(const [key,s] of Object.entries(after.series)) if(!same(before.series[key],s)) {
      if(!key.startsWith(personId+"/")) fail("RESPONSE_INVARIANT_FAILED",500);
      const old=before.series[key],record=after.attempts[s.currentAttemptId];
      if(!record || record.personId!==personId || record.generation!==s.generation) fail("RESPONSE_INVARIANT_FAILED",500);
      const result=await query(tx,"ua_http_series_merge",`INSERT INTO ua_private.exam_series(person_id,demo_id,id,current_attempt_id,generation,state_revision,normal_attempt_used,official_attempt_id,recovery_state,recovery_window) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(person_id,demo_id) DO UPDATE SET current_attempt_id=EXCLUDED.current_attempt_id,generation=EXCLUDED.generation,state_revision=EXCLUDED.state_revision,normal_attempt_used=EXCLUDED.normal_attempt_used,official_attempt_id=EXCLUDED.official_attempt_id,recovery_state=EXCLUDED.recovery_state,recovery_window=EXCLUDED.recovery_window WHERE ua_private.exam_series.current_attempt_id=$11 AND ua_private.exam_series.generation=$12 RETURNING id`,
        [personId,key.slice(personId.length+1),s.id,s.currentAttemptId,s.generation,record.seriesStateRevision,s.normalAttemptUsed,s.officialAttemptId,s.recoveryState,JSON.stringify(s.recovery),old?.currentAttemptId??null,old?.generation??null]);
      if(result.rowCount!==1) fail("ATTEMPT_SUPERSEDED",409);
    }
    for(const [id,r] of Object.entries(after.attempts)) if(before.attempts[id]) await this.attempts.persist(tx,before.attempts[id],r);
    for(const [key,r] of Object.entries(after.receipts)) if(!before.receipts[key]) {
      if(!key.startsWith(personId+"/")) fail("RESPONSE_INVARIANT_FAILED",500);
      const result=await query(tx,"ua_http_receipt_insert","INSERT INTO ua_private.command_receipts(person_id,key,payload,attempt_id) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO NOTHING RETURNING key",[personId,key,r.payload,r.attemptId]);
      if(result.rowCount!==1) fail("IDEMPOTENCY_CONFLICT",409);
    }
    for(const collection of ["families","access","refresh","consumedInitData","attempts","series","receipts"] as const)
      if(Object.keys(before[collection]).some(key=>!Object.hasOwn(after[collection],key))) fail("RESPONSE_INVARIANT_FAILED",500);
  }
}
