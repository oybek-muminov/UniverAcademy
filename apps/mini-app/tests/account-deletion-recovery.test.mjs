import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoveryIndex,withRecoveryIndex,createPublicRecovery,createForgetRecovery} from '../src/account-deletion-candidate/recovery.ts';
import {createPublicRecoveryStatus} from '../src/account-deletion-candidate/recovery-status-port.ts';
import {createDeletionController,DeletionStatusMissing} from '../src/account-deletion-candidate/controller.ts';
const ticket={requestId:'ad348ca1-57fc-48c8-9387-d1a7e7557684',receipt:'A'.repeat(43)};
const second={requestId:'ad348ca1-57fc-48c8-9387-d1a7e7557685',receipt:'B'.repeat(42)+'A'};
const memory=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),key:n=>[...m.keys()][n]??null,get length(){return m.size},m}};
test('index reload independent of account stores only opaque capabilities',()=>{const s=memory();const a=createRecoveryIndex(s);a.add(ticket);a.add(second);a.add(ticket);assert.deepEqual(createRecoveryIndex(s).read(),[ticket,second]);assert.equal([...s.m.values()][0],JSON.stringify(ticket));a.remove(ticket);assert.deepEqual(a.read(),[second])});
test('index corruption and conflicting receipt fail closed',()=>{const s=memory(),i=createRecoveryIndex(s);i.add(ticket);assert.throws(()=>i.add({...ticket,receipt:second.receipt}));s.setItem('ua:deletion:recovery:v1:'+ticket.requestId,'invalid');assert.throws(()=>i.read())});
test('either durable write failure prevents submission',async()=>{
 for(const which of ['index','scoped']){
 let sends=0;const index=createRecoveryIndex({...memory(),setItem(){if(which==='index')throw Error('quota')}});
 const store=withRecoveryIndex({read:()=>null,write(){if(which==='scoped')throw Error('quota')},remove(){}},index);
 const scope={personId:'x',clerkUserId:'u',clerkSessionId:'s'};
 const c=createDeletionController({enabled:true,scope,currentScope:()=>scope,store,reverify:async()=>({clerkUserId:'u',clerkSessionId:'s',token:'x'}),makeReceipt:()=>ticket,port:{submit:async()=>{sends++;return{status:'pending'}},status:async()=>({status:'pending'})},onCompleted(){}});
 c.request();await c.confirm('delete-account-v1');assert.equal(sends,0);assert.equal(c.snapshot().phase,'rejected');
 }
});
test('scoped removal does not erase another ticket; public recovery never touches session',async()=>{const s=memory(),i=createRecoveryIndex(s);i.add(second);let cleared=0;const store=withRecoveryIndex({read:()=>ticket,write(){},remove(){cleared++}},i);store.write(ticket);store.remove(ticket);assert.equal(cleared,1);assert.deepEqual(i.read(),[second]);let calls=0;const c=createPublicRecovery({ticket,status:async receipt=>{assert.equal(receipt,ticket.receipt);calls++;return{status:'completed'}}});assert.equal(calls,0);await c.refresh();assert.equal(c.snapshot().phase,'completed');assert.deepEqual(i.read(),[second])});
test('404 and ambiguous failures never claim success and remain retryable',async()=>{for(const error of [new DeletionStatusMissing(),Error('timeout')]){let n=0;const c=createPublicRecovery({ticket,status:async()=>{n++;if(n===1)throw error;return{status:'completed'}}});await c.refresh();assert.notEqual(c.snapshot().phase,'completed');await c.refresh();assert.equal(c.snapshot().phase,'completed')}});
test('public status sends no credentials without any account input',async()=>{let call;const status=createPublicRecoveryStatus({apiOrigin:'https://api.example.test',fetch:async(...args)=>{call=args;return Response.json({status:'pending'})}});assert.deepEqual(await status(ticket.receipt),{status:'pending'});assert.equal(call[0],'https://api.example.test/api/v1/me/deletion/status');assert.deepEqual(call[1].headers,{'x-deletion-receipt':ticket.receipt,Accept:'application/json'});assert.equal(call[1].credentials,'omit');assert.equal(call[1].redirect,'error')});
test('public status deadline covers hung body and aborts',async t=>{t.mock.timers.enable({apis:['setTimeout']});let signal;const status=createPublicRecoveryStatus({apiOrigin:'https://api.example.test',timeoutMs:5000,fetch:async(_,init)=>{signal=init.signal;return{ok:true,status:200,json:()=>new Promise(()=>{})}}});const p=assert.rejects(status(ticket.receipt),/deadline/);await new Promise(r=>setImmediate(r));t.mock.timers.tick(5000);await p;assert.equal(signal.aborted,true)});
test('duplicate polls suppressed and disposed controller ignores late completion',async()=>{let resolve,n=0;const c=createPublicRecovery({ticket,status:()=>{n++;return new Promise(r=>{resolve=r})}});const p=c.refresh();await c.refresh();assert.equal(n,1);c.dispose();resolve({status:'completed'});await p;assert.notEqual(c.snapshot().phase,'completed')});

