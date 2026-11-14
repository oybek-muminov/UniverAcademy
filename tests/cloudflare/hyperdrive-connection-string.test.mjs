import test from 'node:test';
import assert from 'node:assert/strict';
import {isHyperdriveConnectionString as valid} from '../../runtime/hyperdrive-connection-string.mjs';
const base='postgres://synthetic:synthetic@hyperdrive.invalid:5432/synthetic';
test('trusted Hyperdrive URL accepts only no query or exact native local-hop option',()=>{
 for(const suffix of ['', '?sslmode=disable'])assert.equal(valid(base+suffix),true);
 for(const suffix of ['?','?sslmode=require','?sslmode=verify-full','?sslmode=disable&sslmode=disable','?sslmode=disable&x=1','?sslmode=disable&','?%73slmode=disable','?sslmode=%64isable','?SSLMODE=disable','?sslmode=DISABLE','#','?sslmode=disable#fragment'])assert.equal(valid(base+suffix),false,suffix);
 for(const value of [null,undefined,{},'',base+'\n',base.replace(':5432',''),base.replace('synthetic:synthetic@','synthetic@'),base.replace('postgres:','https:')])assert.equal(valid(value),false);
});
