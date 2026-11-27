import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCluster, addProfile } from './cluster.mjs';
import { provisionStaff } from './credentials.mjs';
import { switchPhase, backfill } from '../../supabase/migrations/cabinet-id/migrate.mjs';

// The Owner turns one finished student into a Teacher through a single guarded database function.
const migration = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');
async function install(t) {
  const cluster = await createCluster(), db = cluster.admin;
  t.after(() => cluster.close());
  await db.query("SET statement_timeout='20s'");
  await cluster.installDeletion();
  await switchPhase(db, 'forward'); await backfill(db);
  await db.query(await migration('teacher-staging/up.sql'));
  await db.query('ALTER SCHEMA ua_cabinet OWNER TO ua_owner');
  await db.query(await migration('teacher-notifications/001_teacher_notifications.sql'));
  await db.query(`CREATE ROLE managed_operator NOLOGIN BYPASSRLS NOSUPERUSER NOINHERIT;
    GRANT pg_read_all_data TO managed_operator WITH INHERIT TRUE,SET FALSE;
    GRANT ua_owner,ua_access_locator_owner,ua_deletion_executor TO managed_operator WITH ADMIN TRUE,INHERIT FALSE,SET FALSE`);
  const asOperator = async file => {
    await db.query('SET SESSION AUTHORIZATION managed_operator');
    try { await db.query(await migration(file)); }
    catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await db.query('RESET SESSION AUTHORIZATION'); }
  };
  await asOperator('single-role/001_single_role.sql');
  return { cluster, db, asOperator };
}
const members = db => db.query(`SELECT roleid::regrole::text,member::regrole::text,grantor::regrole::text,admin_option,inherit_option,set_option
  FROM pg_auth_members WHERE roleid='ua_owner'::regrole ORDER BY 1,2,3`).then(r => r.rows);
