import test from 'node:test';
import assert from 'node:assert/strict';
import { errors } from 'jose';
import { createClerkVerifier } from '../../supabase/functions/univeracademy-api/clerk-auth.ts';
import { clerkFixture } from './fixture.mjs';

test('verifier logs fixed rejection categories without changing proof, status or disclosing data', async t => {
  const original = console.warn, events = [];
  console.warn = (...args) => events.push(args);
  t.after(() => { console.warn = original; });
  const f = await clerkFixture(), verify = createClerkVerifier(f.verifier), token = await f.sign();
  const proof = await verify(token);
  assert.equal(proof.kind, 'clerk_verified'); assert.equal(events.length, 0);
  for (const [claims, reason] of [
    [{ azp: 'https://private.example.invalid' }, 'AUTHORIZED_PARTY_INVALID'],
    [{ v: 1 }, 'VERSION_INVALID'], [{ aud: 'private-audience' }, 'AUDIENCE_UNEXPECTED'],
  ]) {
    await assert.rejects(verify(await f.sign({ claims })), e => e.status === 401 && e.code === 'CLERK_TOKEN_INVALID');
    assert.deepEqual(events.pop(), ['UA_CLERK_VERIFICATION_DENIED', reason]);
  }
  for (const [claims, reason] of [
    [{ jti: undefined }, 'CLAIM_JTI_V2'],
    [{ jti: undefined, v: 1 }, 'CLAIM_JTI_VERSION_OTHER'],
    [{ jti: undefined, v: '2' }, 'CLAIM_JTI_VERSION_OTHER'],
    [{ jti: undefined, v: null }, 'CLAIM_JTI_VERSION_OTHER'],
    [{ jti: undefined, v: undefined }, 'CLAIM_V'],
  ]) {
    await assert.rejects(verify(await f.sign({ claims })), e => e.status === 401);
    assert.deepEqual(events.pop(), ['UA_CLERK_VERIFICATION_DENIED', reason]);
  }
  const malicious = new errors.JWTClaimValidationFailed('private-error-message', { sub: 'private-person' }, 'private-claim', 'check_failed');
  const bad = createClerkVerifier({ ...f.verifier, trustedKeys: async () => { throw malicious; } });
  await assert.rejects(bad(token), e => e.status === 401);
  assert.deepEqual(events.pop(), ['UA_CLERK_VERIFICATION_DENIED', 'CLAIM_INVALID']);
  const unavailable = createClerkVerifier({ ...f.verifier, trustedKeys: async () => { throw new errors.JWKSTimeout('private-timeout'); } });
  await assert.rejects(unavailable(token), e => e.status === 503);
  assert.deepEqual(events.pop(), ['UA_CLERK_VERIFICATION_DENIED', 'KEY_SERVICE_UNAVAILABLE']);
  console.warn = () => { throw new Error('private-sink-error'); };
  await assert.rejects(bad(token), e => e.status === 401 && e.code === 'CLERK_TOKEN_INVALID');
  await assert.rejects(unavailable(token), e => e.status === 503);
  assert.deepEqual(await verify(token), proof);
});
