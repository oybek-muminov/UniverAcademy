import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, people, issuer, lease as group, education } from '../account-deletion/schema-fixture.mjs';
import { clerkFixture } from '../clerk-auth/fixture.mjs';
import { composeTeacherBrowserPilotPostgres } from '../../supabase/functions/univeracademy-api/teacher-browser-pilot-postgres.ts';

test('existing teacher reads 1-guruh, then loses access on archive and revocation', async t => {
  // Use a disposable, in-memory PostgreSQL schema. Production ACLs are external.
  assert.ok(!process.env.UA_SCHEMA_NATIVE_URL, 'this fixture requires the in-memory database');
  const db = await fixture();
  t.after(() => db.close());
  await db.exec(`
    ALTER TABLE ua_private.groups ADD COLUMN name text;
    CREATE FUNCTION ua_private.lock_clerk_identity(text,text) RETURNS TABLE(person_id uuid,enabled boolean)
      LANGUAGE sql AS 'SELECT person_id,enabled FROM ua_private.clerk_identities WHERE issuer=$1 AND subject=$2 FOR UPDATE';
    CREATE FUNCTION ua_private.lock_people(uuid[]) RETURNS TABLE(id uuid)
      LANGUAGE sql AS 'SELECT id FROM ua_private.people WHERE id=ANY($1) ORDER BY id FOR UPDATE';
  `);
  const person = people[0];
  await db.query("UPDATE ua_private.people SET roles=ARRAY['teacher'], profile=$1::jsonb WHERE id=$2",
    [JSON.stringify({first_name:'Sinov', last_name:'Ustoz'}), person]);
  await db.query("UPDATE ua_private.groups SET name='1-guruh' WHERE id=$1", [group]);
  await db.query("UPDATE ua_private.demos SET subject_id='physics',title='Mexanika' WHERE id=$1", [education.demo]);
  await db.query("INSERT INTO ua_private.staff_access VALUES($1,true,false,false,false,false)", [person]);
  await db.query("INSERT INTO ua_private.staff_group_scope VALUES($1,$2,NULL)", [person, group]);
  await db.query("INSERT INTO ua_private.teacher_subject_approvals VALUES($1,'physics',true,NULL)", [person]);

  const origin = 'https://ustoz.example.test';
  const f = await clerkFixture({now:Date.now});
  const userId = 'user_Test0', sessionId = 'sess_Test0';
  const token = await f.sign({userId, sessionId, claims:{azp:origin,iss:issuer}});
  const handler = composeTeacherBrowserPilotPostgres({
    browserOrigin:origin, verifier:{...f.verifier, issuer, authorizedParties:[origin]},
    liveness:async () => ({ issuer,userId,sessionId,status:'active',accountEnabled:true,expiresAt:Date.now()+60000 }),
    catalog:{approvedSubjectTitles:{physics:'Fizika'}, listingPolicy:'approved-subject-assigned-demos'},
    pool:{connect:async () => ({query:({text,values}) => db.query(text,values), release() {}})},
  });
  const read = () => handler(new Request(origin+'/api/v1/teacher/cabinet', {headers:{authorization:'Bearer '+token}}));
  const response = await read();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const {data} = await response.json();
  assert.equal(data.person_id,person);
  assert.deepEqual(data.subjects,['Fizika']);
  assert.deepEqual(data.groups,[{id:group,title:'1-guruh'}]);
  assert.deepEqual(data.tests,[{id:education.assignment,title:'Mexanika'}]);

  await db.query("UPDATE ua_private.test_versions SET status='draft' WHERE id=$1",[education.version]);
  const draft = await read();
  assert.equal(draft.status,200);
  assert.deepEqual((await draft.json()).data.tests,[]);
  await db.query("UPDATE ua_private.test_versions SET status='published' WHERE id=$1",[education.version]);
  await db.query("UPDATE ua_private.groups SET status='archived' WHERE id=$1",[group]);
  const archived = await read();
  assert.equal(archived.status,200);
  const after = (await archived.json()).data;
  assert.deepEqual(after.groups,[]);
  assert.deepEqual(after.tests,[]);
  await db.query("UPDATE ua_private.staff_access SET approved=false WHERE person_id=$1",[person]);
  assert.equal((await read()).status,403);
  await db.query("DELETE FROM ua_private.staff_access WHERE person_id=$1",[person]);
  assert.equal((await read()).status,403);
});
