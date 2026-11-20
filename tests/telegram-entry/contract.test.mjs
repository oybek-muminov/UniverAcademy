import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {STUDENT_PROFILE_ACCEPT} from '../../packages/api-client/student-client.ts';
const fragment=JSON.parse(readFileSync(new URL('../../contracts/telegram-atomic-entry.review.openapi.json',import.meta.url)));
test('atomic entry contract accepts only raw launch and explicit confirmation under Clerk bearer',()=>{
 assert.deepEqual(Object.keys(fragment.paths),['/api/v1/auth/telegram/entry']);
 const post=fragment.paths['/api/v1/auth/telegram/entry'].post;
 assert.deepEqual(post.security,[{ClerkBearer:[]}]);
 const schema=post.requestBody.content['application/json'].schema;
 assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.required,['init_data','confirmation']);
 assert.deepEqual(Object.keys(schema.properties),['init_data','confirmation']);
 assert.equal(schema.properties.confirmation.const,'link-telegram-account-v1');
 assert.deepEqual(Object.keys(post.responses['200'].content),[STUDENT_PROFILE_ACCEPT]);
 assert.equal(post.responses['200'].content[STUDENT_PROFILE_ACCEPT].schema.$ref,'./telegram-return.openapi.json#/components/schemas/SuccessSession');
});
