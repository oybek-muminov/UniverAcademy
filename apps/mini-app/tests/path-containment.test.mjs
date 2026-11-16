import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { isStrictlyWithin } from './path-containment.mjs';

const cases = [
  [posix, '/repo', '/repo/src/file', true],
  [posix, '/repo', '/repo', false],
  [posix, '/repo', '/', false],
  [posix, '/repo', '/outside/file', false],
  [posix, '/repo', '/repo-other/file', false],
  [posix, '/repo', '/repo/../outside/file', false],
  [posix, '/repo', '/repo/..notes/file', true],
  [posix, 'repo', '/repo/file', false],
  [posix, '/repo', 'repo/file', false],
  [win32, 'C:\\repo', 'C:\\repo\\src\\file', true],
  [win32, 'C:\\repo', 'c:/REPO/src/file', true],
  [win32, 'C:\\repo', 'C:\\repo', false],
  [win32, 'C:\\repo', 'C:\\', false],
  [win32, 'C:\\repo', 'C:\\outside\\file', false],
  [win32, 'C:\\repo', 'C:\\repo-other\\file', false],
  [win32, 'C:\\repo', 'C:\\repo\\..\\outside\\file', false],
  [win32, 'C:\\repo', 'C:\\repo\\..notes\\file', true],
  [win32, 'C:\\repo', 'D:\\repo\\file', false],
  [win32, 'C:\\repo', 'C:repo\\file', false],
  [win32, '\\\\server\\share\\repo', '\\\\server\\share\\repo\\file', true],
  [win32, '\\\\server\\share\\repo', '\\\\server\\share\\outside', false],
  [win32, '\\\\server\\share\\repo', '\\\\server\\other\\repo\\file', false],
  [win32, '\\\\server\\share\\repo', '\\\\other\\share\\repo\\file', false],
];
for (const [paths, root, target, expected] of cases) {
  test(`${paths === win32 ? 'win32' : 'posix'} containment ${JSON.stringify(target)}`, () => {
    assert.equal(isStrictlyWithin(root, target, paths), expected);
  });
}
test('invalid input is not contained', () => {
  assert.equal(isStrictlyWithin(null, '/repo/file', posix), false);
  assert.equal(isStrictlyWithin('/repo', undefined, posix), false);
});
