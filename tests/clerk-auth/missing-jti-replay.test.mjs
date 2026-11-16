import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createClerkVerifier, clerkReplayIdentity } from '../../supabase/functions/univeracademy-api/clerk-auth.ts';
import { clerkFixture, users, sids } from './fixture.mjs';

function signatureAlias(token) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(token.at(-1));
  assert.equal(token.split('.')[2].length % 4, 2); // RSA-2048 signature has four unused pad bits
  return token.slice(0, -1) + alphabet[(last & 48) | ((last + 1) & 15)];
}

test('only missing-jti verified v2 gets signed-input fingerprint; aliases cannot bypass replay namespace', async () => {
  const f = await clerkFixture(), verify = createClerkVerifier(f.verifier);
  const token = await f.sign({ claims: { jti: undefined } });
  const proof = await verify(token), alias = signatureAlias(token);
  assert.equal(proof.tokenIdKind, 'signed_input_sha256_v1');
  assert.equal(proof.tokenId, createHash('sha256').update(token.slice(0, token.lastIndexOf('.'))).digest('hex'));
  assert.deepEqual(await verify(alias), proof);
  const old = await verify(await f.sign({ claims: { jti: proof.tokenId } }));
  assert.equal(Object.hasOwn(old, 'tokenIdKind'), false);
  assert.equal(clerkReplayIdentity(old), JSON.stringify([old.issuer, old.userId, old.sessionId, old.tokenId]));
  assert.notEqual(clerkReplayIdentity(old), clerkReplayIdentity(proof));
  for (const claims of [{ jti: null }, { jti: '' }, { jti: 2 }, { jti: undefined, v: 1 },
    { jti: undefined, v: undefined }, { jti: undefined, v: '2' },
    { jti: undefined, exp: Math.floor(f.store.time / 1000) }, { jti: undefined, azp: 'https://wrong.invalid' }]) {
    await assert.rejects(verify(await f.sign({ claims })), e => e.status === 401);
  }
  await assert.rejects(verify(token.slice(0, -8) + 'aaaaaaaa'), e => e.status === 401);
  assert.throws(() => clerkReplayIdentity({ ...proof, tokenIdKind: 'unknown' }), e => e.status === 401);
});

test('missing-jti exchange consumes once sequentially/concurrently and retains live provider checks', async () => {
  const f = await clerkFixture({ fresh: true }); f.activate(users.student, sids.first);
  const token = await f.sign({ claims: { jti: undefined } }), alias = signatureAlias(token);
  const outcomes = await Promise.all([f.exchange(token), f.exchange(alias)]);
  assert.deepEqual(outcomes.map(x => x.status).sort(), [200, 409]);
  f.resetHandler();
  assert.equal((await f.exchange(token)).json.error.code, 'CLERK_TOKEN_REPLAY');
  assert.equal(Object.keys(f.store.state.domain.student.people).length, 1);
  assert.equal(Object.keys(f.store.state.consumedTokens).length, 1);
  f.live.get(sids.first).status = 'revoked';
  const next = await f.sign({ claims: { jti: undefined }, headers: { next_issued_token: true } });
  assert.equal((await f.exchange(next)).status, 401);
  assert.equal(Object.keys(f.store.state.consumedTokens).length, 1);
});

test('fingerprint async boundary rechecks expiry without admitting stale proofs', async () => {
  const f = await clerkFixture(); const token = await f.sign({ claims: { jti: undefined } });
  let reads = 0;
  const verify = createClerkVerifier({ ...f.verifier, now: () => ++reads === 1 ? f.store.time : f.store.time + 120000 });
  await assert.rejects(verify(token), e => e.status === 401);
});
