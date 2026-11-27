import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '../account-deletion/tooling/node_modules/@electric-sql/pglite/dist/index.js';

const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const [owner,source,destination,wrong,group,assignment,attempt,student,testVersion]=[1,2,3,4,5,6,7,8,9].map(id);
const sq=s=>"'"+s+"'";
const key=n=>owner+'/staging/transferGroup/'+createHash('sha256').update(String(n)).digest('hex');
const statement='SELECT ua_cabinet.owner_transfer_group($1,$2,$3,$4,$5,$6) AS value';
const proposal=await readFile(new URL('../../docs/owner-group-transfer.review.sql',import.meta.url),'utf8');

test('local PostgreSQL group transfer is atomic, owner-only and preserves academic history',async()=>{
  const db=new PGlite();
  try{
    await db.waitReady;
    await db.exec(`CREATE SCHEMA ua_private; CREATE SCHEMA ua_cabinet; CREATE ROLE ua_cabinet_stage;
      CREATE TABLE ua_private.people(id uuid PRIMARY KEY, enabled boolean NOT NULL, roles text[] NOT NULL, profile jsonb);
      CREATE VIEW ua_private.people_registration AS SELECT * FROM ua_private.people;
      CREATE TABLE ua_private.staff_access(person_id uuid PRIMARY KEY, approved boolean NOT NULL, all_groups boolean NOT NULL, all_subjects boolean NOT NULL);
      CREATE TABLE ua_private.staff_receipts(actor_id uuid,key text PRIMARY KEY,payload text,response jsonb, UNIQUE(actor_id,key));
      CREATE TABLE ua_private.staff_audit(command_key text PRIMARY KEY,actor_id uuid,action text,target_id uuid,revision bigint,at_ms bigint,
        FOREIGN KEY(actor_id,command_key) REFERENCES ua_private.staff_receipts(actor_id,key) DEFERRABLE INITIALLY DEFERRED);
      ALTER TABLE ua_private.staff_receipts ADD FOREIGN KEY(key) REFERENCES ua_private.staff_audit(command_key) DEFERRABLE INITIALLY DEFERRED;
      CREATE DOMAIN ua_private.safe_counter AS bigint CHECK(VALUE BETWEEN 0 AND 999);
      CREATE TABLE ua_private.groups(id uuid PRIMARY KEY, revision ua_private.safe_counter,status text);
      CREATE TABLE ua_cabinet.group_requests(id uuid PRIMARY KEY, active_group_id uuid UNIQUE, teacher_id uuid, subject_id text, name text);
      CREATE TABLE ua_private.staff_group_scope(person_id uuid,group_id uuid,revoked_at_ms bigint,PRIMARY KEY(person_id,group_id));
      CREATE TABLE ua_private.staff_subject_scope(person_id uuid,subject_id text,revoked_at_ms bigint);
      CREATE TABLE ua_private.teacher_subject_approvals(person_id uuid,subject_id text,approved boolean,revoked_at_ms bigint);
      CREATE TABLE ua_private.assignments(id uuid PRIMARY KEY,group_id uuid,record jsonb);
      CREATE TABLE ua_private.attempts(id uuid PRIMARY KEY,assignment_id uuid,person_id uuid,body jsonb);
      CREATE TABLE ua_private.exam_series(current_attempt_id uuid,person_id uuid);
      CREATE TABLE ua_private.memberships(person_id uuid,affinity_group_id uuid,active boolean,epoch bigint);
      CREATE TABLE ua_cabinet.test_owners(version_id uuid,teacher_id uuid);
      CREATE TABLE ua_private.ordinary_results(attempt_id uuid,exact_result jsonb);
      CREATE TABLE ua_cabinet.invites(digest text PRIMARY KEY,group_id uuid,expires_at timestamptz,created_by uuid);
      CREATE TABLE ua_cabinet.invite_delivery(id uuid,invite_digest text REFERENCES ua_cabinet.invites(digest),status text);
      CREATE TABLE ua_cabinet.redemptions(invite_digest text REFERENCES ua_cabinet.invites(digest),student_id uuid);
      GRANT USAGE ON SCHEMA ua_cabinet TO ua_cabinet_stage;
      INSERT INTO ua_private.people VALUES
        (${sq(owner)},true,ARRAY['owner'],'{}'),(${sq(source)},true,ARRAY['teacher'],'{}'),
        (${sq(destination)},true,ARRAY['teacher'],'{}'),(${sq(wrong)},true,ARRAY['teacher'],'{}');
      INSERT INTO ua_private.staff_access SELECT id,true,false,false FROM ua_private.people;
      INSERT INTO ua_private.groups VALUES (${sq(group)},41,'active');
      INSERT INTO ua_cabinet.group_requests VALUES (${sq(group)},${sq(group)},${sq(source)},'physics','7-A');
      INSERT INTO ua_private.staff_group_scope VALUES (${sq(source)},${sq(group)},NULL),(${sq(destination)},${sq(group)},1);
      INSERT INTO ua_private.staff_subject_scope VALUES (${sq(source)},'physics',NULL),(${sq(destination)},'physics',NULL),(${sq(wrong)},'math',NULL);
      INSERT INTO ua_private.teacher_subject_approvals VALUES (${sq(source)},'physics',true,NULL),(${sq(destination)},'physics',true,NULL),(${sq(wrong)},'math',true,NULL);
      INSERT INTO ua_private.assignments VALUES (${sq(assignment)},${sq(group)},'{"admission":{"opensAt":1,"closesAt":2}}');
      INSERT INTO ua_private.attempts VALUES (${sq(attempt)},${sq(assignment)},${sq(student)},'{"status":"submitted"}');
      INSERT INTO ua_private.exam_series VALUES (${sq(attempt)},${sq(student)});
      INSERT INTO ua_private.ordinary_results VALUES (${sq(attempt)},'{"score":42}');
      INSERT INTO ua_private.memberships VALUES (${sq(student)},${sq(group)},true,7);
      INSERT INTO ua_cabinet.test_owners VALUES (${sq(testVersion)},${sq(source)});
      INSERT INTO ua_cabinet.invites VALUES ('old',${sq(group)},now()+interval '1 day',${sq(source)});
      INSERT INTO ua_cabinet.invite_delivery VALUES (${sq(id(10))},'old','sent');
      INSERT INTO ua_cabinet.redemptions VALUES ('old',${sq(student)});`);
    await db.exec(proposal);
    const command=({actor=owner,dest=destination,rev='41',from=source,token=key(1)}={})=>[actor,group,from,dest,rev,token];
    async function inside(fn,{commit=false,actor=owner,phase='domain',setRole=false,begin='BEGIN'}={}){
      await db.exec(begin);
      try{
        if(setRole)await db.exec('SET LOCAL ROLE ua_cabinet_stage');
        await db.query("SELECT set_config('ua.phase',$1,true),set_config('ua.person_id',$2,true)",[phase,actor]);
        const out=await fn();
        await db.exec(commit?'COMMIT':'ROLLBACK');
        return out;
      }catch(error){await db.exec('ROLLBACK');throw error;}
    }
    const transfer=(input={},options={})=>inside(async()=>(await db.query(statement,command(input))).rows[0].value,options);
    const read=async sql=>(await db.query(sql)).rows[0];
    const snapshot=()=>read(`SELECT
      (SELECT to_jsonb(g) FROM ua_private.groups g) AS canonical,
      (SELECT to_jsonb(r) FROM ua_cabinet.group_requests r) AS request,
      (SELECT jsonb_agg(to_jsonb(s) ORDER BY person_id) FROM ua_private.staff_group_scope s) AS scopes,
      (SELECT to_jsonb(i) FROM ua_cabinet.invites i) AS invite,
      (SELECT count(*)::int FROM ua_private.staff_receipts) AS receipts,
      (SELECT count(*)::int FROM ua_private.staff_audit) AS audits`);
    const academics=()=>read(`SELECT (SELECT to_jsonb(m) FROM ua_private.memberships m) AS membership,
      (SELECT to_jsonb(a) FROM ua_private.assignments a) AS assignment,(SELECT to_jsonb(t) FROM ua_private.attempts t) AS attempt,
      (SELECT to_jsonb(r) FROM ua_private.ordinary_results r) AS result,(SELECT to_jsonb(t) FROM ua_cabinet.test_owners t) AS authorship,
      (SELECT to_jsonb(r) FROM ua_cabinet.redemptions r) AS redemption,
      (SELECT to_jsonb(d) FROM ua_cabinet.invite_delivery d) AS delivery`);
    const before=await snapshot(), historical=await academics();
    await assert.rejects(transfer({}, {setRole:true}),/permission denied/);
    await assert.rejects(transfer({}, {actor:source}),/FORBIDDEN/);
    await assert.rejects(transfer({actor:source,token:source+key(1).slice(owner.length)},{actor:source}),/FORBIDDEN/);
    await assert.rejects(transfer({}, {phase:'auth'}),/FORBIDDEN/);
    for(const sql of ['UPDATE ua_private.staff_access SET approved=false WHERE person_id=$1',
      'UPDATE ua_private.people SET enabled=false WHERE id=$1']){
      await assert.rejects(inside(async()=>{
        await db.query(sql,[owner]); await db.query(statement,command());
      }),/FORBIDDEN/);
    }
    await assert.rejects(inside(async()=>{
      await db.query('UPDATE ua_private.groups SET revision=999 WHERE id=$1',[group]);
      await db.query(statement,command({rev:'999'}));
    }),/GROUP_TRANSFER_REVISION_EXHAUSTED/);
    await assert.rejects(transfer({}, {begin:'BEGIN ISOLATION LEVEL REPEATABLE READ'}),/GROUP_TRANSFER_BUSY/);
    await assert.rejects(transfer({rev:'40'}),/GROUP_TRANSFER_STALE/);
    await assert.rejects(transfer({from:wrong}),/GROUP_TRANSFER_STALE/);
    await assert.rejects(transfer({dest:wrong}),/TEACHER_NOT_ELIGIBLE/);
    await assert.rejects(transfer({dest:source}),/SAME_TEACHER/);
    await assert.rejects(inside(async()=>{
      await db.query("INSERT INTO ua_private.staff_group_scope VALUES($1,$2,NULL)",[wrong,group]);
      await db.query(statement,command());
    }),/GROUP_SCOPE_INCONSISTENT/);
    for (const sql of ['UPDATE ua_private.staff_access SET all_groups=true WHERE person_id=$1',
      'UPDATE ua_private.teacher_subject_approvals SET revoked_at_ms=3 WHERE person_id=$1',
      'UPDATE ua_private.people SET enabled=false WHERE id=$1']){
      await assert.rejects(inside(async()=>{
        await db.query(sql,[destination]); await db.query(statement,command());
      }),/TEACHER_NOT_ELIGIBLE/);
    }
    const future=Date.now()+300000;
    for (const admission of [{opensAt:future,closesAt:future+1000},{opensAt:1,closesAt:future},{}]){
      await assert.rejects(inside(async()=>{
        await db.query('UPDATE ua_private.assignments SET record=$1',[{admission}]);
        await db.query(statement,command());
      }),/OPEN_OR_SCHEDULED_TEST/);
    }
    await assert.rejects(inside(async()=>{
      await db.query('UPDATE ua_private.attempts SET body=$1',[{status:'in_progress',deadlineAt:future}]);
      await db.query(statement,command());
    }),/ACTIVE_TEST_ATTEMPT/);
    await assert.rejects(inside(async()=>{
      await db.exec("ALTER TABLE ua_private.staff_audit ADD CHECK(action<>'transferGroup')");
      await db.query(statement,command());
    }),/check constraint/);
    assert.deepEqual(await snapshot(),before);
    assert.deepEqual(await academics(),historical);
    const expected={groupId:group,sourceTeacherId:source,destinationTeacherId:destination,previousRevision:'41',revision:'42'};
    assert.deepEqual(await transfer(),expected);
    assert.deepEqual(await snapshot(),before);
    assert.deepEqual(await transfer({}, {commit:true}),expected);
    const after=await snapshot();
    assert.equal(after.canonical.id,group); assert.equal(after.canonical.revision,42);
    assert.equal(after.request.teacher_id,destination);
    assert.equal(after.scopes[0].person_id,source); assert.notEqual(after.scopes[0].revoked_at_ms,null);
    assert.equal(after.scopes[1].person_id,destination); assert.equal(after.scopes[1].revoked_at_ms,null);
    assert.ok(Date.parse(after.invite.expires_at)<=Date.now());
    assert.equal(after.receipts,1); assert.equal(after.audits,1);
    assert.deepEqual(await academics(),historical);
    assert.deepEqual(await transfer({}, {commit:true}),expected);
    await assert.rejects(transfer({rev:'42'}),/IDEMPOTENCY_CONFLICT/);
    assert.deepEqual(await snapshot(),after);
    await transfer({from:destination,dest:source,rev:'42',token:key(2)}, {commit:true});
    assert.equal((await snapshot()).invite.expires_at,after.invite.expires_at,'returning old owner does not revive invite');
  }finally{await db.close();}
});
