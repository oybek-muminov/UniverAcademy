import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand, switchPhase, backfill } from '../../supabase/migrations/cabinet-id/migrate.mjs';
import { readStoredProfile } from '../../supabase/functions/univeracademy-api/storage/stored-profile.ts';
import { nativeFixture } from './native-fixture.mjs';

const legacy = 'qadam_id';
const current = 'univeracademy_id';
function profile(id, key, cabinetId) {
  return { person_id: id, first_name: 'Ali', last_name: '', roles: ['student'],
    registration_complete: false, active_group_id: null, [key]: cabinetId };
}

test('canonical and legacy stored profiles preserve nulls, leading zeros and detect conflicts', () => {
  const id=crypto.randomUUID();
  assert.deepEqual(readStoredProfile(profile(id,legacy,'0000000001')),profile(id,current,'0000000001'));
  assert.deepEqual(readStoredProfile(profile(id,legacy,null)),profile(id,current,null));
  assert.throws(()=>readStoredProfile({...profile(id,legacy,'0000000001'),[current]:'0000000002'}));
  assert.throws(()=>readStoredProfile(profile(id,current,1)));
});

test('registration, online conversion and rollback preserve the original unique ID and privileges',
  {skip: !process.env.UA_SCHEMA_NATIVE_URL}, async t => {
    const { admin, pool, close } = await nativeFixture();
    t.after(close);
    async function insert(key, cabinetId, shape={}) {
      const c=await pool.connect(), id=crypto.randomUUID();
      const table=key===legacy?'people':'people_registration';
      const value={...profile(id,key,cabinetId),...shape};
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('ua.phase','exchange',true),set_config('ua.person_id',$1,true),
          set_config('ua.person_ids',$2,true),set_config('ua.telegram_id','',true),
          set_config('ua.clerk_issuer','https://auth.example',true),set_config('ua.clerk_subject','user_Fixture',true)`, [id, JSON.stringify([id])]);
        const rows=await c.query(`INSERT INTO ua_private.${table}(id,telegram_id,${key},enabled,roles,profile)
          VALUES ($1,NULL,$2,true,ARRAY['student'],$3::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[id,cabinetId,value]);
        if (rows.rowCount) {
          await c.query('INSERT INTO ua_private.memberships(person_id,active,epoch,revision,affinity_group_id) VALUES($1,false,0,0,NULL)',[id]);
        }
        await c.query('COMMIT');
        return rows.rows[0]?.id ?? null;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally { c.release(); }
    }
    async function updateProfile(id, key, firstName) {
      const c=await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('ua.phase','domain',true),set_config('ua.person_id',$1,true),
          set_config('ua.person_ids',$2,true),set_config('ua.telegram_id','',true),
          set_config('ua.clerk_issuer','https://auth.example',true),set_config('ua.clerk_subject','user_Editor',true)`,[id,JSON.stringify([id])]);
        const body={...profile(id,key,'0000000022'),first_name:firstName,last_name:'Test',registration_complete:true};
        assert.equal((await c.query('UPDATE ua_private.people SET profile=$1::jsonb WHERE id=$2 RETURNING id',[body,id])).rowCount,1);
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally { c.release(); }
    }
    const stored = async (id) => (await admin.query('SELECT profile FROM ua_private.people WHERE id=$1',[id])).rows[0].profile;
    const original = await insert(legacy,'0000000021');
    const oid = async (column) => (await admin.query("SELECT conindid FROM pg_constraint WHERE conrelid='ua_private.people'::regclass AND conname=$1",['people_'+column+'_key'])).rows[0].conindid;
    const uniqueIndex = await oid(legacy);
    await expand(admin);
    await expand(admin);
    const bridged = await insert(current,'0000000022');
    assert.deepEqual(await stored(bridged),profile(bridged,legacy,'0000000022'));
    await admin.query('INSERT INTO ua_private.clerk_identities(issuer,subject,person_id,enabled) VALUES($1,$2,$3,true)',
      ['https://auth.example','user_Editor',bridged]);
    await updateProfile(bridged,legacy,'Old reader');
    await updateProfile(bridged,current,'New reader');
    assert.equal((await stored(bridged))[legacy],'0000000022');
    const oldWriter = await insert(legacy,'0000000023');
    assert.equal(await insert(current,'0000000021'),null);
    await assert.rejects(insert(current,'0000000024',{[legacy]:'0000000025'}),e=>e.code==='23514');
    await assert.rejects(insert(current,'0000000024',{unexpected:1}),e=>e.code==='42501');
    const reader=await pool.connect();
    try { assert.equal((await reader.query('SELECT id FROM ua_private.people_registration')).rowCount,0); }
    finally { reader.release(); }
    await switchPhase(admin,'forward');
    await switchPhase(admin,'forward');
    assert.equal(await oid(current),uniqueIndex);
    assert.equal(readStoredProfile(await stored(original)).univeracademy_id,'0000000021');
    const fresh=await insert(current,'0000000024');
    assert.deepEqual(await stored(fresh),profile(fresh,current,'0000000024'));
    assert.equal(await insert(current,'0000000022'),null);
    await assert.rejects(insert(current,'0000000025',{unexpected:1}),e=>e.code==='42501');
    await updateProfile(bridged,current,'After switch');
    assert.equal((await stored(bridged))[current],'0000000022');
    assert.equal(await backfill(admin,1),2);
    assert.equal(await backfill(admin,2),0);
    assert.deepEqual(await stored(original),profile(original,current,'0000000021'));
    assert.deepEqual(await stored(oldWriter),profile(oldWriter,current,'0000000023'));
    await switchPhase(admin,'rollback');
    assert.equal(await oid(legacy),uniqueIndex);
    const recovering=await insert(current,'0000000025');
    assert.deepEqual(await stored(recovering),profile(recovering,legacy,'0000000025'));
    assert.equal(await backfill(admin,2),4);
    assert.deepEqual(await stored(fresh),profile(fresh,legacy,'0000000024'));
    assert.equal(await insert(legacy,'0000000021'),null);
    assert.ok(await insert(legacy,'0000000026'));
    assert.equal((await stored(bridged)).first_name,'After switch');
    await updateProfile(bridged,legacy,'After rollback');
    assert.equal((await stored(bridged)).first_name,'After rollback');
  });
