import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { PostgresTransactions } from '../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts';
import { registrationInsertTarget } from '../../supabase/functions/univeracademy-api/storage/stored-profile.ts';
import { StudentIdentityRows } from '../../supabase/functions/univeracademy-api/storage/student-identity-rows.ts';
import { transactionPoolPort } from '../../supabase/functions/univeracademy-api/storage/transaction-pool-port.ts';
import { STUDENT_PROFILE_ACCEPT } from '../../packages/api-client/student-client.ts';
import { createCloudflareEntrypoint } from '../../runtime/cloudflare-entry.mjs';
import { backfill,expand,switchPhase } from '../../supabase/migrations/cabinet-id/migrate.mjs';
import { botKey,signedInitData,testPolicy } from '../backend/http-fixture.ts';
import { createCluster,createServiceLogin } from '../teacher-staging-pilot/cluster.mjs';
import { testClerk,issuer } from '../teacher-staging-pilot/credentials.mjs';

const apiOrigin='https://api.registration.example.com',mini='https://mini.registration.example.com';
const site='https://web.registration.example.com',legacyAccept='application/json';
const legacy='qadam_id',canonical='univeracademy_id';

async function registrationWorker(cluster) {
  const clerk=await testClerk();
  const url=await createServiceLogin(cluster,'qa_registration',[{role:'ua_api_login',inherit:true,set:false}]);
  const permissions=await cluster.admin.query(`SELECT has_schema_privilege('qa_registration','ua_private','CREATE') can_create,
    pg_has_role('qa_registration','ua_owner','MEMBER') owner`);
  assert.deepEqual(permissions.rows[0],{can_create:false,owner:false});
  const settings={issuer,authorizedParties:[mini,site],audience:{kind:'clerk_default_no_audience'}};
  const env={
    UA_API_ORIGIN:apiOrigin,UA_ALLOWED_ORIGINS:JSON.stringify([mini,site]),UA_TELEGRAM_BOT_TOKEN:botKey,
    UA_SESSION_POLICY:JSON.stringify({...testPolicy,accessTtlMs:300000,familyTtlMs:600000}),
    UA_CLERK_PROVIDER_SETTINGS:JSON.stringify(settings),UA_CLERK_SECRET_KEY:'offline-provider-double',
    UA_TELEGRAM_ATOMIC_ENTRY_ENABLED:'true',UA_TELEGRAM_ATOMIC_AUTHORIZED_PARTIES:JSON.stringify([mini]),
    HYPERDRIVE:{connectionString:url}
  };
  const worker=createCloudflareEntrypoint({
    loadClient:async()=>pg.Client,
    makeClerk:async requestSettings=>({verifier:{...clerk.verifier,authorizedParties:requestSettings.authorizedParties},
      liveness:clerk.liveness,close:async()=>{}}),
    transport:async()=>assert.fail('Test provider and native loopback PostgreSQL require no external transport.')
  });
  async function call(method,path,token,accept,body,origin=mini) {
    const headers={origin,authorization:'Bearer '+token,accept};
    if (body) headers['content-type']='application/json';
    const response=await worker.fetch(new Request(apiOrigin+'/api/v1'+path,{
      method,headers,...(body?{body:JSON.stringify(body)}:{})
    }),env);
    const json=await response.json();
    assert.equal(response.status,200,method+' '+path+' '+JSON.stringify(json));
    assert.ok(response.headers.get('vary')?.toLowerCase().includes('accept'));
    if(accept===STUDENT_PROFILE_ACCEPT) assert.match(response.headers.get('content-type'),/profile=univeracademy-id-v2/);
    return json.data;
  }
  return {
    database:url,
    plainTelegram:raw=>worker.fetch(new Request(apiOrigin+'/api/v1/auth/telegram',{
      method:'POST',headers:{origin:mini,'content-type':'application/json'},body:JSON.stringify({init_data:raw})
    }),env),
    async enter(telegramId,accept) {
      const proof=await clerk.sign('user_Telegram'+telegramId,{azp:mini,fva:[0,-1]});
      return call('POST','/auth/telegram/entry',proof,accept,{
        confirmation:'link-telegram-account-v1',init_data:signedInitData(telegramId,randomUUID(),Date.now())
      });
    },
    async web(subject,accept) {
      return call('POST','/auth/clerk',await clerk.sign(subject,{azp:site}),accept,{},site);
    },
    me:(session,accept)=>call('GET','/me',session.access_token,accept),
    complete:(session,accept,name)=>call('PATCH','/me',session.access_token,accept,{first_name:name,last_name:'Sinov'})
  };
}
function exactId(profile,key,expected) {
  assert.ok(Object.hasOwn(profile,key),JSON.stringify(profile));
  assert.ok(!Object.hasOwn(profile,key===canonical?legacy:canonical),JSON.stringify(profile));
  assert.match(profile[key],/^\d{10}$/);
  if(expected!==undefined) assert.equal(profile[key],expected);
  return profile[key];
}
async function stored(db,person,key) {
  const row=(await db.query('SELECT profile,to_jsonb(p) AS physical FROM ua_private.people p WHERE id=$1',[person])).rows[0];
  assert.ok(row,'Expected an actual canonical person row');
  assert.ok(Object.hasOwn(row.physical,key));
  return row;
}

