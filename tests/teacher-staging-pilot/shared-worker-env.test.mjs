import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createReturningBotWorker } from '../../apps/telegram-bot/src/returning-worker.mjs';
import { createCloudflareEntrypoint } from '../../runtime/cloudflare-entry.mjs';
import { createTelegramDirectory } from '../../runtime/cloudflare-telegram-directory.mjs';
import { deletionReceiptHash } from '../../supabase/functions/univeracademy-api/account-deletion.ts';
import { botKey, signedInitData, testPolicy } from '../backend/http-fixture.ts';
import { createCluster, createServiceLogin } from './cluster.mjs';
import { issuer, provisionStudent, testClerk } from './credentials.mjs';
import { apiOrigin, studentOrigin } from './requests.mjs';

test('normal API, bot directory and deletion status coexist with unread pilot bindings', async t => {
  const cluster = await createCluster();
  t.after(() => cluster.close());
  await cluster.installDeletion();
  const db = cluster.admin;
  const registrationUrl = await createServiceLogin(cluster, 'qa_shared_api', [{role:'ua_api_login',inherit:true,set:false}]);
  const deletionUrl = await createServiceLogin(cluster, 'ua_deletion_request_login', []);
  await db.query('GRANT USAGE ON SCHEMA ua_private TO ua_deletion_request_login');
  await db.query('GRANT EXECUTE ON FUNCTION ua_private.account_deletion_status(text) TO ua_deletion_request_login');
  const clerk = await testClerk();
  const student = await provisionStudent(db, 'Sardor', '0000000017', 710300031, {clerk});
  const web = 'https://web.shared-class.example.com';
  const env = {
    UA_API_ORIGIN:apiOrigin, UA_ALLOWED_ORIGINS:JSON.stringify([studentOrigin,web]),
    UA_SESSION_POLICY:JSON.stringify({...testPolicy,accessTtlMs:300000,familyTtlMs:600000}),
    UA_CLERK_PROVIDER_SETTINGS:JSON.stringify({issuer,authorizedParties:[web,studentOrigin],audience:{kind:'clerk_default_no_audience'}}),
    UA_CLERK_SECRET_KEY:'local-clerk-fixture', UA_TELEGRAM_BOT_TOKEN:botKey,
    UA_TELEGRAM_ATOMIC_ENTRY_ENABLED:'true', UA_TELEGRAM_ATOMIC_AUTHORIZED_PARTIES:JSON.stringify([studentOrigin]),
    UA_TELEGRAM_LOOKUP_TIMEOUT_MS:'5000', UA_TELEGRAM_START_MODE:'database',
    HYPERDRIVE:{connectionString:registrationUrl},
    UA_DELETION_REQUEST_ENABLED:'true', HYPERDRIVE_DELETION_REQUEST:{connectionString:deletionUrl}
  };
  const reads = [];
  for (const key of [
    'UA_CABINET_STAGING_ENABLED','UA_CABINET_STAGING_NODE_ORIGIN','UA_CABINET_STAGING_PROXY_SECRET',
    'UA_CABINET_RUNTIME','CABINET_HYPERDRIVE','UA_CABINET_TEACHER_ORIGIN','UA_CABINET_ALLOW_LEGACY_TELEGRAM',
    'UA_CABINET_STUDENT_ORIGIN','UA_TELEGRAM_PILOT_DIRECTORY_ENABLED','UA_TELEGRAM_PILOT_DISPATCH_ENABLED','TEACHER_PILOT_HYPERDRIVE'
  ]) {
    Object.defineProperty(env, key, {enumerable:true, get() { reads.push(key); throw Error('Unexpected pilot binding read'); }});
  }
  let clientLoads = 0;
  const worker = createCloudflareEntrypoint({
    loadClient:async () => { clientLoads++; return pg.Client; },
    makeClerk:async settings => ({verifier:{...clerk.verifier,authorizedParties:settings.authorizedParties},liveness:clerk.liveness,close:async()=>{}}),
    transport:async()=>assert.fail('Unexpected external transport.')
  });
  function call(method, path, token, body, origin=web) {
    return worker.fetch(new Request(apiOrigin+'/api/v1'+path, {
      method, headers:{origin,authorization:'Bearer '+token,'content-type':'application/json'},
      ...(body===undefined ? {} : {body:JSON.stringify(body)})
    }),env);
  }
  async function ok(response) {
    const r = await response, data = await r.json();
    assert.equal(r.status,200,JSON.stringify(data)); return data;
  }
  const login = (await ok(call('POST','/auth/clerk',await clerk.sign(student.subject,{azp:web}),{}))).data;
  assert.equal((await ok(call('GET','/me',login.access_token))).data.person_id,student.id);
  assert.deepEqual((await ok(call('GET','/exams',login.access_token))).data,[]);
  const atomic = await ok(call('POST','/auth/telegram/entry',await clerk.sign(student.subject,{azp:studentOrigin,fva:[0,-1]}),{
    confirmation:'link-telegram-account-v1',init_data:signedInitData(student.telegramId,randomUUID(),Date.now())
  },studentOrigin));
  assert.equal(atomic.data.profile.person_id,student.id);

  // Exercise the bot's existing service binding with the exact same API environment.
  const directory = createTelegramDirectory({loadClient:async()=>pg.Client});
  const webhookSecret = randomBytes(24).toString('hex');
  const cabinet = studentOrigin+'/';
  const botReply = await ok(createReturningBotWorker().fetch(new Request('https://bot.example.com/telegram/webhook',{
    method:'POST', headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':webhookSecret},
    body:JSON.stringify({update_id:1,message:{message_id:1,date:Math.floor(Date.now()/1000),from:{is_bot:false,id:student.telegramId},
      chat:{id:student.telegramId,type:'private'},text:'/start'}})
  }),{TELEGRAM_WEBHOOK_SECRET:webhookSecret,MINI_CABINET_URL:cabinet,MINI_SIGN_IN_URL:studentOrigin+'/sign-in',
    TELEGRAM_START_LOOKUP:{lookupTelegramStart:input=>directory.lookupTelegramStart(input,env)}}));
  assert.equal(botReply.reply_markup.inline_keyboard[0][0].web_app.url,cabinet);

  const receipt = randomBytes(32).toString('base64url');
  await db.query("INSERT INTO ua_private.account_deletion_jobs(id,person_id,issuer,subject,receipt_digest,state,created_at_ms) VALUES($1,$2,$3,$4,$5,'pending',$6)",
    [randomUUID(),randomUUID(),issuer,'user_OtherFixture',await deletionReceiptHash(receipt),Date.now()]);
  const status = await ok(worker.fetch(new Request(apiOrigin+'/api/v1/me/deletion/status',{
    headers:{origin:studentOrigin,'x-deletion-receipt':receipt}
  }),env));
  assert.deepEqual(status,{status:'pending'});

  const before = clientLoads;
  env.UA_TELEGRAM_UNREVIEWED_PILOT = 'true';
  const refused = await call('GET','/me',login.access_token);
  assert.equal(refused.status,503);
  assert.equal((await refused.json()).error.code,'SERVICE_UNAVAILABLE');
  assert.equal(clientLoads,before);
  assert.deepEqual(reads,[]);
});
