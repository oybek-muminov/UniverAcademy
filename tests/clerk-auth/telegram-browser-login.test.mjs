import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT,exportJWK,createLocalJWKSet} from 'jose';
import {verifyTelegramLoginLaunch,telegramLoginBody,TELEGRAM_LOGIN_ISSUER,TELEGRAM_LOGIN_TOKEN_URL} from '../../supabase/functions/univeracademy-api/telegram-return.ts';
import {clock,testPolicy} from '../backend/http-fixture.ts';

// "Log In With Telegram" (OIDC + PKCE) in the browser. Telegram, its keys and the network are synthetic.
const CLIENT='1234567890',SECRET='synthetic-client-secret-value',REDIRECT='https://mini.example.org/telegram-link';
const NOW=clock,SECONDS=Math.floor(NOW/1000),TG=4000000123;
const VERIFIER='v'.repeat(43),CODE='one-time-authorization-code';
const pair=await generateKeyPair('RS256',{extractable:true}),other=await generateKeyPair('RS256');
const jwk={...await exportJWK(pair.publicKey),kid:'tg-1',alg:'RS256',use:'sig'};
const trustedKeys=createLocalJWKSet({keys:[jwk]});
async function token({key=pair.privateKey,alg='RS256',iss=TELEGRAM_LOGIN_ISSUER,aud=CLIENT,iat=SECONDS-5,exp=SECONDS+3595,id=TG,extra={}}={}){
  const claims={sub:'opaque-subject',...(id===null?{}:{id}),...extra};
  return await new SignJWT(claims).setProtectedHeader({alg,kid:'tg-1'}).setIssuer(iss).setAudience(aud).setIssuedAt(iat).setExpirationTime(exp).sign(key);
}
function setup({status=200,body,jwt,throws}={}){
  const calls=[];
  const transport=async request=>{
    calls.push({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),body:await request.text(),redirect:request.redirect});
    if(throws)throw new Error('network');
    return new Response(typeof body==='string'?body:JSON.stringify(body??{token_type:'Bearer',access_token:'unused',expires_in:3600,id_token:jwt}),{status});
  };
  return {calls,config:{clientId:CLIENT,clientSecret:SECRET,redirectUri:REDIRECT,transport,trustedKeys}};
}
const run=async(options,input={code:CODE,code_verifier:VERIFIER})=>{const s=setup(options);return {s,promise:()=>verifyTelegramLoginLaunch(input,s.config,testPolicy,NOW)};};
const rejects=(promise,code,status)=>assert.rejects(promise,e=>e.code===code&&e.status===status);

