// Run against either a clean production install or the independent Vercel file trace.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ? pathToFileURL(resolve(process.argv[2]) + '/') : new URL('../../', import.meta.url);
const load = path => import(new URL(path, root));
const [{validate}, {privatePng}, {validatePilotFormulas}, {default:entry}] = await Promise.all([
  load('runtime/teacher-staging-contract.mjs'), load('packages/test-content/private-image.mjs'),
  load('packages/test-content/validate-formula.mjs'), load('api/index.mjs'),
]);
const options = ['1','2','3','4'].map(markdown => ({id:crypto.randomUUID(), blocks:[{type:'text',markdown}]}));
const good = {id:crypto.randomUUID(),position:1,expected_revision:0,prompt_blocks:[{type:'formula',latex:'x^2',display:'inline'}],
  options,correct_option_id:options[1].id,explanation_blocks:[]};
assert.equal(validate('QuestionWrite',good), true);
assert.equal(validate('QuestionWrite',{...good,id:'invalid'}), false);
assert.equal(validate('QuestionWrite',{...good,id:good.id+'\n'}), false);
assert.equal(validate('QuestionWrite',{...good,position:'1'}), false);
validatePilotFormulas([good]);
assert.throws(() => validatePilotFormulas([{...good,prompt_blocks:[{type:'formula',display:'inline',latex:String.raw`\UnknownPackageCommand`}]}]), {code:'INVALID_FORMULA'});
const png = await privatePng(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>'),'image/svg+xml');
assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
assert((await privatePng(png,'image/png')).length > 8);

const node = 'https://api-host.example', teacher = 'https://staff.example';
const key = 'offline-verification-only-never-a-real-credential';
Object.assign(process.env,{
  UA_CABINET_STAGING_ENABLED:'true', UA_CABINET_STAGING_NODE_ORIGIN:node, UA_CABINET_STAGING_PROXY_SECRET:key,
  UA_CABINET_TEACHER_ORIGIN:teacher, UA_CABINET_STUDENT_ORIGIN:'https://learner.example', UA_API_ORIGIN:'https://api.example',
  UA_CABINET_STAGING_DATABASE_URL:'postgresql://example@127.0.0.1:1/unused', UA_CABINET_CLERK_SECRET:'unused',
  UA_CABINET_CLERK_SETTINGS:JSON.stringify({issuer:'https://clerk.example',authorizedParties:[teacher],
    audience:{kind:'clerk_default_no_audience'},jwksCacheMs:10000,jwksCooldownMs:1000,timeoutMs:1000,maxJwksBytes:16384}),
});
let outbound = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {outbound++;throw Error('Provider requests are forbidden in this test');};
try {
  const result = await entry.fetch(new Request(node+'/api/v1/teacher/pilot/dashboard',{
    headers:{'x-univeracademy-pilot-proxy':key,origin:teacher},
  }));
  assert.equal(result.status,401);
  assert.equal((await result.json()).error.code,'AUTH_REQUIRED');
  assert.equal(outbound,0);
} finally {globalThis.fetch=originalFetch;}
console.log('Production Node entry and factory, strict contract, KaTeX and native SVG/PNG verified.');
