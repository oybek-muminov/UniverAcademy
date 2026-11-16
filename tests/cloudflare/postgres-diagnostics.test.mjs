import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCloudflarePostgres} from '../../runtime/cloudflare-postgres.mjs';
const config={connectionString:'postgres://synthetic:synthetic@hyperdrive.invalid:5432/synthetic'};
const denied=e=>e.status===503&&e.code==='SERVICE_UNAVAILABLE';
test('database diagnostics emit fixed phase/reason only and preserve denial',async t=>{
 const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
 for(const phase of ['CONNECT','QUERY','CLOSE','DRIVER_ERROR']){
  const error=Object.assign(new Error('private SQL and credential'),{code:'ECONNRESET',detail:'private details'});let instance;
  class Client extends EventEmitter{constructor(){super();instance=this;}async connect(){if(phase==='CONNECT')throw error;}async query(){if(phase==='QUERY')throw error;return {rows:[]};}async end(){if(phase==='CLOSE')throw error;}}
  const r=createCloudflarePostgres(Client,config);
  if(phase==='CONNECT')await assert.rejects(r.pool.connect(),denied);
  else {const c=await r.pool.connect();if(phase==='QUERY')await assert.rejects(c.query({text:'SELECT $1',values:['private']}),denied);if(phase==='DRIVER_ERROR')instance.emit('error',error);c.release();}
  if(phase==='CLOSE')await assert.rejects(r.close(),denied);else await r.close();
  assert.deepEqual(logs.at(-1),['UA_DATABASE_FAILURE',phase,'CONNECTION_RESET']);
 }
 assert(!JSON.stringify(logs).includes('private'));
});
test('malicious properties, unknown codes and broken logging cannot escape or leak',async t=>{
 let read=0;const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args));
 const getter=Object.defineProperty(new Error('private'), 'code',{get(){read++;throw Error('private');}});
 for(const error of [getter,{code:'private-secret'},Object.create({code:'ECONNRESET'}),null]){
  class Client extends EventEmitter{async connect(){throw error;}async query(){return {rows:[]};}async end(){}}
  const r=createCloudflarePostgres(Client,config);await assert.rejects(r.pool.connect(),denied);await r.close();
  assert.deepEqual(logs.at(-1),['UA_DATABASE_FAILURE','CONNECT','OTHER']);
 }
 assert.equal(read,0);assert(!JSON.stringify(logs).includes('private'));
 console.warn=()=>{throw Error('broken sink');};
 class Client extends EventEmitter{async connect(){throw {code:'53300'};}async query(){return {rows:[]};}async end(){}}
 const r=createCloudflarePostgres(Client,config);await assert.rejects(r.pool.connect(),denied);await r.close();
});