// Existing accounts can already have leading zeros. The verifier binds this synthetic
// historical person to a real Clerk subject; API requests still use the restricted login.
async function historicalAccount(db) {
  const person=randomUUID(),subject='user_HistoricalProfile',cabinetId='0000012304';
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO ua_private.people(id,telegram_id,qadam_id,enabled,roles,profile)
      VALUES ($1,NULL,$2,true,ARRAY['student'],$3)`,[person,cabinetId,{
        person_id:person,first_name:'Tarixiy',last_name:'',roles:['student'],
        registration_complete:false,active_group_id:null,qadam_id:cabinetId
      }]);
    await db.query('INSERT INTO ua_private.memberships(person_id,active,epoch,revision) VALUES ($1,false,0,0)',[person]);
    await db.query('INSERT INTO ua_private.clerk_identities(issuer,subject,person_id,enabled) VALUES($1,$2,$3,true)',[issuer,subject,person]);
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  return {person,subject,cabinetId};
}

test('real Worker registration/profile routes keep both wire formats through the legacy, expand and forward phases',async t=>{
  const cluster=await createCluster({expandCabinetId:false});
  t.after(()=>cluster.close());
  const db=cluster.admin,web=await registrationWorker(cluster);
  const oldTelegram=710200031,expandedTelegram=710200032,forwardTelegram=710200033;
  const history=await historicalAccount(db);
  let previous,bridge,bridgeId;
  await t.test('schema detection holds AccessShareLock on people until the caller commits',async()=>{
    const connection=new pg.Client({connectionString:web.database});
    await connection.connect();
    try {
      const {rows:[{pid}]}=await connection.query('SELECT pg_backend_pid() AS pid');
      const locks=async()=>(await db.query(`SELECT mode FROM pg_locks WHERE pid=$1 AND locktype='relation'
        AND relation='ua_private.people'::regclass AND granted`,[pid])).rows.map(row=>row.mode);
      assert.deepEqual(await locks(),[]);
      await connection.query('BEGIN');
      const target=await registrationInsertTarget(connection);
      assert.match(target.insert,/INSERT INTO ua_private\.people\(/);
      assert.ok((await locks()).includes('AccessShareLock'));
      await connection.query('COMMIT');
      assert.deepEqual(await locks(),[]);
    } finally {await connection.end();}
  });
  await t.test('unexpanded catalog: an existing zero-prefixed ID survives name completion on the original RLS policy and JSON constraint',async()=>{
    previous=await web.web(history.subject,legacyAccept);
    exactId(previous.profile,legacy,history.cabinetId);
    exactId(await web.me(previous,STUDENT_PROFILE_ACCEPT),canonical,history.cabinetId);
    const updated=await web.complete(previous,STUDENT_PROFILE_ACCEPT,'Ali');
    assert.equal(updated.registration_complete,true);
    exactId(updated,canonical,history.cabinetId);
    const row=await stored(db,history.person,legacy);
    assert.equal(row.profile.first_name,'Ali');
    exactId(row.profile,legacy,history.cabinetId);
  });
  await t.test('unexpanded catalog: real atomic registration mints a ten-digit ID and completes the profile against the original constraints',async()=>{
    const [raw]=(await db.query("SELECT to_regclass('ua_private.people_registration') AS bridge")).rows;
    assert.equal(raw.bridge,null);
    const initial=await web.enter(oldTelegram,legacyAccept);
    const id=exactId(initial.profile,legacy);
    assert.equal(initial.profile.registration_complete,false);
    const completed=await web.complete(initial,STUDENT_PROFILE_ACCEPT,'Ali');
    assert.equal(completed.registration_complete,true);
    exactId(completed,canonical,id);
    const row=await stored(db,initial.profile.person_id,legacy);
    assert.equal(row.physical[legacy],id);
    exactId(row.profile,legacy,id);
    assert.equal(row.profile.first_name,'Ali');
    exactId(await web.me(initial,legacyAccept),legacy,id);
    exactId(await web.me(initial,STUDENT_PROFILE_ACCEPT),canonical,id);

    const siteSession=await web.web('user_WebBeforeExpand',STUDENT_PROFILE_ACCEPT);
    const siteId=exactId(siteSession.profile,canonical);
    assert.notEqual(siteId,id);
    exactId(await web.complete(siteSession,legacyAccept,'Web'),legacy,siteId);
    exactId((await stored(db,siteSession.profile.person_id,legacy)).profile,legacy,siteId);
  });

  await t.test('Telegram without Clerk stays outside the registration-only Worker and the unchanged legacy catalog refuses a bare identity insert',async()=>{
    const reservedId=710200039,raw=signedInitData(reservedId,randomUUID(),Date.now());
    const disabled=await web.plainTelegram(raw);
    assert.equal(disabled.status,503);
    assert.equal((await disabled.json()).error.code,'SERVICE_UNAVAILABLE');
    const pool=new pg.Pool({connectionString:web.database,max:1});
    try {
      const runner=new PostgresTransactions(transactionPoolPort(pool)),rows=new StudentIdentityRows();
      await assert.rejects(runner.runIdentity(reservedId,
        gate=>rows.ensure(gate,raw,{botToken:botKey,sessionPolicy:testPolicy}),
        async()=>assert.fail('Canonical original schema must not mint an unbound Telegram-only identity.')),
        error=>error.code==='42501' && /row-level security policy/.test(error.message));
    } finally {await pool.end();}
    const query=await db.query('SELECT id FROM ua_private.people WHERE telegram_id=$1',[reservedId]);
    assert.equal(query.rowCount,0);
  });

  await t.test('expand enables both build generations on the same physical legacy key and same real account',async()=>{
    await expand(db);
    bridge=await web.enter(expandedTelegram,STUDENT_PROFILE_ACCEPT);
    bridgeId=exactId(bridge.profile,canonical);
    exactId(await web.complete(bridge,legacyAccept,'Madina'),legacy,bridgeId);
    exactId((await stored(db,bridge.profile.person_id,legacy)).profile,legacy,bridgeId);
    previous=await web.web(history.subject,STUDENT_PROFILE_ACCEPT);
    assert.equal(previous.profile.person_id,history.person);
    exactId(previous.profile,canonical,history.cabinetId);
  });

  await t.test('after switching, old JSON remains readable before the backfill, new writes persist canonical JSON and historical IDs survive',async()=>{
    await switchPhase(db,'forward');
    const row=await stored(db,history.person,canonical);
    assert.equal(row.physical[canonical],history.cabinetId);
    exactId(row.profile,legacy,history.cabinetId);
    exactId(await web.me(previous,STUDENT_PROFILE_ACCEPT),canonical,history.cabinetId);
    exactId(await web.me(previous,legacyAccept),legacy,history.cabinetId);
    const fresh=await web.enter(forwardTelegram,STUDENT_PROFILE_ACCEPT);
    const newId=exactId(fresh.profile,canonical);
    assert.equal(fresh.profile.registration_complete,false);
    exactId(await web.complete(fresh,legacyAccept,'Aziza'),legacy,newId);
    exactId((await stored(db,fresh.profile.person_id,canonical)).profile,canonical,newId);
    assert.ok(await backfill(db,10)>0);
    exactId((await stored(db,history.person,canonical)).profile,canonical,history.cabinetId);
    exactId((await stored(db,bridge.profile.person_id,canonical)).profile,canonical,bridgeId);
    exactId(await web.me(previous,legacyAccept),legacy,history.cabinetId);
    exactId(await web.me(bridge,STUDENT_PROFILE_ACCEPT),canonical,bridgeId);
  });
});
