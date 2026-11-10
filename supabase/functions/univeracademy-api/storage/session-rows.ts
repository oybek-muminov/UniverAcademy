import { fail } from "../fault.ts";
import { integer, own, query } from "./postgres-transaction.ts";
import type { LockedTransaction } from "./postgres-transaction.ts";

const digest = (s: string) => /^[0-9a-f]{64}$/.test(s);
export class SessionRows {
  // This legacy helper has no Clerk verifier/liveness binding. It must never
  // become an alternate path around the composed Clerk HTTP guard.
  private async telegramFamilies(tx:LockedTransaction,personId:string):Promise<void>{
    const r=await query(tx,"ua_session_provenance","SELECT auth_provider FROM ua_private.student_families WHERE person_id=$1 AND revoked_at_ms IS NULL AND expires_at_ms>$2",[personId,tx.now]);
    if(r.rows.some(f=>f.auth_provider!=="telegram"))fail("SERVICE_UNAVAILABLE",503);
  }
  async student(tx: LockedTransaction, personId: string, telegramUserId?: number): Promise<void> {
    own(tx, personId);
    const r = await query(tx, "ua_student_load", "SELECT telegram_id::text,enabled,roles FROM ua_private.people WHERE id=$1", [personId]);
    const person = r.rows[0];
    if (!person || (telegramUserId !== undefined && integer(person.telegram_id) !== telegramUserId)) fail("SESSION_REVOKED", 401);
    if (!person.enabled) fail("ACCOUNT_DISABLED", 403);
    if (!Array.isArray(person.roles) || !person.roles.includes("student")) fail("FORBIDDEN", 403);
  }
  async authorize(tx: LockedTransaction, personId: string, accessDigest: string): Promise<string> {
    if (!digest(accessDigest)) fail("SESSION_REVOKED", 401);
    await this.student(tx, personId);
    await this.telegramFamilies(tx,personId);
    const r = await query(tx, "ua_access_load", "SELECT a.family_id::text,a.expires_at_ms::text,a.superseded,f.expires_at_ms::text AS family_expires_at_ms,f.revoked_at_ms::text FROM ua_private.student_access a JOIN ua_private.student_families f ON f.id=a.family_id WHERE a.digest=$1 AND f.person_id=$2", [accessDigest, personId]);
    const p = r.rows[0];
    if (!p || p.revoked_at_ms !== null) fail("SESSION_REVOKED", 401);
    if (tx.now >= integer(p.expires_at_ms) || tx.now >= integer(p.family_expires_at_ms)) fail("APP_SESSION_EXPIRED", 401);
    if (p.superseded) fail("ACCESS_SUPERSEDED", 401);
    return p.family_id as string;
  }
  async loginExisting(tx: LockedTransaction, input: { personId: string; telegramUserId: number;
    // Caller must supply these only after the existing Telegram HMAC/freshness
    // verifier succeeds; no public HTTP handler accepts this structure directly.
    initDataDigest: string; familyId: string; expiresAt: number; accessExpiresAt: number;
    accessDigest: string; refreshDigest: string; logoutRetainUntil: number }): Promise<void> {
    const p = input;
    await this.student(tx, p.personId, p.telegramUserId);
    await this.telegramFamilies(tx,p.personId);
    if (![p.initDataDigest,p.accessDigest,p.refreshDigest].every(digest) ||
        ![p.expiresAt,p.accessExpiresAt,p.logoutRetainUntil].every(Number.isSafeInteger) ||
        p.accessExpiresAt <= tx.now || p.expiresAt < p.accessExpiresAt || p.logoutRetainUntil < tx.now)
      fail("SERVICE_UNAVAILABLE", 503);
    const consumed = await query(tx, "ua_init_consume", "INSERT INTO ua_private.init_data_replays(digest,person_id,consumed_at_ms) VALUES($1,$2,$3) ON CONFLICT(digest) DO NOTHING RETURNING digest", [p.initDataDigest,p.personId,tx.now]);
    if (consumed.rowCount !== 1) fail("INIT_DATA_REPLAY", 409);
    await query(tx,"ua_clerk_retire_person","UPDATE ua_private.clerk_student_sessions SET retired_at_ms=COALESCE(retired_at_ms,$2) WHERE person_id=$1",[p.personId,tx.now]);
    await query(tx, "ua_families_revoke", "UPDATE ua_private.student_families SET revoked_at_ms=$1,logout_retain_until_ms=$2 WHERE person_id=$3 AND revoked_at_ms IS NULL", [tx.now,p.logoutRetainUntil,p.personId]);
    await query(tx, "ua_family_insert", "INSERT INTO ua_private.student_families(id,person_id,expires_at_ms,revoked_at_ms,logout_retain_until_ms,auth_provider) VALUES($1,$2,$3,NULL,NULL,'telegram')", [p.familyId,p.personId,p.expiresAt]);
    await query(tx, "ua_access_insert", "INSERT INTO ua_private.student_access(digest,family_id,expires_at_ms,superseded) VALUES($1,$2,$3,false)", [p.accessDigest,p.familyId,p.accessExpiresAt]);
    await query(tx, "ua_refresh_insert", "INSERT INTO ua_private.student_refresh(digest,family_id,consumed) VALUES($1,$2,false)", [p.refreshDigest,p.familyId]);
  }
  async refresh(tx: LockedTransaction, personId: string, oldDigest: string,
    next: { accessDigest: string; refreshDigest: string; accessExpiresAt: number; logoutRetainUntil: number }) {
    await this.student(tx, personId);
    await this.telegramFamilies(tx,personId);
    if (![oldDigest,next.accessDigest,next.refreshDigest].every(digest)) fail("REFRESH_INVALID", 401);
    const r = await query(tx, "ua_refresh_load", "SELECT r.family_id::text,r.consumed,f.expires_at_ms::text,f.revoked_at_ms::text FROM ua_private.student_refresh r JOIN ua_private.student_families f ON f.id=r.family_id WHERE r.digest=$1 AND f.person_id=$2", [oldDigest,personId]);
    const p = r.rows[0];
    if (!p) fail("REFRESH_INVALID", 401);
    if (p.revoked_at_ms !== null) fail("SESSION_REVOKED", 401);
    if (tx.now >= integer(p.expires_at_ms)) fail("REFRESH_EXPIRED", 401);
    if (!Number.isSafeInteger(next.logoutRetainUntil) || next.logoutRetainUntil < tx.now) fail("SERVICE_UNAVAILABLE", 503);
    if (p.consumed) {
      await query(tx, "ua_family_revoke", "UPDATE ua_private.student_families SET revoked_at_ms=$1,logout_retain_until_ms=$2 WHERE id=$3 AND revoked_at_ms IS NULL", [tx.now,next.logoutRetainUntil,p.family_id]);
      return { ok: false as const, code: "REFRESH_REUSED" }; // Return commits family revocation.
    }
    if (!Number.isSafeInteger(next.accessExpiresAt) || next.accessExpiresAt <= tx.now ||
        next.accessExpiresAt > integer(p.expires_at_ms) || !Number.isSafeInteger(next.logoutRetainUntil) ||
        next.logoutRetainUntil < tx.now) fail("SERVICE_UNAVAILABLE", 503);
    await query(tx, "ua_refresh_consume", "UPDATE ua_private.student_refresh SET consumed=true WHERE digest=$1 AND consumed=false", [oldDigest]);
    await query(tx, "ua_access_supersede", "UPDATE ua_private.student_access SET superseded=true WHERE family_id=$1", [p.family_id]);
    await query(tx, "ua_access_insert", "INSERT INTO ua_private.student_access(digest,family_id,expires_at_ms,superseded) VALUES($1,$2,$3,false)", [next.accessDigest,p.family_id,next.accessExpiresAt]);
    await query(tx, "ua_refresh_insert", "INSERT INTO ua_private.student_refresh(digest,family_id,consumed) VALUES($1,$2,false)", [next.refreshDigest,p.family_id]);
    return { ok: true as const, familyId: p.family_id as string };
  }
}
