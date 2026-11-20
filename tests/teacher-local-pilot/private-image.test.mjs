import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privatePng } from '../../runtime/teacher-local-ui/private-image.mjs';

const svg = body => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16">' + body + '</svg>');
test('static SVG produces real PNG pixels and can be read back as a PNG', async () => {
  const first = await privatePng(svg('<rect width="20" height="12" fill="#218564"/>'),'image/svg+xml');
  assert.equal(first.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const second = await privatePng(first,'image/png');
  assert.equal(second.readUInt32BE(16),32);
  assert.equal(second.readUInt32BE(20),16);
});
test('unsupported image formats, XML features and oversized drawings get a bounded error', async () => {
  await assert.rejects(privatePng(svg('<filter/>'),'image/svg+xml'),{code:'INVALID_IMAGE'});
  await assert.rejects(privatePng(svg('<rect/>'),'image/png'),{code:'INVALID_IMAGE'});
  await assert.rejects(privatePng(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="8"/>'),'image/svg+xml'),{code:'INVALID_IMAGE'});
  await assert.rejects(privatePng(Buffer.alloc(256*1024+1),'image/svg+xml'),{code:'FILE_TOO_LARGE'});
});
