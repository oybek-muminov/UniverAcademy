// Explicit local review overlay. --check never regenerates approved bytes in CI.
import {readFileSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const base='3d4afd1a55918775eb3cbd2da7a004e19d37a6b8';
const manifest='apps/mini-app/tests/fixtures/backend-account-deletion-review-manifest.json';
const guard='apps/mini-app/tests/verify-backend-targets.mjs';
const checking=process.argv.includes('--check');
const prior=checking?JSON.parse(readFileSync(manifest,'utf8')):null;
const hash=b=>createHash('sha256').update(b).digest('hex');
function walk(p){return readdirSync(p,{withFileTypes:true}).flatMap(e=>e.name==='node_modules'?[]:e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);}
const paths=[
'apps/mini-app/src/student-app.tsx','apps/mini-app/src/clerk-app-session.ts','apps/mini-app/src/account-dashboard.tsx','apps/mini-app/src/dashboard-profile.ts','apps/mini-app/src/dashboard.css',
...walk('apps/mini-app/tests').filter(p=>p.includes('/dashboard-')), 
'runtime/cloudflare-entry.mjs','contracts/account-deletion.review.openapi.json','apps/mini-app/src/main.tsx','apps/mini-app/package.json','apps/mini-app/package-lock.json','apps/mini-app/src/clerk-prebuilt-entry.tsx','apps/mini-app/src/common-production-runtime.ts','apps/mini-app/src/owner-port.ts','apps/mini-app/src/production-connection.ts',
...walk('runtime').filter(p=>p.startsWith('runtime/telegram-clerk-entry-')),'contracts/telegram-atomic-entry.review.openapi.json','supabase/functions/univeracademy-api/storage/telegram-clerk-entry-rows.ts',
...walk('tests/telegram-entry').filter(p=>!p.endsWith('.md')),
...walk('runtime').filter(p=>p.startsWith('runtime/account-deletion-')),
'supabase/functions/univeracademy-api/account-deletion.ts','supabase/functions/univeracademy-api/storage/account-deletion-rows.ts',
'supabase/proposals/account-deletion-rebuild.review.sql',
...walk('tests/account-deletion').filter(p=>!p.endsWith('.md')),
'packages/api-client/telegram-atomic-client.ts','apps/mini-app/src/owner-client/telegram-atomic-client.ts',
...walk('apps/mini-app/src').filter(p=>p.startsWith('apps/mini-app/src/telegram-atomic-')&&!p.endsWith('.md')),
...walk('apps/mini-app/tests').filter(p=>p.startsWith('apps/mini-app/tests/telegram-atomic-')),
...walk('apps/mini-app/src/account-deletion-candidate').filter(p=>!p.endsWith('.md')),
...walk('apps/mini-app/tests').filter(p=>p.startsWith('apps/mini-app/tests/account-deletion-'))].sort();
const rows=paths.map(path=>{if(!lstatSync(path).isFile())throw Error('Regular source required: '+path);const bytes=readFileSync(path);let old=null;if(checking){old=prior.files.find(f=>f.path===path)?.preimage??null;}else try{const b=execFileSync('git',['show',base+':'+path],{stdio:['ignore','pipe','ignore']});old={path,bytes:b.length,sha256:hash(b)};}catch{}return {path,preimage:old,result:{path,bytes:bytes.length,sha256:hash(bytes)}};});
const text=JSON.stringify({format_version:1,base_commit:base,status:'local-review-only-not-deployed',files:rows},null,2)+'\n';
const literal="const ACCOUNT_DELETION_OVERLAY_SHA256 = '"+hash(text)+"';";
const source=readFileSync(guard,'utf8'),pattern=/const ACCOUNT_DELETION_OVERLAY_SHA256 = '[a-f0-9]{64}';/;
if(!pattern.test(source))throw Error('Guard overlay anchor missing');
if(checking){
 if(readFileSync(manifest,'utf8')!==text||source.match(pattern)[0]!==literal)throw Error('ACCOUNT_DELETION_PINS_STALE: regenerate locally and review source plus manifest changes');
}else{writeFileSync(manifest,text);writeFileSync(guard,source.replace(pattern,literal));}
