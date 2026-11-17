import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoveryIndex,createPublicRecovery,withRecoveryIndex} from '../src/account-deletion-candidate/recovery.ts';
const ticket={requestId:'ad348ca1-57fc-48c8-9387-d1a7e7557684',receipt:'A'.repeat(43)};
const second={requestId:'ad348ca1-57fc-48c8-9387-d1a7e7557685',receipt:'B'.repeat(42)+'A'};
const memory=()=>{const m=new Map();return{getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k),key:n=>[...m.keys()][n]??null,get length(){return m.size},m}};
test('empty storage has no recovery shortcut; old unmarked receipts remain unresolved',()=>{
 const storage=memory(),index=createRecoveryIndex(storage);
 assert.deepEqual(index.readPending(),[]);index.add(ticket);
 assert.deepEqual(createRecoveryIndex(storage).readPending(),[ticket]);
});
test('completed exact receipt retained for explicit forget but excluded from shortcut',()=>{
 const storage=memory(),index=createRecoveryIndex(storage);index.add(ticket);index.add(second);
 index.markCompleted(ticket);assert.deepEqual(index.read(),[ticket,second]);
 assert.deepEqual(createRecoveryIndex(storage).readPending(),[second]);
 index.add(ticket);assert.deepEqual(index.readPending(),[second]);
});
test('completion marker refuses a changed receipt and leaves original unresolved',()=>{
 const index=createRecoveryIndex(memory());index.add(ticket);
 assert.throws(()=>index.markCompleted({...ticket,receipt:second.receipt}),/conflict/);
 assert.deepEqual(index.readPending(),[ticket]);
});
test('only explicit authoritative completed poll marks receipt, pending errors and disposal do not',async()=>{
 for(const result of ['pending','error','completed']){
  const index=createRecoveryIndex(memory());index.add(ticket);let calls=0;
  const controller=createPublicRecovery({ticket,status:async()=>{calls++;if(result==='error')throw Error('offline');return{status:result}},onCompleted:value=>index.markCompleted(value)});
  assert.equal(calls,0);await controller.refresh();
  assert.deepEqual(index.readPending(),result==='completed'?[]:[ticket]);
 }
 const index=createRecoveryIndex(memory());index.add(ticket);let resolve;
 const c=createPublicRecovery({ticket,status:()=>new Promise(r=>resolve=r),onCompleted:value=>index.markCompleted(value)});
 const p=c.refresh();c.dispose();resolve({status:'completed'});await p;assert.deepEqual(index.readPending(),[ticket]);
});
test('successful authenticated completion marks public ticket; marker failure retains ticket',()=>{
 const storage=memory(),index=createRecoveryIndex(storage);index.add(ticket);
 withRecoveryIndex({read:()=>ticket,write(){},remove(){}},index).remove(ticket,'completed');
 assert.deepEqual(index.readPending(),[]);assert.deepEqual(index.read(),[ticket]);
});
test('visibility component reads locally, hides empty or blocked storage, subscribes and cleans listeners',async()=>{
 const {readFile}=await import('node:fs/promises');const {transformWithOxc}=await import('vite');const {runInNewContext}=await import('node:vm');
 const source=await readFile(new URL('../src/account-deletion-candidate/recovery-link.tsx',import.meta.url),'utf8');
 const out=await transformWithOxc(source,'recovery-link.tsx',{jsx:{runtime:'automatic'}});
 const code=out.code.replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'');
 const storage=memory(),events=new Map();let state,effect;
 const context={createRecoveryIndex,RECOVERY_INDEX_CHANGED:'changed',localStorage:storage,window:{addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k)},useState:v=>[state??v,x=>state=x],useEffect:fn=>effect=fn,_jsx:(tag,props)=>({tag,props})};
 runInNewContext(code,context);
 assert.equal(context.hasUnresolvedRecovery(()=>storage),false);
 assert.equal(context.hasUnresolvedRecovery(()=>{throw Error('blocked')}),false);
 assert.equal(context.SavedDeletionRecoveryLink(),null);const cleanup=effect();assert.equal(state,false);
 createRecoveryIndex(storage).add(ticket);events.get('storage')();assert.equal(state,true);
 const rendered=context.SavedDeletionRecoveryLink();assert.equal(rendered.props.href,'/account-deletion-status');
 createRecoveryIndex(storage).markCompleted(ticket);events.get('changed')();assert.equal(state,false);
 assert.equal(context.SavedDeletionRecoveryLink(),null);cleanup();assert.equal(events.size,0);
});
test('failed completion marker storage write preserves unresolved recovery and server completion',async()=>{
 const storage=memory();createRecoveryIndex(storage).add(ticket);
 const blocked=createRecoveryIndex({...storage,get length(){return storage.length},setItem(){throw Error('quota')}});
 const controller=createPublicRecovery({ticket,status:async()=>({status:'completed'}),onCompleted:value=>blocked.markCompleted(value)});
 await controller.refresh();assert.equal(controller.snapshot().phase,'completed');
 assert.deepEqual(createRecoveryIndex(storage).readPending(),[ticket]);
});
test('malformed index cannot expose a fabricated ticket via shortcut',()=>{
 const storage=memory(),index=createRecoveryIndex(storage);index.add(ticket);
 storage.setItem('ua:deletion:recovery:v1:'+ticket.requestId,'{}');
 assert.deepEqual(index.readPending(),[]);
 assert.equal(index.readAvailable().unreadableCount,1);
});

test('one corrupt receipt cannot hide valid pending receipt; recovery lists valid tickets and warns without mutating corrupt bytes',()=>{
 for(const corrupt of ['{not json','{}',JSON.stringify({...ticket,requestId:second.requestId})]){
  const storage=memory(),index=createRecoveryIndex(storage);index.add(ticket);index.add(second);
  const badKey='ua:deletion:recovery:v1:'+ticket.requestId;storage.setItem(badKey,corrupt);
  assert.deepEqual(index.readPending(),[second]);
  assert.deepEqual(index.readAvailable(),{tickets:[second],unreadableCount:1});
  assert.equal(storage.getItem(badKey),corrupt);
  assert.throws(()=>index.read());
  index.markCompleted(second);
  assert.deepEqual(index.readPending(),[]);
  assert.deepEqual(index.readAvailable(),{tickets:[second],unreadableCount:1});
 }
});
test('single unreadable key is isolated while full storage enumeration failure remains explicit',()=>{
 const storage=memory(),index=createRecoveryIndex(storage);index.add(ticket);index.add(second);
 const wrapped={...storage,get length(){return storage.length},getItem:key=>key.endsWith(ticket.requestId)?(()=>{throw Error('blocked record')})():storage.getItem(key)};
 assert.deepEqual(createRecoveryIndex(wrapped).readAvailable(),{tickets:[second],unreadableCount:1});
 assert.deepEqual(createRecoveryIndex(wrapped).readPending(),[second]);
 assert.throws(()=>createRecoveryIndex({...wrapped,key(){throw Error('blocked store')}}).readAvailable());
});