test('a valid confirmation yields the Telegram account, the time and a one-time replay digest',async()=>{
  const {s,promise}=await run({jwt:await token()});const launch=await promise();
  assert.equal(launch.telegramUserId,TG);assert.equal(launch.authDate,SECONDS-5);assert.match(launch.replayDigest,/^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(launch),true);
  const [call]=s.calls;assert.equal(call.url,TELEGRAM_LOGIN_TOKEN_URL);assert.equal(call.method,'POST');assert.equal(call.redirect,'manual');
  assert.equal(call.headers.authorization,'Basic '+btoa(CLIENT+':'+SECRET));
  assert.deepEqual(Object.fromEntries(new URLSearchParams(call.body)),{grant_type:'authorization_code',code:CODE,redirect_uri:REDIRECT,client_id:CLIENT,code_verifier:VERIFIER});
  assert(!JSON.stringify(launch).includes(CODE));
});
test('the same code always produces the same digest (so a replay can be refused) and another code another digest',async()=>{
  const a=await (await run({jwt:await token()})).promise(),b=await (await run({jwt:await token({iat:SECONDS-4})})).promise();
  assert.equal(a.replayDigest,b.replayDigest);
  const c=await verifyTelegramLoginLaunch({code:'a-different-authorization-code',code_verifier:VERIFIER},setup({jwt:await token()}).config,testPolicy,NOW);
  assert.notEqual(a.replayDigest,c.replayDigest);
});
test('Telegram refusing the code (wrong, used, expired, verifier mismatch) is a client rejection',async()=>{
  for(const status of [400,401,403])await rejects((await run({status,body:{error:'invalid_grant'}})).promise(),'INIT_DATA_INVALID',401);
});
test('Telegram or network trouble is unavailable, never a rejection of the person',async()=>{
  for(const status of [500,502,503,302])await rejects((await run({status,body:'x'})).promise(),'SERVICE_UNAVAILABLE',503);
  await rejects((await run({throws:true})).promise(),'SERVICE_UNAVAILABLE',503);
  for(const body of ['not json','{}','[]','{"token_type":"Mac","id_token":"x"}','{"token_type":"Bearer"}','{"token_type":"Bearer","id_token":1}'])
    await rejects((await run({body})).promise(),'SERVICE_UNAVAILABLE',503);
  await rejects((await run({body:'{"token_type":"Bearer","id_token":"'+'x'.repeat(70000)+'"}'})).promise(),'SERVICE_UNAVAILABLE',503);
});
test('a token signed by anyone but Telegram, or not meant for this bot, is refused',async()=>{
  const bad=[
    ['unknown signer',{key:other.privateKey}],['wrong issuer',{iss:'https://evil.example'}],['other bot',{aud:'999999999'}],
    ['expired',{iat:SECONDS-7200,exp:SECONDS-1}],['no id claim',{id:null}],['zero id',{id:0}],['negative id',{id:-5}],
    ['fractional id',{id:1.5}],['string id',{id:'4000000123'}],['unsafe id',{id:2**60}],
  ];
  for(const [label,options] of bad)await assert.rejects((await run({jwt:await token(options)})).promise(),e=>e.code==='INIT_DATA_INVALID'&&e.status===401,label);
});
test('only RS256 and ES256 are accepted: an unsigned or symmetric token cannot pass',async()=>{
  const none=['{"alg":"none","typ":"JWT"}','{"iss":"'+TELEGRAM_LOGIN_ISSUER+'","aud":"'+CLIENT+'","sub":"s","id":'+TG+',"iat":'+SECONDS+',"exp":'+(SECONDS+60)+'}']
    .map(part=>Buffer.from(part).toString('base64url')).join('.')+'.';
  await rejects((await run({jwt:none})).promise(),'INIT_DATA_INVALID',401);
  const hs=await new SignJWT({sub:'s',id:TG}).setProtectedHeader({alg:'HS256',kid:'tg-1'}).setIssuer(TELEGRAM_LOGIN_ISSUER).setAudience(CLIENT).setIssuedAt(SECONDS).setExpirationTime(SECONDS+60).sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
  await rejects((await run({jwt:hs})).promise(),'INIT_DATA_INVALID',401);
});
test('the confirmation must be recent: older than the freshness window or from the future is refused',async()=>{
  const window=testPolicy.initDataMaxAgeSeconds;
  await rejects((await run({jwt:await token({iat:SECONDS-window-1,exp:SECONDS+3000})})).promise(),'INIT_DATA_EXPIRED',401);
  await assert.doesNotReject((await run({jwt:await token({iat:SECONDS-window,exp:SECONDS+3000})})).promise());
  await rejects((await run({jwt:await token({iat:SECONDS+30,exp:SECONDS+3000})})).promise(),'INIT_DATA_INVALID',401);
});
test('a key set that cannot be reached or has no matching key is unavailable, not a rejection',async()=>{
  const jwt=await token(),s=setup({jwt});
  await rejects(verifyTelegramLoginLaunch({code:CODE,code_verifier:VERIFIER},{...s.config,trustedKeys:async()=>{throw new Error('offline');}},testPolicy,NOW),'SERVICE_UNAVAILABLE',503);
  await rejects(verifyTelegramLoginLaunch({code:CODE,code_verifier:VERIFIER},{...s.config,trustedKeys:createLocalJWKSet({keys:[{...jwk,kid:'other-key'}]})},testPolicy,NOW),'SERVICE_UNAVAILABLE',503);
});
test('an incomplete or unsafe configuration never calls Telegram',async()=>{
  const jwt=await token();
  for(const patch of [{clientId:'abc'},{clientId:''},{clientSecret:''},{clientSecret:'a\nb'},{redirectUri:'http://mini.example.org/telegram-link'},
    {redirectUri:'https://mini.example.org/telegram-link?x=1'},{redirectUri:'https://mini.example.org/telegram-link#x'},{redirectUri:'not a url'},{transport:undefined},{trustedKeys:undefined}]){
    const s=setup({jwt});await rejects(verifyTelegramLoginLaunch({code:CODE,code_verifier:VERIFIER},{...s.config,...patch},testPolicy,NOW),'SERVICE_UNAVAILABLE',503);
    assert.equal(s.calls.length,0);
  }
});
test('the request body is exactly a code and a PKCE verifier',async()=>{
  const parse=value=>telegramLoginBody(new Request('https://api.example.org/x',{method:'POST',body:typeof value==='string'?value:JSON.stringify(value)}));
  assert.deepEqual({...await parse({code:CODE,code_verifier:VERIFIER})},{code:CODE,code_verifier:VERIFIER});
  await assert.rejects(parse('{bad'),e=>e.code==='MALFORMED_JSON');
  for(const body of [{},{code:CODE},{code:CODE,code_verifier:VERIFIER,extra:1},{code:'short',code_verifier:VERIFIER},{code:CODE,code_verifier:'tooshort'},
    {code:CODE,code_verifier:'v'.repeat(129)},{code:'has space in it',code_verifier:VERIFIER},{code:1,code_verifier:VERIFIER},[CODE,VERIFIER],null,{code:'x'.repeat(2049),code_verifier:VERIFIER}])
    await assert.rejects(parse(body),e=>e.code==='VALIDATION_ERROR'&&e.status===422);
});
