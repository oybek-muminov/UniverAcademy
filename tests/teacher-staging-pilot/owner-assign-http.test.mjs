import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createCabinetApi } from '../../runtime/teacher-cabinet-api.mjs';
import { createCluster, createServiceLogin } from './cluster.mjs';
import { party, ownerParty, provisionStaff, provisionStudent, testClerk } from './credentials.mjs';
import { apiOrigin, studentOrigin, routes, good, rejected } from './requests.mjs';
import { switchPhase, backfill } from '../../supabase/migrations/cabinet-id/migrate.mjs';

const migration = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');

test('the Owner finds a student by ID and makes them a Teacher over the real HTTP surface', async t => {
  const cluster = await createCluster(), db = cluster.admin;
  let pool;
  t.after(async () => { try { await pool?.end(); } finally { await cluster.close(); } });
  await db.query("SET statement_timeout='20s'");
  await cluster.installDeletion();
  await switchPhase(db, 'forward'); await backfill(db);
  await db.query(await migration('teacher-staging/up.sql'));
  await db.query('ALTER SCHEMA ua_cabinet OWNER TO ua_owner');
  await db.query(await migration('teacher-notifications/001_teacher_notifications.sql'));
  await db.query(`CREATE ROLE managed_operator NOLOGIN BYPASSRLS NOSUPERUSER NOINHERIT;
    GRANT pg_read_all_data TO managed_operator WITH INHERIT TRUE,SET FALSE;
    GRANT ua_owner,ua_access_locator_owner,ua_deletion_executor TO managed_operator WITH ADMIN TRUE,INHERIT FALSE,SET FALSE`);
  for (const file of ['single-role/001_single_role.sql', 'owner-assign/001_up.sql']) {
    await db.query('SET SESSION AUTHORIZATION managed_operator');
    try { await db.query(await migration(file)); } finally { await db.query('RESET SESSION AUTHORIZATION'); }
  }
  const login = await createServiceLogin(cluster, 'qa_owner_assign', [
    { role: 'ua_api_login', inherit: true, set: false }, { role: 'ua_cabinet_stage', inherit: false, set: true }]);
  pool = new pg.Pool({ connectionString: login, max: 5 });
  const clerk = await testClerk();
  const owner = await provisionStaff(db, 'Loyiha egasi', 'owner'), admin = await provisionStaff(db, 'Admin', 'admin');
  const teacher = await provisionStaff(db, 'Ustoz', 'teacher');
  const candidate = await provisionStudent(db, 'Nomzod', '0101000041', 712300041, { clerk });
  const unfinished = await provisionStudent(db, 'Tugatmagan', '0101000042', 712300042, { clerk });
  const grouped = await provisionStudent(db, 'Guruhli', '0101000043', 712300043, { clerk });
  await db.query("UPDATE ua_private.people SET profile=jsonb_set(profile,'{registration_complete}','false') WHERE id=$1", [unfinished.id]);
  const group = randomUUID();
  await db.query("INSERT INTO ua_private.groups VALUES($1,1,'active')", [group]);
  await db.query('BEGIN');
  await db.query('UPDATE ua_private.memberships SET affinity_group_id=$2,active=true WHERE person_id=$1', [grouped.id, group]);
  await db.query("UPDATE ua_private.people SET profile=jsonb_set(profile,'{active_group_id}',to_jsonb($2::text)) WHERE id=$1", [grouped.id, group]);
  await db.query('COMMIT');

  const api = createCabinetApi({ enabled: true, pool, teacherOrigin: party, studentOrigin, apiOrigin, ownerOrigin: ownerParty,
    verifier: clerk.verifier, liveness: clerk.liveness, allowLegacyTelegram: false }, async () => { throw new Error('no media'); });
  const sign = (subject, claims = {}) => clerk.sign(subject, { azp: ownerParty, ...claims });
  const ownerUI = routes(api, 'owner', await sign(owner.subject));

  assert.deepEqual((await good(ownerUI.dashboard())).teachers.map(x => x.name), ['Ustoz Sinov']);
  // Lookup
  assert.deepEqual(await good(ownerUI.command('findStudent', { univeracademy_id: '0101000041' })), {
    found: true, univeracademy_id: '0101000041', name: 'Nomzod Sinov', role: 'student', eligible: true, reason: null });
  assert.equal((await good(ownerUI.command('findStudent', { univeracademy_id: '0101000042' }))).reason, 'incomplete');
  assert.equal((await good(ownerUI.command('findStudent', { univeracademy_id: '0101000043' }))).reason, 'in_group');
  assert.equal((await good(ownerUI.command('findStudent', { univeracademy_id: '0000000000' }))).found, false);
  const staffRow = await good(ownerUI.command('findStudent', { univeracademy_id: (await db.query('SELECT univeracademy_id FROM ua_private.people WHERE id=$1', [teacher.id])).rows[0].univeracademy_id ?? '0000000001' }));
  assert.ok(staffRow.found === false || staffRow.reason === 'not_student');
  await rejected(ownerUI.command('findStudent', { univeracademy_id: 'abc' }), 422);
  await rejected(ownerUI.command('findStudent', {}), 422);
  // Nobody else, and no other surface, can use the Owner commands.
  for (const [who, token] of [['teacher', await sign(teacher.subject)], ['admin', await sign(admin.subject)], ['student', await sign(candidate.subject)]]) {
    await rejected(routes(api, 'owner', token).command('assignTeacher', { univeracademy_id: '0101000041' }), 403);
    await rejected(routes(api, 'owner', token).command('findStudent', { univeracademy_id: '0101000041' }), 403);
  }
  await rejected(routes(api, 'owner', candidate.token).command('assignTeacher', { univeracademy_id: '0101000041' }), 401);
  await rejected(routes(api, 'teacher', await sign(owner.subject)).command('assignTeacher', { univeracademy_id: '0101000041' }), 404);
  await rejected(routes(api, 'admin', await sign(owner.subject)).command('assignTeacher', { univeracademy_id: '0101000041' }), 404);
  await rejected(routes(api, 'owner', await clerk.sign(owner.subject)).command('assignTeacher', { univeracademy_id: '0101000041' }), 401);
  // Missing key, bad input, not eligible: nothing changes.
  const withoutKey = await api.fetch(new Request(ownerParty + '/api/v1/owner/pilot/commands/assignTeacher', { method: 'POST',
    headers: { origin: ownerParty, authorization: 'Bearer ' + await sign(owner.subject), 'content-type': 'application/json' }, body: '{"univeracademy_id":"0101000041"}' }));
  assert.equal(withoutKey.status, 400);
  await rejected(ownerUI.command('assignTeacher', { univeracademy_id: '12' }), 422);
  await rejected(ownerUI.command('assignTeacher', { univeracademy_id: '0101000041', subjectId: 'chemistry' }), 422);
  await rejected(ownerUI.command('assignTeacher', { univeracademy_id: '0000000000' }), 404);
  await rejected(ownerUI.command('assignTeacher', { univeracademy_id: '0101000042' }), 409);
  await rejected(ownerUI.command('assignTeacher', { univeracademy_id: '0101000043' }), 409);
  const rolesOf = async id => (await db.query('SELECT roles FROM ua_private.people WHERE id=$1', [id])).rows[0].roles;
  assert.deepEqual(await rolesOf(candidate.id), ['student']);

  // The real assignment, repeated with the same key (double click) and with a new key.
  const key = randomUUID(), body = { univeracademy_id: '0101000041' };
  // Two clicks at the same moment: one assignment happens and both answers are the same recorded result.
  const [first, second] = await Promise.all([good(ownerUI.command('assignTeacher', body, key)), good(ownerUI.command('assignTeacher', body, key))]);
  assert.deepEqual(second, first);
  // The same request repeated later with the same key returns the recorded answer.
  const again = await good(ownerUI.command('assignTeacher', body, key));
  assert.deepEqual(first, { id: candidate.id, univeracademy_id: '0101000041', name: 'Nomzod Sinov', subjectId: 'physics' });
  assert.deepEqual(again, first);
  await rejected(ownerUI.command('assignTeacher', body, randomUUID()), 409);
  await rejected(ownerUI.command('assignTeacher', { ...body, subjectId: 'physics', extra: 1 }, key), 409);
  assert.deepEqual(await rolesOf(candidate.id), ['teacher']);
  assert.equal((await db.query("SELECT count(*)::int n FROM ua_private.staff_audit WHERE actor_id=$1 AND action='assignTeacher' AND target_id=$2", [owner.id, candidate.id])).rows[0].n, 1);
  const teachers = (await good(ownerUI.dashboard())).teachers;
  assert.deepEqual(teachers.map(x => [x.name, x.subjects]), [['Nomzod Sinov', ['physics']], ['Ustoz Sinov', ['physics']]]);
  // The new Teacher can now open the Ustoz cabinet, as a teacher with only physics and no extra authority.
  const teacherUI = routes(api, 'teacher', await clerk.sign(candidate.subject));
  const opened = await good(teacherUI.dashboard());
  assert.equal(opened.role, 'teacher');
  assert.deepEqual(opened.subjects.map(x => x.id), ['physics']);
  // A Teacher cannot use the Owner surface, and the old student session no longer opens the student cabinet.
  await rejected(routes(api, 'owner', await sign(candidate.subject)).command('findStudent', body), 403);
  await rejected(routes(api, 'student', candidate.token).dashboard(), 403);
});
