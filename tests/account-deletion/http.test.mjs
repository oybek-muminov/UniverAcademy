import test from 'node:test';import assert from 'node:assert/strict';
import {createDeletionHttp} from '../../runtime/account-deletion-http.mjs';
const origin='https://mini.example.com';
const body={confirmation:'delete-account-v1',receipt:'opaque',requestId:'uuid'};
function fixture(){let calls=[];const handler=createDeletionHttp({allowedOrigins:[origin],requests:{submit:async x=>{calls.push(x);return {status:'pending'}},status:async()=>({status:'completed'})}});return {handler,calls};}
const request=(patch={})=>new Request('https://api.example.com/api/v1/me/deletion',{method:'POST',headers:{origin,authorization:'Bearer access','x-clerk-token':'jwt','content-type':'application/json'},body:JSON.stringify(body),...patch});
test('accepted202 no-cache',async()=>{const {handler,calls}=fixture();const r=await handler(request());assert.equal(r.status,202);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(calls[0].accessToken,'access');});
test('cross origin or missing origin denied before prepare',async()=>{const {handler,calls}=fixture();for(const o of ['', 'https://evil.example']){const r=request();r.headers.set('origin',o);assert.equal((await handler(r)).status,403);}assert.equal(calls.length,0);});
test('client identity injection rejected',async()=>{const {handler,calls}=fixture();assert.equal((await handler(request({body:JSON.stringify({...body,userId:'user_other'})}))).status,400);assert.equal(calls.length,0);});
test('oversize body rejected',async()=>{const {handler}=fixture();assert.equal((await handler(request({body:' '.repeat(3000)}))).status,400);});
test('receipt never in URL',async()=>{const {handler}=fixture();const r=await handler(new Request('https://api.example.com/api/v1/me/deletion/status?receipt=secret',{headers:{origin}}));assert.equal(r.status,404);});
test('unknown error is sanitized',async()=>{const handler=createDeletionHttp({allowedOrigins:[origin],requests:{submit:async()=>{throw Error('secret')}}});const r=await handler(request());assert.equal(r.status,503);assert.equal((await r.text()).includes('secret'),false);});
