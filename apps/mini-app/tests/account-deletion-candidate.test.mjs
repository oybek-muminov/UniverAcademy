import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeletionController, DefiniteDeletionRejection, DeletionStatusMissing, browserDeletionReceiptStore, newDeletionReceipt} from '../src/account-deletion-candidate/controller.ts';
const scope = {personId:'person-a',clerkUserId:'user_A',clerkSessionId:'sess_A'};
const receipt = {requestId:'ad348ca1-57fc-48c8-9387-d1a7e7557684',receipt:'a'.repeat(42)+'A'};
const gate = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
function setup(o={}) {
 let current = scope, stored=o.saved??null, clears=0, submits=[], statuses=0;
 const controller=createDeletionController({enabled:true,scope,currentScope:()=>current,
 reverify:async()=>({clerkUserId:'user_A',clerkSessionId:'sess_A',token:'secret-jwt'}),
 store:{read:()=>stored,write:v=>{stored=v},remove:()=>{stored=null}},
 port:{submit:async r=>{submits.push(r);return {status:'pending'}},status:async()=>{statuses++;return {status:'completed'}}},
 makeReceipt:()=>receipt,onCompleted:()=>{clears++},...o});
 return {controller,submits,get stored(){return stored},get clears(){return clears},get statuses(){return statuses},switch:()=>{current={...scope,clerkUserId:'user_B'}}};
}
async function start(h){h.controller.request();await h.controller.confirm('delete-account-v1');}
test('default disabled cannot initiate deletion',async()=>{const h=setup({enabled:undefined});await start(h);assert.equal(h.controller.snapshot().phase,'disabled');assert.equal(h.submits.length,0)});
test('explicit confirmation required before fresh same-account proof and submit',async()=>{const h=setup();await h.controller.confirm('delete-account-v1');assert.equal(h.submits.length,0);await start(h);assert.equal(h.submits.length,1);assert.equal(h.controller.snapshot().phase,'pending');assert.deepEqual(h.stored,receipt);assert.equal(h.clears,0);await h.controller.refresh();assert.equal(h.clears,1);assert.equal(h.stored,null);assert.equal(h.controller.snapshot().phase,'completed')});
test('cancel confirmation and wrong confirmation do not send',async()=>{const h=setup();h.controller.request();await h.controller.confirm('wrong');assert.equal(h.submits.length,0);h.controller.cancel();assert.equal(h.controller.snapshot().phase,'idle')});
test('SDK cancel and unsupported factor do not submit',async()=>{for(const reverify of [async()=>null,async()=>{throw Error('unsupported')}]){const h=setup({reverify});await start(h);assert.equal(h.submits.length,0);assert.equal(h.stored,null)}});
test('same device different Clerk identity rejected before submit',async()=>{const h=setup({reverify:async()=>({clerkUserId:'user_B',clerkSessionId:'sess_B',token:'x'})});await start(h);assert.equal(h.controller.snapshot().phase,'rejected');assert.equal(h.submits.length,0)});
test('account switch while reverify pending never sends',async()=>{const pending=gate();const h=setup({reverify:()=>pending.promise});h.controller.request();const p=h.controller.confirm('delete-account-v1');h.switch();pending.resolve({clerkUserId:'user_A',clerkSessionId:'sess_A',token:'x'});await p;assert.equal(h.submits.length,0)});
test('cancel during reverify and dispose invalidate late results',async()=>{for(const stop of ['cancel','dispose']){const pending=gate();const h=setup({reverify:()=>pending.promise});h.controller.request();const p=h.controller.confirm('delete-account-v1');h.controller[stop]();pending.resolve({clerkUserId:'user_A',clerkSessionId:'sess_A',token:'x'});await p;assert.equal(h.submits.length,0)}});
test('double confirmation sends at most once',async()=>{const pending=gate();let n=0;const h=setup({port:{submit:async()=>{n++;return pending.promise},status:async()=>({status:'pending'})}});h.controller.request();const p=h.controller.confirm('delete-account-v1');await h.controller.confirm('delete-account-v1');await new Promise(r=>setImmediate(r));assert.equal(n,1);h.controller.cancel();assert.equal(h.controller.snapshot().phase,'submitting');pending.resolve({status:'pending'});await p});
test('durable storage failure prevents send',async()=>{const h=setup({store:{read:()=>null,write:()=>{throw Error('quota')},remove(){}}});await start(h);assert.equal(h.submits.length,0);assert.equal(h.controller.snapshot().phase,'rejected')});
test('known pre-acceptance rejection clears receipt but preserves session',async()=>{for(const status of [401,403]){const h=setup({port:{submit:async()=>{throw new DefiniteDeletionRejection(status)},status:async()=>({status:'pending'})}});await start(h);assert.equal(h.controller.snapshot().phase,'rejected');assert.equal(h.stored,null);assert.equal(h.clears,0)}});
test('network ambiguity stays pending and does not resubmit',async()=>{let n=0;const h=setup({port:{submit:async()=>{n++;throw Error('timeout')},status:async()=>({status:'pending'})}});await start(h);await start(h);assert.equal(n,1);assert.equal(h.controller.snapshot().phase,'pending');assert.deepEqual(h.stored,receipt)});
test('reload recovers by status even if new deletion disabled',async()=>{const h=setup({saved:receipt,enabled:false});assert.equal(h.controller.snapshot().phase,'pending');await start(h);assert.equal(h.submits.length,0);await h.controller.refresh();assert.equal(h.controller.snapshot().phase,'completed')});
test('404 expired/unknown receipt is not completion',async()=>{const h=setup({saved:receipt,port:{submit:async()=>({status:'pending'}),status:async()=>{throw new DeletionStatusMissing()}}});await h.controller.refresh();assert.equal(h.controller.snapshot().phase,'status_unavailable');assert.equal(h.clears,0);assert.deepEqual(h.stored,receipt)});
test('5xx status failure is pending and duplicate polls suppressed',async()=>{const pending=gate();let n=0;const h=setup({saved:receipt,port:{submit:async()=>({status:'pending'}),status:async()=>{n++;return pending.promise}}});const p=h.controller.refresh();await h.controller.refresh();assert.equal(n,1);pending.reject(Error('503'));await p;assert.equal(h.controller.snapshot().phase,'pending')});
test('completion of old account does not clear another account session',async()=>{const h=setup({saved:receipt});h.switch();await h.controller.refresh();assert.equal(h.controller.snapshot().phase,'completed');assert.equal(h.clears,0)});
test('local cleanup exception cannot negate confirmed completion',async()=>{const h=setup({saved:receipt,onCompleted:()=>{throw Error('cleanup')}});await h.controller.refresh();assert.equal(h.controller.snapshot().phase,'completed')});
test('invalid saved receipt and blocked read fail closed',()=>{for(const store of [{read:()=>({requestId:'bad',receipt:'x'}),write(){},remove(){}},{read(){throw Error('blocked')},write(){},remove(){}}]){const h=setup({store});h.controller.request();assert.equal(h.controller.snapshot().phase,'status_unavailable')}});
test('storage is scoped and persists only random status secret',()=>{const map=new Map();const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),key:n=>[...map.keys()][n]??null,get length(){return map.size}};const a=browserDeletionReceiptStore(storage,scope),b=browserDeletionReceiptStore(storage,{...scope,clerkUserId:'user_B'});a.write(receipt);assert.deepEqual(a.read(),receipt);assert.equal(b.read(),null);assert.equal([...map.values()][0],JSON.stringify(receipt));a.remove(receipt);assert.equal(a.read(),null)});
test('production receipt generator uses unique 256-bit values',()=>{const a=newDeletionReceipt(),b=newDeletionReceipt();assert.match(a.receipt,/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);assert.notEqual(a.receipt,b.receipt);assert.notEqual(a.requestId,b.requestId)});

