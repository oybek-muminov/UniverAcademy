import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedBrowserAdapter } from '../src/verified-browser-adapter.mjs';

const account = {userId:'user_local', generation:'sess_local'};
const profile = {person_id:'person-a',name:'Sinov Ustoz',access:{teacher:true,approved:true,enabled:true},
  subjects:['Fizika'],groups:[{id:'group-a',title:'1-guruh'}],tests:[]};

function harness(read) {
  let current = account;
  const identity = {current:()=>current, subscribe:()=>()=>{}, signOut:async()=>{}};
  const { port } = createVerifiedBrowserAdapter({identity, transport:{read}});
  return {load:()=>port.load({signal:new AbortController().signal}), switchAccount:()=>{current=null;}};
}

test('one Clerk session keeps the same server-resolved platform person', async () => {
  let data = profile;
  const app = harness(async () => ({status:200,data}));
  assert.equal((await app.load()).groups[0].title,'1-guruh');
  data = {...profile, person_id:'different-person'};
  assert.deepEqual(await app.load(),{kind:'forbidden'});
});

test('a response from a session closed during the read is discarded', async () => {
  const pending = Promise.withResolvers();
  const app = harness(()=>pending.promise);
  const loading = app.load();
  app.switchAccount();
  pending.resolve({status:200,data:profile});
  await assert.rejects(loading);
  assert.deepEqual(await app.load(),{kind:'signed-out'});
});
