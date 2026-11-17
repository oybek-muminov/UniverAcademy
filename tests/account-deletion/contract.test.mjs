import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {isDeletionRequestPath} from '../../runtime/account-deletion-api.mjs';
const contract=JSON.parse(readFileSync(new URL('../../contracts/account-deletion.review.openapi.json',import.meta.url)));
test('review fragment exposes only exact deletion request/status routes',()=>{
 assert.equal(contract.openapi,'3.1.0');assert.match(contract.info.description,/Default disabled/);
 assert.deepEqual(Object.keys(contract.paths),['/api/v1/me/deletion','/api/v1/me/deletion/status']);
 for(const path of Object.keys(contract.paths))assert.equal(isDeletionRequestPath(path),true);
 assert.equal(isDeletionRequestPath('/api/v1/me/deletion/'),false);
});
test('contract binds app and Clerk proof together; no client chosen identity',()=>{
 const post=contract.paths['/api/v1/me/deletion'].post;
 assert.deepEqual(post.security,[{CabinetBearer:[],ClerkProof:[]}]);
 const shape=post.requestBody.content['application/json'].schema;
 assert.equal(shape.additionalProperties,false);assert.deepEqual(shape.required,['requestId','receipt','confirmation']);
 assert.equal(shape.properties.confirmation.const,'delete-account-v1');
 assert.deepEqual(Object.keys(shape.properties),['requestId','receipt','confirmation']);
 assert.equal(contract.components.securitySchemes.DeletionReceipt.in,'header');
 assert.match(contract.paths['/api/v1/me/deletion/status'].get.responses['404'].description,/never completion|uncertainty/);
});