test('main exact public route dynamically imports only recovery, not auth bootstrap',async()=>{
 const {readFile}=await import('node:fs/promises');const{transformWithOxc}=await import('vite');const{runInNewContext}=await import('node:vm');
 const source=await readFile(new URL('../src/main.tsx',import.meta.url),'utf8');
 const output=await transformWithOxc(source,'main.tsx',{jsx:{runtime:'automatic'}});
 const code=output.code.replace(/^import .*;\s*$/gm,'').replaceAll('import.meta.env','env').replaceAll('import(', 'load(');
 for(const env of [{DEV:false,MODE:'production',VITE_AUTH_ENTRY:'common'},{DEV:true,MODE:'local_fixture'}]){
  const imports=[],mounted=[];
  const context={env,location:{pathname:'/account-deletion-status',origin:'https://app.example.test'},document:{getElementById:()=>({})},localStorage:{},createRoot:()=>{throw Error('Auth rendering forbidden')},load:async path=>{imports.push(path);return{mountDeletionRecovery:(_,options)=>mounted.push(options)}}};
  runInNewContext(code,context);await new Promise(r=>setImmediate(r));
  assert.deepEqual(imports,['./account-deletion-candidate/recovery-entry.tsx']);assert.equal(mounted.length,1);
 }
 const entry=await readFile(new URL('../src/account-deletion-candidate/recovery-entry.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(entry,/from ['"].*(?:clerk|production-runtime|common-production|telegram-bootstrap)/);
});
test('separate per-request keys preserve two tabs receipts without index overwrite',()=>{
 const storage=memory(),tabA=createRecoveryIndex(storage),tabB=createRecoveryIndex(storage);
 assert.deepEqual(tabA.read(),[]);assert.deepEqual(tabB.read(),[]);tabA.add(ticket);tabB.add(second);
 assert.deepEqual(tabA.read(),[ticket,second]);assert.equal(storage.length,2);
});

test('explicit forget completed requires request and confirm; cancel preserves both tickets',()=>{
 for(const phase of ['completed']){
  const storage=memory(),index=createRecoveryIndex(storage);index.add(ticket);index.add(second);
  const action=createForgetRecovery(ticket,index,()=>true);
  assert.equal(action.confirm(),false);action.request();action.cancel();assert.equal(action.confirm(),false);assert.equal(index.read().length,2);
  action.request();assert.equal(action.confirm(),true);assert.deepEqual(index.read(),[second]);
 }
});
test('forget changed receipt fails without removing replacement or another ticket',()=>{
 const storage=memory(),index=createRecoveryIndex(storage);index.add(ticket);index.add(second);
 const action=createForgetRecovery(ticket,index,()=>true);action.request();
 storage.setItem('ua:deletion:recovery:v1:'+ticket.requestId,JSON.stringify({...ticket,receipt:second.receipt}));
 assert.throws(()=>action.confirm(),/conflict/);assert.equal(index.read().length,2);
});
test('forget storage failure retains receipt and allows cancellation/retry',()=>{
 const storage=memory();let blocked=true;
 const index=createRecoveryIndex({...storage, get length(){return storage.length},removeItem:key=>{if(blocked)throw Error('blocked');storage.removeItem(key)}});
 index.add(ticket);const action=createForgetRecovery(ticket,index,()=>true);action.request();assert.throws(()=>action.confirm());assert.deepEqual(index.read(),[ticket]);action.cancel();assert.equal(action.confirm(),false);blocked=false;action.request();assert.equal(action.confirm(),true);assert.deepEqual(index.read(),[]);
});

test('pending unknown or unavailable cannot forget even if explicitly requested',()=>{
 const storage=memory(),index=createRecoveryIndex(storage);index.add(ticket);
 const action=createForgetRecovery(ticket,index,()=>false);action.request();assert.equal(action.confirm(),false);assert.deepEqual(index.read(),[ticket]);
});
test('no arbitrary capacity limit can strand preserved unknown receipts',()=>{
 const index=createRecoveryIndex(memory());for(let n=0;n<25;n++)index.add({...ticket,requestId:'ad348ca1-57fc-48c8-9387-'+String(n).padStart(12,'0')});assert.equal(index.read().length,25);
});

test('definite rejection cleans own index, ambiguous response preserves it',async()=>{
 const {DefiniteDeletionRejection}=await import('../src/account-deletion-candidate/controller.ts');
 for(const definite of [true,false]){
  const index=createRecoveryIndex(memory());let saved=null;
  const store=withRecoveryIndex({read:()=>saved,write:v=>saved=v,remove:expected=>{assert.deepEqual(expected,saved);saved=null}},index);
  const scope={personId:'x',clerkUserId:'u',clerkSessionId:'s'};
  const c=createDeletionController({enabled:true,scope,currentScope:()=>scope,store,reverify:async()=>({clerkUserId:'u',clerkSessionId:'s',token:'x'}),makeReceipt:()=>ticket,port:{submit:async()=>{throw definite?new DefiniteDeletionRejection(401):Error('timeout')},status:async()=>({status:'pending'})},onCompleted(){}});
  c.request();await c.confirm('delete-account-v1');assert.deepEqual(index.read(),definite?[]:[ticket]);
 }
});
test('partial scoped write failure rolls back only its unsubmitted index ticket',()=>{
 const index=createRecoveryIndex(memory());index.add(second);
 const store=withRecoveryIndex({read:()=>null,write(){throw Error('quota')},remove(){}},index);
 assert.throws(()=>store.write(ticket));assert.deepEqual(index.read(),[second]);
});
test('scoped receipt removal cannot erase a newer tab receipt',async()=>{
 const{browserDeletionReceiptStore}=await import('../src/account-deletion-candidate/controller.ts');
 const storage=memory(),scope={personId:'x',clerkUserId:'u'};
 const a=browserDeletionReceiptStore(storage,scope),b=browserDeletionReceiptStore(storage,scope);
 a.write(ticket);b.write(second);a.remove(ticket);assert.deepEqual(b.read(),second);
});

test('adversarial other-tab write between scoped get and remove survives',async()=>{
 const{browserDeletionReceiptStore}=await import('../src/account-deletion-candidate/controller.ts');
 const underlying=memory(),scope={personId:'x',clerkUserId:'u'};
 const b=browserDeletionReceiptStore(underlying,scope);let insert=false;
 const a=browserDeletionReceiptStore({...underlying,get length(){return underlying.length},getItem:key=>{const old=underlying.getItem(key);if(insert){insert=false;b.write(second)}return old}},scope);
 a.write(ticket);insert=true;a.remove(ticket);assert.deepEqual(b.read(),second);
});

test('confirmed completion removes scoped receipt but retains public receipt for explicit forget',()=>{
 const index=createRecoveryIndex(memory());let scoped=ticket;
 const store=withRecoveryIndex({read:()=>scoped,write:v=>scoped=v,remove:()=>scoped=null},index);store.write(ticket);store.remove(ticket,'completed');assert.equal(scoped,null);assert.deepEqual(index.read(),[ticket]);
 const forget=createForgetRecovery(ticket,index,()=>true);forget.request();forget.confirm();assert.deepEqual(index.read(),[]);
});