// One call exactly as the cabinet server makes it: the server role, inside a domain transaction of the signed-in actor.
async function assign(db, actor, target, subject = 'physics', { commit = false, phase = 'domain', person = actor } = {}) {
  await db.query('BEGIN');
  try {
    await db.query('SET LOCAL ROLE ua_cabinet_stage');
    await db.query("SELECT set_config('ua.phase',$1,true),set_config('ua.person_id',$2,true)", [phase, person]);
    await db.query('SELECT ua_cabinet.owner_assign_teacher($1,$2,$3)', [actor, target, subject]);
    const seen = (await db.query(`SELECT p.roles,p.profile->'roles' AS profile_roles,
      (SELECT count(*)::int FROM ua_private.staff_access a WHERE a.person_id=p.id) AS access,
      (SELECT count(*)::int FROM ua_private.teacher_subject_approvals a WHERE a.person_id=p.id AND a.approved) AS approvals,
      (SELECT count(*)::int FROM ua_private.staff_subject_scope a WHERE a.person_id=p.id) AS scopes FROM ua_private.people p WHERE p.id=$1`, [target])).rows[0];
    await db.query(commit ? 'COMMIT' : 'ROLLBACK');
    return seen;
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
}
const rejects = (promise, message) => assert.rejects(promise, error => { assert.match(error.message, message); return true; });
const tableState = async db => (await db.query(`SELECT
  (SELECT count(*)::int FROM ua_private.staff_access) access,(SELECT count(*)::int FROM ua_private.teacher_subject_approvals) approvals,
  (SELECT count(*)::int FROM ua_private.staff_subject_scope) scopes,(SELECT string_agg(id::text||roles::text,',' ORDER BY id) FROM ua_private.people) people`)).rows[0];

test('the Owner makes one eligible student a Teacher, and nothing else is possible', async t => {
  const { db, asOperator } = await install(t);
  const owner = (await provisionStaff(db, 'Ega', 'owner')).id, admin = (await provisionStaff(db, 'Admin', 'admin')).id;
  const teacher = (await provisionStaff(db, 'Ustoz', 'teacher')).id;
  const student = await addProfile(db, { name: 'Talaba', role: 'student', cabinetId: '5817703433', telegramId: 7100001 });
  const memberAlready = await addProfile(db, { name: 'Guruhda', role: 'student', cabinetId: '5817703434', telegramId: 7100002 });
  const unfinished = await addProfile(db, { name: 'Tugatmagan', role: 'student', cabinetId: '5817703435', telegramId: 7100003 });
  const disabled = await addProfile(db, { name: 'Faolsiz', role: 'student', cabinetId: '5817703436', telegramId: 7100004 });
  const group = randomUUID();
  await db.query("INSERT INTO ua_private.groups VALUES($1,1,'active')", [group]);
  await db.query('BEGIN');
  await db.query('UPDATE ua_private.memberships SET affinity_group_id=$2,active=true WHERE person_id=$1', [memberAlready, group]);
  await db.query("UPDATE ua_private.people SET profile=jsonb_set(profile,'{active_group_id}',to_jsonb($2::text)) WHERE id=$1", [memberAlready, group]);
  await db.query('COMMIT');
  await db.query("UPDATE ua_private.people SET profile=jsonb_set(profile,'{registration_complete}','false') WHERE id=$1", [unfinished]);
  await db.query('UPDATE ua_private.people SET enabled=false WHERE id=$1', [disabled]);
  const before = { members: await members(db) };

  // Before installation the server role cannot reach the function at all.
  await db.query('BEGIN'); await db.query('SET LOCAL ROLE ua_cabinet_stage');
  await rejects(db.query('SELECT ua_cabinet.owner_assign_teacher($1,$2,$3)', [owner, student, 'physics']), /does not exist/);
  await db.query('ROLLBACK');
  await asOperator('owner-assign/001_up.sql');
  assert.deepEqual(await members(db), before.members, 'temporary rights are returned');
  await rejects(asOperator('owner-assign/001_up.sql'), /already installed/);
  assert.deepEqual(await members(db), before.members);

  const base = await tableState(db);
  // Not the Owner, wrong transaction, wrong subject, oneself.
  for (const actor of [admin, teacher, student]) await rejects(assign(db, actor, memberAlready), /ASSIGN_FORBIDDEN/);
  await rejects(assign(db, owner, memberAlready), /ASSIGN_TARGET_IN_GROUP/);
  await rejects(assign(db, owner, student, 'physics', { phase: 'auth' }), /ASSIGN_FORBIDDEN/);
  await rejects(assign(db, owner, student, 'physics', { person: student }), /ASSIGN_FORBIDDEN/);
  await rejects(assign(db, owner, owner), /ASSIGN_FORBIDDEN/);
  await rejects(assign(db, owner, student, 'chemistry'), /ASSIGN_SUBJECT_INVALID/);
  await rejects(assign(db, owner, randomUUID()), /ASSIGN_TARGET_NOT_FOUND/);
  await rejects(assign(db, owner, disabled), /ASSIGN_TARGET_NOT_FOUND/);
  await rejects(assign(db, owner, unfinished), /ASSIGN_TARGET_INCOMPLETE/);
  await rejects(assign(db, owner, teacher), /ASSIGN_TARGET_NOT_STUDENT/);
  await rejects(assign(db, owner, admin), /ASSIGN_TARGET_NOT_STUDENT/);
  assert.deepEqual(await tableState(db), base, 'every refusal leaves the data untouched');

  // The server role itself has no write path to roles or staff access.
  const asServer = async sql => {
    await db.query('BEGIN'); await db.query('SET LOCAL ROLE ua_cabinet_stage');
    try { await db.query(...sql); } finally { await db.query('ROLLBACK'); }
  };
  await rejects(asServer(["UPDATE ua_private.people SET roles=ARRAY['owner']::text[] WHERE id=$1", [student]]), /permission denied/);
  await rejects(asServer(['INSERT INTO ua_private.staff_access(person_id,approved,manage_roster,manage_content,all_groups,all_subjects) VALUES($1,true,true,true,true,true)', [student]]), /permission denied|row-level security/);

  // A dry run shows the full result and writes nothing.
  const dry = await assign(db, owner, student);
  assert.deepEqual({ ...dry }, { roles: ['teacher'], profile_roles: ['teacher'], access: 1, approvals: 1, scopes: 1 });
  assert.deepEqual(await tableState(db), base);

  const done = await assign(db, owner, student, 'physics', { commit: true });
  assert.deepEqual({ ...done }, { roles: ['teacher'], profile_roles: ['teacher'], access: 1, approvals: 1, scopes: 1 });
  const row = (await db.query('SELECT a.approved,a.manage_roster,a.manage_content,a.all_groups,a.all_subjects FROM ua_private.staff_access a WHERE person_id=$1', [student])).rows[0];
  assert.deepEqual({ ...row }, { approved: true, manage_roster: false, manage_content: false, all_groups: false, all_subjects: false });
  // The existing notice path queues the Teacher's private message by itself.
  assert.equal((await db.query('SELECT state FROM ua_cabinet.teacher_notifications WHERE person_id=$1', [student])).rows[0]?.state, 'queued');
  // Already a Teacher now; a second assignment is refused, so a repeated click cannot double-grant.
  await rejects(assign(db, owner, student), /ASSIGN_TARGET_NOT_STUDENT/);
  assert.deepEqual(await members(db), before.members);

  // Rollback removes only the path.
  await asOperator('owner-assign/001_down.sql');
  assert.equal((await db.query("SELECT to_regprocedure('ua_cabinet.owner_assign_teacher(uuid,uuid,text)')::text AS f")).rows[0].f, null);
  assert.equal((await db.query("SELECT roles FROM ua_private.people WHERE id=$1", [student])).rows[0].roles[0], 'teacher');
  assert.deepEqual(await members(db), before.members);
});
