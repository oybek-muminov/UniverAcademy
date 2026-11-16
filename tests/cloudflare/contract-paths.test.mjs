import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {contractPaths,isContractPath} from '../../runtime/contract-paths.mjs';
test('route inventory exactly matches immutable student and staff contracts',()=>{
 const paths=['student','staff'].flatMap(name=>Object.keys(JSON.parse(readFileSync(new URL(`../../packages/api-client/${name}-openapi.json`,import.meta.url))).paths));
 assert.deepEqual(contractPaths,[...new Set(paths)].sort());
 for(const path of contractPaths){const resolved=path.replace(/\{[a-z_]+\}/g,'id');assert(isContractPath('/api/v1'+resolved));assert(isContractPath('/api/v1'+resolved+'/'));}
});
