import test from 'node:test';import assert from 'node:assert/strict';
import {createTelegramRegisterApi,telegramRegisterEnabled} from '../../runtime/telegram-register-api.mjs';
import {createTelegramClerkEntryApi} from '../../runtime/telegram-clerk-entry-api.mjs';
import {createClerkRegisterTransport} from '../../runtime/telegram-register-clerk.mjs';
import {createCloudflareEntrypoint} from '../../runtime/cloudflare-entry.mjs';
import {registerName,createRegisterLimiter} from '../../supabase/functions/univeracademy-api/telegram-register.ts';
import {TelegramRegisterRows} from '../../supabase/functions/univeracademy-api/storage/telegram-register-rows.ts';
import {testPolicy,botKey,clock,signedInitData} from '../backend/http-fixture.ts';

const mini='https://mini.example.com',api='https://api.example.com',issuer='https://clerk.example.com';
const settings={issuer,authorizedParties:[mini],audience:{kind:'clerk_default_no_audience'}};
const env=(extra={})=>({UA_TELEGRAM_REGISTER_ENABLED:'true',...extra});
const body=(over={})=>JSON.stringify({init_data:signedInitData(4000000001,'q-'+Math.random()),first_name:'Aziz',last_name:'Karimov',...over});
const request=(b=body(),headers={})=>new Request(api+'/api/v1/auth/telegram/register',{method:'POST',headers:{origin:mini,'content-type':'application/json',...headers},body:b});

/** In-memory Clerk + directory that behave like the real services for these checks. */
function world({linked=new Set(),mapped=new Set(),allow}={}){
  const users=[],events=[];let n=0;
  const clerk={
    async findByExternalId(ext){events.push('find');await null;return users.filter(u=>u.external_id===ext).map(u=>({id:u.id}));},
    async createUser({externalId,firstName,lastName}){events.push('create');await null;
      if(users.some(u=>u.external_id===externalId))return 'exists'; // Clerk keeps external_id unique
      const u={id:'user_'+(++n),external_id:externalId,first_name:firstName,last_name:lastName};users.push(u);return {id:u.id};},
    async createSignInToken(id,seconds){events.push('ticket');assert.ok(seconds>=120&&seconds<=300);return 'ticket_'+id;},
  };
  const rows={telegramLinked:async id=>{events.push('linked?');return linked.has(id);},clerkMapped:async id=>{events.push('mapped?');return mapped.has(id);}};
  const registerApi=createTelegramRegisterApi({allowedOrigins:[mini],now:()=>clock,transport:async()=>{throw Error('no network')},
    getBindings:()=>({settings,secretKey:'sk_fixture',botToken:botKey,sessionPolicy:testPolicy,postgres:{connectionString:'x'}}),
    loadClient:async()=>class{},makePostgres:()=>({pool:{},close:async()=>events.push('db-close')}),
    makeClerk:()=>clerk,makeRows:()=>rows,allow:allow??createRegisterLimiter({now:()=>clock})});
  return {api:registerApi,users,events};
}
const json=async r=>({status:r.status,body:await r.json()});