import {createDeletionHttpPort} from '../src/account-deletion-candidate/http-port.ts';
test('HTTP adapter fixes origin, excludes credentials/redirects and separates tokens from body',async()=>{
 const calls=[];const port=createDeletionHttpPort({apiOrigin:'https://api.example.test',appBearer:'app-token',fetch:async(url,init)=>{calls.push({url,init});return Response.json({status:'pending'})}});
 await port.submit({...receipt,confirmation:'delete-account-v1',clerkToken:'clerk-token'});await port.status(receipt.receipt);
 assert.equal(calls[0].url,'https://api.example.test/api/v1/me/deletion');assert.deepEqual(JSON.parse(calls[0].init.body),{...receipt,confirmation:'delete-account-v1'});
 assert.equal(calls[0].init.headers.Authorization,'Bearer app-token');assert.equal(calls[0].init.headers['x-clerk-token'],'clerk-token');
 assert.equal(calls[1].url,'https://api.example.test/api/v1/me/deletion/status');assert.equal(calls[1].init.headers['x-deletion-receipt'],receipt.receipt);assert.equal(calls[1].init.headers.Authorization,undefined);
 for(const {init} of calls){assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.referrerPolicy,'no-referrer')}
});
test('HTTP adapter rejects unsafe origins',()=>{for(const apiOrigin of ['http://api.example.test','https://u:p@api.example.test','https://api.example.test/path','https://api.example.test/?next=x','https://api.example.test/#x'])assert.throws(()=>createDeletionHttpPort({apiOrigin,appBearer:'x'}))});
test('HTTP rejection only401/403 is definite; other error shapes remain ambiguous',async()=>{
 for(const status of [400,401,403,404,409,422,429,500,503]){
  const port=createDeletionHttpPort({apiOrigin:'https://api.example.test',appBearer:'x',fetch:async()=>Response.json({error:{code:'UNCONFIRMED'}},{status})});
  await assert.rejects(port.submit({...receipt,confirmation:'delete-account-v1',clerkToken:'x'}),e=>(e instanceof DefiniteDeletionRejection)===[401,403].includes(status));
 }
});
test('HTTP status404 never means completed; malformed responses fail closed',async()=>{
 const portFor=(status,body)=>createDeletionHttpPort({apiOrigin:'https://api.example.test',appBearer:'x',fetch:async()=>Response.json(body,{status})});
 await assert.rejects(portFor(404,{error:{code:'NOT_FOUND'}}).status(receipt.receipt),DeletionStatusMissing);
 for(const body of [{},{status:'deleted'},{error:{code:'FAIL'}}])await assert.rejects(portFor(200,body).status(receipt.receipt));
 assert.deepEqual(await portFor(200,{status:'completed'}).status(receipt.receipt),{status:'completed'});
});
test('noncanonical base64url receipt cannot be stored or submitted',()=>{
 const storage={getItem:()=>null,setItem(){throw Error('must not write')},removeItem(){}};
 const store=browserDeletionReceiptStore(storage,scope);
 for(const value of ['a'.repeat(64),'a'.repeat(43),'A'.repeat(43)+'='])assert.throws(()=>store.write({...receipt,receipt:value}));
});

