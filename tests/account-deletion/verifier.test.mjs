import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createDeletionVerifier} from '../../runtime/account-deletion-verifier.mjs';
const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk={...await exportJWK(publicKey),kid:'test'};
const issuer='https://clerk.example.com',azp='https://mini.example.com',iat=1000000;
let now=iat*1000;
const verify=createDeletionVerifier({issuer,authorizedParties:[azp],audience:{kind:'clerk_default_no_audience'},trustedKeys:createLocalJWKSet({keys:[jwk]}),now:()=>now});
async function token(claims={}){return new SignJWT({iss:issuer,sub:'user_a',sid:'sess_a',iat,nbf:iat,exp:iat+300,azp,v:2,jti:'one',fva:[0,-1],...claims}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey)}
test('signed fva accepted only after existing verifier',async()=>{now=iat*1000;const value=await verify(await token());assert.equal(value.proof.userId,'user_a');assert.equal(value.firstFactorVerifiedAfter,now-60000);});
for(const fva of [undefined,[-1,-1],[5,-1],[4,-1],[0],[0,-1,0],['0',-1]])test('bad/stale fva '+JSON.stringify(fva),async()=>{now=iat*1000;await assert.rejects(verify(await token({fva})));});
test('freshness ages with signed token rather than request time',async()=>{const raw=await token({fva:[3,-1]});now=iat*1000+60000;await assert.rejects(verify(raw),{code:'REVERIFICATION_REQUIRED'});});
test('unsigned fva tamper denied',async()=>{now=iat*1000;const raw=await token({fva:[100,-1]});const [h,p,s]=raw.split('.');const edited={...JSON.parse(Buffer.from(p,'base64url')),fva:[0,-1]};await assert.rejects(verify([h,Buffer.from(JSON.stringify(edited)).toString('base64url'),s].join('.')));});