test('new student: one Clerk account with the typed names, only a ticket is returned',async()=>{
  const w=world();const r=await json(await w.api.fetch(request(),env()));
  assert.equal(r.status,200);assert.deepEqual(r.body,{status:'ticket',ticket:'ticket_user_1'});
  assert.equal(w.users.length,1);assert.deepEqual(w.users[0],{id:'user_1',external_id:'tg:4000000001',first_name:'Aziz',last_name:'Karimov'});
  assert.deepEqual(Object.keys(r.body).sort(),['status','ticket']);
});
test('double tap (sequential and concurrent) never creates a second Clerk account',async()=>{
  const w=world();
  await w.api.fetch(request(),env());await w.api.fetch(request(),env());
  await Promise.all([w.api.fetch(request(),env()),w.api.fetch(request(),env())]);
  assert.equal(w.users.length,1);
});
test('already registered Telegram: nothing created, resume is advised',async()=>{
  const w=world({linked:new Set([4000000001])});const r=await json(await w.api.fetch(request(),env()));
  assert.deepEqual(r.body,{status:'already_registered'});assert.equal(w.users.length,0);assert.ok(!w.events.includes('find'));
});
test('Clerk account already tied to another cabinet is a conflict, no ticket',async()=>{
  const w=world({mapped:new Set(['user_1'])});const r=await json(await w.api.fetch(request(),env()));
  assert.equal(r.status,409);assert.equal(r.body.error.code,'IDENTITY_LINK_CONFLICT');assert.ok(!w.events.includes('ticket'));
});
test('invalid, tampered or expired init_data is rejected before Clerk or database',async()=>{
  for(const init of ['garbage',signedInitData().replace('4000000001','4000000002'),signedInitData(4000000001,'old',clock-(testPolicy.initDataMaxAgeSeconds+5)*1000)]){
    const w=world();const r=await json(await w.api.fetch(request(body({init_data:init})),env()));
    assert.equal(r.status,401,init);assert.match(r.body.error.code,/^INIT_DATA_/);assert.deepEqual(w.events,[]);
  }
});
test('bad names are rejected; good Uzbek names are accepted and tidied',async()=>{
  for(const [first,last] of [['',"Karimov"],['   ','Karimov'],['A'.repeat(65),'Karimov'],['Aziz1','Karimov'],['Aziz\u0000','K'],['Aziz','<b>'],['Aziz','😀'],['Aziz','a‮b'],[5,'K']]){
    const w=world();const r=await json(await w.api.fetch(request(body({first_name:first,last_name:last})),env()));
    assert.equal(r.status,422,JSON.stringify([first,last]));assert.deepEqual(w.events,[]);
  }
  assert.equal(registerName('  O‘g‘iloy  '),'O‘g‘iloy');assert.equal(registerName("Sa'dulla"),"Sa'dulla");
  assert.equal(registerName('Abdulla  Qodiriy'),'Abdulla Qodiriy');assert.equal(registerName('Ahmad-Jon'),'Ahmad-Jon');
  assert.equal(registerName('Gʻulom'),'Gʻulom');assert.equal(registerName('Иван'),'Иван');assert.equal(registerName('A'.repeat(64)),'A'.repeat(64));
});
test('extra or missing body fields are rejected',async()=>{
  const w=world();
  assert.equal((await w.api.fetch(request(JSON.stringify({init_data:'x',first_name:'A'})),env())).status,422);
  assert.equal((await w.api.fetch(request(JSON.stringify({init_data:'x',first_name:'A',last_name:'B',telegram_id:1})),env())).status,422);
  assert.equal((await w.api.fetch(request('{bad'),env())).status,400);
});
test('rate limit: 5 per 10 minutes per Telegram ID',async()=>{
  let t=clock;const limiter=createRegisterLimiter({now:()=>t});const w=world({allow:limiter});
  for(let i=0;i<5;i++)assert.equal((await w.api.fetch(request(),env())).status,200);
  const r=await json(await w.api.fetch(request(),env()));assert.equal(r.status,429);assert.equal(r.body.error.code,'RATE_LIMITED');
  t+=600001;assert.equal(limiter(4000000001),true);
});
test('default off, wrong origin, preflight: no private work at all',async()=>{
  const w=world();
  assert.equal((await w.api.fetch(request(),{})).status,404);
  assert.equal((await w.api.fetch(request(),{UA_TELEGRAM_REGISTER_ENABLED:'false'})).status,404);
  assert.equal((await w.api.fetch(request(),{UA_TELEGRAM_REGISTER_ENABLED:'yes'})).status,503);
  assert.equal((await w.api.fetch(request(body(),{origin:'https://evil.example'}),env())).status,403);
  assert.equal((await w.api.fetch(new Request(api+'/api/v1/auth/telegram/register',{method:'OPTIONS',headers:{origin:mini}}),env())).status,204);
  assert.deepEqual(w.events,[]);assert.equal(telegramRegisterEnabled({}),false);
});
test('register flag opens /auth/telegram/entry without atomic-mode side effects',async()=>{
  const entry=createTelegramClerkEntryApi({allowedOrigins:[mini],getBindings:()=>{throw Error('stop here')},loadClient:async()=>class{},makeClerk:async()=>({}),transport:async()=>{}});
  const req=()=>new Request(api+'/api/v1/auth/telegram/entry',{method:'OPTIONS',headers:{origin:mini}});
  assert.equal((await entry.fetch(req(),{})).status,404);
  assert.equal((await entry.fetch(req(),{UA_TELEGRAM_REGISTER_ENABLED:'true'})).status,204);
});
test('Worker entry accepts the new flag in its environment and routes the path',async()=>{
  const worker=createCloudflareEntrypoint({now:()=>clock,loadClient:async()=>class{},makeClerk:async()=>({close:async()=>{}}),transport:async()=>{throw Error('no network')}});
  const bindings={UA_API_ORIGIN:api,UA_ALLOWED_ORIGINS:JSON.stringify([mini]),UA_SESSION_POLICY:JSON.stringify(testPolicy),UA_CLERK_PROVIDER_SETTINGS:JSON.stringify(settings),
    UA_CLERK_SECRET_KEY:'fixture',HYPERDRIVE:{connectionString:'postgres://f:f@hyperdrive.invalid:5432/f'},UA_TELEGRAM_BOT_TOKEN:botKey,UA_TELEGRAM_REGISTER_ENABLED:'true'};
  // Invalid name is rejected by the routed handler (422), proving routing + env allow-list.
  assert.equal((await worker.fetch(request(body({first_name:''})),bindings)).status,422);
  delete bindings.UA_TELEGRAM_REGISTER_ENABLED;
  assert.equal((await worker.fetch(request(),bindings)).status,404);
});
test('Clerk transport: exact calls, no password, no email, secret only in header',async()=>{
  const seen=[];const reply=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{'content-type':'application/json'}});
  const t=createClerkRegisterTransport({secretKey:'sk_x',transport:async r=>{
    seen.push({m:r.method,u:r.url,a:r.headers.get('authorization'),b:r.method==='POST'?await r.json():null});
    if(r.url.includes('/users?'))return reply([{id:'user_A',external_id:'tg:7'},{id:'user_B',external_id:'tg:77'}]);
    if(r.url.endsWith('/users'))return reply({id:'user_C',external_id:'tg:7'});
    return reply({object:'sign_in_token',user_id:'user_C',token:'tok123',status:'pending'});}});
  assert.deepEqual(await t.findByExternalId('tg:7'),[{id:'user_A'}]);
  assert.deepEqual(await t.createUser({externalId:'tg:7',firstName:'A',lastName:'B'}),{id:'user_C'});
  assert.equal(await t.createSignInToken('user_C',180),'tok123');
  assert.equal(seen[0].u,'https://api.clerk.com/v1/users?external_id=tg%3A7&limit=10');
  assert.deepEqual(seen[1].b,{external_id:'tg:7',first_name:'A',last_name:'B',skip_password_requirement:true});
  assert.deepEqual(seen[2].b,{user_id:'user_C',expires_in_seconds:180});
  assert.ok(seen.every(s=>s.a==='Bearer sk_x'));
  const dup=createClerkRegisterTransport({secretKey:'sk_x',transport:async()=>reply({errors:[]},422)});
  assert.equal(await dup.createUser({externalId:'tg:7',firstName:'A',lastName:'B'}),'exists');
  const down=createClerkRegisterTransport({secretKey:'sk_x',transport:async()=>reply({},500)});
  await assert.rejects(down.createSignInToken('user_C',180),e=>e.status===503);
});
test('DB checks only read inside a rolled-back transaction',async()=>{
  const sql=[];const client={query:async({text,values})=>{sql.push(text);
    if(text.includes('locate_telegram_return'))return {rows:values[0]===1?[{person_id:'00000000-0000-4000-8000-000000000001'}]:[]};
    if(text.includes('lock_clerk_identity'))return {rows:values[1]==='user_M'?[{person_id:'00000000-0000-4000-8000-000000000002'}]:[]};
    return {rows:[{}]};},release(){}};
  const rows=new TelegramRegisterRows({pool:{connect:async()=>client},issuer});
  assert.equal(await rows.telegramLinked(1),true);assert.equal(await rows.telegramLinked(2),false);
  assert.equal(await rows.clerkMapped('user_M'),true);assert.equal(await rows.clerkMapped('user_N'),false);
  assert.ok(!sql.some(s=>/INSERT|UPDATE|DELETE|COMMIT/i.test(s)));
  assert.equal(sql.filter(s=>s==='BEGIN').length,4);assert.equal(sql.filter(s=>s==='ROLLBACK').length,4);
});
test('review contract describes exactly this endpoint and is pinned by the Mini App client',async()=>{
  const {readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
  const raw=await readFile(new URL('../../contracts/telegram-register.review.openapi.json',import.meta.url));
  const doc=JSON.parse(raw),op=doc.paths['/api/v1/auth/telegram/register'].post;
  assert.deepEqual(op.requestBody.content['application/json'].schema.required,['init_data','first_name','last_name']);
  assert.equal(op.security,undefined);
  for(const code of ['200','401','409','422','429'])assert.ok(op.responses[code],code);
  const {TELEGRAM_REGISTER_CONTRACT_SHA256}=await import('../../apps/mini-app/src/telegram-register-client.ts');
  assert.equal(createHash('sha256').update(raw).digest('hex'),TELEGRAM_REGISTER_CONTRACT_SHA256);
  // The canonical student contract is deliberately untouched (its hash is pinned in many places).
  const canonical=JSON.parse(await readFile(new URL('../../contracts/telegram-return.openapi.json',import.meta.url)));
  assert.equal(canonical.paths['/auth/telegram/register'],undefined);
});