test('HTTP deadline aborts hung fetch and leaves durable controller pending, pollable',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let signal;
 const port=createDeletionHttpPort({apiOrigin:'https://api.example.test',appBearer:'x',timeoutMs:5000,fetch:async(_,init)=>{signal=init.signal;return new Promise(()=>{})}});
 const h=setup({port});const running=start(h);
 await new Promise(r=>setImmediate(r));assert.equal(h.controller.snapshot().phase,'submitting');
 t.mock.timers.tick(5000);await running;
 assert.equal(signal.aborted,true);assert.equal(h.controller.snapshot().phase,'pending');assert.deepEqual(h.stored,receipt);assert.equal(h.clears,0);
 const polling=h.controller.refresh();await new Promise(r=>setImmediate(r));t.mock.timers.tick(5000);await polling;
 assert.equal(h.controller.snapshot().phase,'pending');
});
test('HTTP deadline covers hung response body for both submit and status',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 for(const operation of ['submit','status']){
  let signal;
  const port=createDeletionHttpPort({apiOrigin:'https://api.example.test',appBearer:'x',timeoutMs:15000,fetch:async(_,init)=>{signal=init.signal;return {ok:true,status:200,json:()=>new Promise(()=>{})}}});
  const result=operation==='submit'?port.submit({...receipt,confirmation:'delete-account-v1',clerkToken:'x'}):port.status(receipt.receipt);
  const rejected=assert.rejects(result,/deadline exceeded/);
  await new Promise(r=>setImmediate(r));t.mock.timers.tick(15000);await rejected;assert.equal(signal.aborted,true);
 }
});
test('HTTP deadlines constrained and successful requests clear abort timer',async t=>{
 for(const timeoutMs of [0,4999,15001,NaN,Infinity])assert.throws(()=>createDeletionHttpPort({apiOrigin:'https://api.example.test',appBearer:'x',timeoutMs}));
 t.mock.timers.enable({apis:['setTimeout']});let signal;
 const port=createDeletionHttpPort({apiOrigin:'https://api.example.test',appBearer:'x',fetch:async(_,init)=>{signal=init.signal;return Response.json({status:'completed'})}});
 assert.deepEqual(await port.status(receipt.receipt),{status:'completed'});t.mock.timers.tick(20000);assert.equal(signal.aborted,false);
});
