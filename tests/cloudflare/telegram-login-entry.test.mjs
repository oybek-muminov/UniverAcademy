import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCloudflareEntrypoint} from '../../runtime/cloudflare-entry.mjs';
import {clock,testPolicy} from '../backend/http-fixture.ts';

// Browser link route gating: absent unless enabled, unavailable unless fully configured, and the
// Telegram token endpoint is never called before the Clerk proof is verified.
const api='https://api.telegram-login.invalid',ui='https://mini.telegram-login.invalid',issuer='https://clerk.telegram-login.invalid';
const fresh=()=>Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
function fixture(extra={}){
 const telegramCalls=[],keyLoads=[],queries=[];
 const url=new URL('postgres://hyperdrive.invalid:5432/inert');url.username=fresh();url.password=fresh();
 const env={UA_API_ORIGIN:api,UA_ALLOWED_ORIGINS:JSON.stringify([ui]),UA_SESSION_POLICY:JSON.stringify(testPolicy),
  UA_CLERK_PROVIDER_SETTINGS:JSON.stringify({issuer,authorizedParties:[ui],audience:{kind:'clerk_default_no_audience'},jwksCacheMs:300000,jwksCooldownMs:0,timeoutMs:1000,maxJwksBytes:65536}),
  UA_CLERK_SECRET_KEY:fresh(),HYPERDRIVE:{connectionString:url.toString()},UA_TELEGRAM_BOT_TOKEN:'654321:'+fresh(),...extra};
 class Client extends EventEmitter{async connect(){}async query(q){queries.push(q.text);return {rows:[],rowCount:0};}async end(){}}
 const entry=createCloudflareEntrypoint({loadClient:async()=>Client,
  makeClerk:async()=>({verifier:{issuer,authorizedParties:[ui],audience:{kind:'clerk_default_no_audience'},trustedKeys:()=>{throw Error('no key');},now:()=>clock},liveness:async()=>{throw Error('no provider');},async close(){}}),
  transport:async request=>{telegramCalls.push(request.url);throw new Error('Telegram must not be reached');},
  telegramKeys:async()=>{keyLoads.push(1);return async()=>{throw new Error('no key');};},now:()=>clock});
 const post=(headers={})=>entry.fetch(new Request(api+'/api/v1/auth/telegram/browser-link',{method:'POST',headers:{origin:ui,'content-type':'application/json',...headers},
  body:JSON.stringify({code:'one-time-authorization-code',code_verifier:'v'.repeat(43)})}),env);
 return {entry,env,post,telegramCalls,keyLoads,queries};
}
const enabled={UA_TELEGRAM_LOGIN_ENABLED:'true',UA_TELEGRAM_LOGIN_CLIENT_ID:'1234567890',UA_TELEGRAM_LOGIN_CLIENT_SECRET:'synthetic-client-secret-value',
  UA_TELEGRAM_LOGIN_REDIRECT_URI:'https://mini.telegram-login.invalid/telegram-link'};
const code=async response=>(await response.json()).error.code;

test('absent or disabled: the route does not exist and nothing is loaded or called',async()=>{
 for(const extra of [{},{UA_TELEGRAM_LOGIN_ENABLED:'false',...enabled,UA_TELEGRAM_LOGIN_ENABLED:'false'}]){
  const f=fixture(extra),r=await f.post({authorization:'Bearer x.y.z'});
  assert.equal(r.status,404);assert.equal(await code(r),'NOT_FOUND');assert.equal(f.keyLoads.length,0);assert.equal(f.telegramCalls.length,0);assert.equal(f.queries.length,0);
 }
});
test('a malformed enable flag fails closed as unavailable',async()=>{
 const f=fixture({...enabled,UA_TELEGRAM_LOGIN_ENABLED:'yes'}),r=await f.post();assert.equal(r.status,503);assert.equal(f.telegramCalls.length,0);
});
test('enabled but missing any required value is unavailable and never calls Telegram',async()=>{
 for(const key of ['UA_TELEGRAM_LOGIN_CLIENT_ID','UA_TELEGRAM_LOGIN_CLIENT_SECRET','UA_TELEGRAM_LOGIN_REDIRECT_URI']){
  const extra={...enabled};delete extra[key];const f=fixture(extra),r=await f.post({authorization:'Bearer x.y.z'});
  assert.equal(r.status,503,key);assert.equal(f.telegramCalls.length,0);
 }
 const f=fixture({...enabled,UA_TELEGRAM_LOGIN_CLIENT_SECRET:7});assert.equal((await f.post()).status,503);
});
test('enabled and configured: a request without a valid Clerk proof is refused before Telegram or the database',async()=>{
 const f=fixture(enabled);
 for(const headers of [{},{authorization:'Bearer not-a-jwt'}]){const r=await f.post(headers);assert.equal(r.status,401);}
 assert.equal(f.telegramCalls.length,0);assert.equal(f.queries.some(q=>/init_data_replays|link_telegram_identity/.test(q)),false);
});
test('the secret and the code never appear in an error response',async()=>{
 const f=fixture(enabled);const r=await f.post({authorization:'Bearer not-a-jwt'}),text=await r.text();
 for(const secret of [enabled.UA_TELEGRAM_LOGIN_CLIENT_SECRET,'one-time-authorization-code',f.env.UA_TELEGRAM_BOT_TOKEN])assert(!text.includes(secret));
});
