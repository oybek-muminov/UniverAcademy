import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCluster, addProfile } from '../../../tests/teacher-staging-pilot/cluster.mjs';
import { switchPhase, backfill } from '../cabinet-id/migrate.mjs';

// "Bitta odam - bitta rol". Mahalliy PostgreSQL, boshqariladigan operator (BYPASSRLS, rollarga faqat ADMIN) orqali.
const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const staffRoles = ['teacher', 'admin', 'owner'];
async function setup(t) {
  const cluster = await createCluster(), db = cluster.admin;
  t.after(() => cluster.close());
  await db.query("SET statement_timeout='8s'");
  await cluster.installDeletion();
  await switchPhase(db, 'forward'); await backfill(db);
  await db.query(`CREATE ROLE managed_operator NOLOGIN BYPASSRLS NOSUPERUSER NOINHERIT;
    GRANT pg_read_all_data TO managed_operator WITH INHERIT TRUE,SET FALSE;
    GRANT ua_owner,ua_access_locator_owner,ua_deletion_executor TO managed_operator WITH ADMIN TRUE,INHERIT FALSE,SET FALSE`);
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  const roles = async id => (await q('SELECT roles,profile->\'roles\' AS profile_roles FROM ua_private.people WHERE id=$1', [id]))[0];
  const asOperator = async sql => {
    await db.query('SET SESSION AUTHORIZATION managed_operator');
    try { await db.query(sql); }
    catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await db.query('RESET SESSION AUTHORIZATION'); }
  };
  const lookup = async telegramId => {
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('ua.phase','auth',true),set_config('ua.person_id','',true),set_config('ua.person_ids','[]',true),
        set_config('ua.clerk_issuer','',true),set_config('ua.clerk_subject','',true),set_config('ua.telegram_id','',true)`);
      return (await db.query('SELECT state FROM ua_private.lookup_telegram_start($1)', [telegramId])).rows[0]?.state;
    } finally { await db.query('ROLLBACK'); }
  };
  const withClerk = (id, n) => q("INSERT INTO ua_private.clerk_identities(issuer,subject,person_id,enabled) VALUES('https://clerk.example.test',$1,$2,true)", ['user_' + n, id]);
  const memberships = () => q(`SELECT roleid::regrole::text,member::regrole::text,grantor::regrole::text,admin_option,inherit_option,set_option
    FROM pg_auth_members WHERE roleid IN ('ua_owner'::regrole,'ua_access_locator_owner'::regrole,'ua_deletion_executor'::regrole) ORDER BY 1,2,3`);
  const schemaAcl = async () => (await q("SELECT nspacl::text FROM pg_namespace WHERE nspname='ua_private'"))[0].nspacl;
  return { cluster, db, q, roles, asOperator, lookup, withClerk, memberships, schemaAcl };
}
const asStaff = (db, id, role) => db.query(
  "UPDATE ua_private.people SET roles=ARRAY['student',$2]::text[],profile=jsonb_set(profile,'{roles}',to_jsonb(ARRAY['student',$2]::text[])) WHERE id=$1", [id, role]);

test('the rule removes the student role from existing staff, keeps students and returns every temporary right', async t => {
  const s = await setup(t), { db } = s;
  const teacher = await addProfile(db, { name: 'Ustoz', role: 'student', cabinetId: '0807896715', telegramId: 7000001 });
  const pupil = await addProfile(db, { name: 'Talaba', role: 'student', cabinetId: '5817703433', telegramId: 7000002 });
  await asStaff(db, teacher, 'teacher');
  assert.deepEqual((await s.roles(teacher)).roles, ['student', 'teacher']);
  const before = { members: await s.memberships(), acl: await s.schemaAcl() };
  await s.asOperator(await read('001_single_role.sql'));
  assert.deepEqual(await s.roles(teacher), { roles: ['teacher'], profile_roles: ['teacher'] });
  assert.deepEqual(await s.roles(pupil), { roles: ['student'], profile_roles: ['student'] });
  assert.deepEqual(await s.memberships(), before.members, 'no temporary role right survives');
  assert.equal(await s.schemaAcl(), before.acl, 'schema permissions are unchanged');
  assert.equal((await s.q("SELECT has_schema_privilege('ua_access_locator_owner','ua_private','CREATE') c"))[0].c, false);
});

test('afterwards nobody can hold two roles and a staff role replaces the student role by itself', async t => {
  const s = await setup(t), { db } = s;
  await s.asOperator(await read('001_single_role.sql'));
  const person = await addProfile(db, { name: 'Yangi', role: 'student', cabinetId: '1111111111' });
  for (const role of staffRoles) {
    await db.query("UPDATE ua_private.people SET roles=ARRAY['student',$2]::text[] WHERE id=$1", [person, role]);
    assert.deepEqual(await s.roles(person), { roles: [role], profile_roles: [role] }, 'student role is dropped and the profile follows');
    await db.query("UPDATE ua_private.people SET roles=ARRAY['student']::text[],profile=jsonb_set(profile,'{roles}','[\"student\"]') WHERE id=$1", [person]);
  }
  // Two staff roles are refused, not silently reduced to one.
  for (const roles of [['teacher', 'admin'], ['student', 'teacher', 'owner'], ['admin', 'owner']])
    await assert.rejects(db.query('UPDATE ua_private.people SET roles=$2::text[] WHERE id=$1', [person, roles]), error => error.message.includes('SINGLE_ROLE_VIOLATION'));
  // A repeated student role and an empty list stay invalid.
  await assert.rejects(db.query("UPDATE ua_private.people SET roles=ARRAY['student','student']::text[],profile=jsonb_set(profile,'{roles}','[\"student\",\"student\"]') WHERE id=$1", [person]), /people_single_role/);
  await assert.rejects(db.query("UPDATE ua_private.people SET roles=ARRAY[]::text[],profile=jsonb_set(profile,'{roles}','[]') WHERE id=$1", [person]));
  // A new person with student+teacher is stored as teacher only.
  const inserted = await addProfile(db, { name: 'Boshqa', role: 'student', cabinetId: '2222222222' });
  await db.query("UPDATE ua_private.people SET roles=ARRAY['student','teacher']::text[] WHERE id=$1", [inserted]);
  assert.deepEqual((await s.roles(inserted)).roles, ['teacher']);
  assert.deepEqual((await s.roles(person)).roles, ['student']);
});

test('the Telegram start lookup treats staff as linked, keeps students and still closes disabled or unlinked people', async t => {
  const s = await setup(t), { db } = s;
  const teacher = await addProfile(db, { name: 'Ustoz', role: 'student', cabinetId: '0807896715', telegramId: 7000001 });
  const pupil = await addProfile(db, { name: 'Talaba', role: 'student', cabinetId: '5817703433', telegramId: 7000002 });
  const closed = await addProfile(db, { name: 'Yopiq', role: 'student', cabinetId: '3333333333', telegramId: 7000003 });
  const bare = await addProfile(db, { name: 'Bog‘lanmagan', role: 'student', cabinetId: '4444444444', telegramId: 7000004 });
  await asStaff(db, teacher, 'teacher');
  await s.withClerk(teacher, 1); await s.withClerk(pupil, 2); await s.withClerk(closed, 3);
  await db.query('UPDATE ua_private.people SET enabled=false WHERE id=$1', [closed]);
  await s.asOperator(await read('001_single_role.sql'));
  assert.equal(await s.lookup(7000001), 'linked', 'a teacher who only has the teacher role');
  assert.equal(await s.lookup(7000002), 'linked');
  assert.equal(await s.lookup(7000003), 'disabled');
  assert.equal(await s.lookup(7000004), 'needs_clerk');
  assert.equal(await s.lookup(7999999), 'needs_clerk');
  assert.deepEqual((await s.roles(teacher)).roles, ['teacher']);
});

test('a database that already holds two staff roles on one person is left untouched and reported', async t => {
  const s = await setup(t), { db } = s;
  const person = await addProfile(db, { name: 'Ikki', role: 'student', cabinetId: '5555555555' });
  await db.query("UPDATE ua_private.people SET roles=ARRAY['teacher','admin']::text[],profile=jsonb_set(profile,'{roles}','[\"teacher\",\"admin\"]') WHERE id=$1", [person]);
  const before = await s.memberships();
  await assert.rejects(s.asOperator(await read('001_single_role.sql')), /more than one role/);
  assert.deepEqual((await s.roles(person)).roles, ['teacher', 'admin']);
  assert.equal((await s.q("SELECT count(*)::int n FROM pg_trigger WHERE tgname='single_role_normalize'"))[0].n, 0);
  assert.deepEqual(await s.memberships(), before);
});

test('installing twice is refused and the withdrawal restores the previous lookup and removes the rule', async t => {
  const s = await setup(t), { db } = s;
  const teacher = await addProfile(db, { name: 'Ustoz', role: 'student', cabinetId: '0807896715', telegramId: 7000001 });
  await s.withClerk(teacher, 1); await asStaff(db, teacher, 'teacher');
  const lookupBefore = (await s.q("SELECT prosrc,proacl::text acl FROM pg_proc WHERE oid='ua_private.lookup_telegram_start(bigint)'::regprocedure"))[0];
  const members = await s.memberships();
  await s.asOperator(await read('001_single_role.sql'));
  await assert.rejects(s.asOperator(await read('001_single_role.sql')), /already installed/);
  await s.asOperator(await read('001_withdraw.sql'));
  assert.equal((await s.q("SELECT count(*)::int n FROM pg_trigger WHERE tgname='single_role_normalize'"))[0].n, 0);
  assert.equal((await s.q("SELECT count(*)::int n FROM pg_constraint WHERE conname='people_single_role'"))[0].n, 0);
  assert.equal((await s.q("SELECT to_regprocedure('ua_private.enforce_single_role()') IS NULL gone"))[0].gone, true);
  const lookupAfter = (await s.q("SELECT prosrc,proacl::text acl FROM pg_proc WHERE oid='ua_private.lookup_telegram_start(bigint)'::regprocedure"))[0];
  assert.deepEqual(lookupAfter, lookupBefore);
  assert.deepEqual(await s.memberships(), members);
  assert.deepEqual((await s.roles(teacher)).roles, ['teacher'], 'the removed student role is not restored');
  assert.equal(await s.lookup(7000001), 'disabled', 'the old lookup needs the student role again');
});
