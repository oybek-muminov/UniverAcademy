import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createRequire} from "node:module";

test("unapplied Clerk contract patch resolves on exact baseline, changes only auth security/new exchange, and its new strict schema accepts only empty object",()=>{
  const raw=readFileSync(new URL("../../contracts/review-only.openapi.json",import.meta.url));
  const proposal=JSON.parse(readFileSync(new URL("../../contracts/clerk-auth.proposal.patch.json",import.meta.url)));
  assert.equal(createHash("sha256").update(raw).digest("hex"),proposal.base_openapi_sha256);
  const original=JSON.parse(raw),derived=structuredClone(original);
  for(const op of proposal.json_patch){
    assert.ok(["add","replace"].includes(op.op));
    const parts=op.path.slice(1).split("/").map(p=>p.replace(/~1/g,"/").replace(/~0/g,"~")),key=parts.pop();
    const parent=parts.reduce((value,p)=>{assert.ok(Object.hasOwn(value,p),op.path);return value[p];},derived);
    if(op.op==="replace")assert.ok(Object.hasOwn(parent,key),op.path);
    else assert.ok(!Object.hasOwn(parent,key),op.path);
    parent[key]=structuredClone(op.value);
  }
  assert.equal(derived.info.version,proposal.proposal_version);
  assert.equal(Object.keys(derived.paths).length,Object.keys(original.paths).length+1);
  assert.deepEqual(derived.paths['/auth/clerk'].post.security,[{ClerkSessionBearer:[]}]);
  assert.equal(derived.paths['/auth/clerk'].post.responses['200'].content['application/json'].schema.$ref,'#/components/schemas/SuccessSession');
  assert.deepEqual(derived.paths['/auth/telegram'],original.paths['/auth/telegram']);
  assert.equal(derived.paths['/auth/telegram/link'],undefined);
  for(const [path,value]of Object.entries(original.paths)){
    const updated=structuredClone(derived.paths[path]),before=structuredClone(value);
    for(const method of Object.keys(updated))if(updated[method].security?.some(s=>s.ClerkSessionBearer))updated[method].security=before[method].security;
    assert.deepEqual(updated,before,path);
  }
  const require=createRequire(import.meta.url),{createAjv}=require('../backend/validator/base-ajv-config.cjs');
  const validate=createAjv().compile(derived.components.schemas.ClerkExchangeRequest);
  assert.equal(validate({}),true);
  for(const v of [{person_id:'anything'},{roles:['owner']},{token:'not-in-body'},null,[],''])assert.equal(validate(v),false);
  assert.equal(createHash("sha256").update(readFileSync(new URL("../../contracts/review-only.openapi.json",import.meta.url))).digest("hex"),proposal.base_openapi_sha256);
});
