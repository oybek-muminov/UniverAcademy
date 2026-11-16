import nativePath from 'node:path';

// Pure lexical check of paths already resolved by the caller (e.g. realpath).
// Use one platform's absolute/relative/separator rules throughout. In particular,
// win32.relative can return '..\\outside' or an absolute path on another drive.
export function isStrictlyWithin(root, target, paths = nativePath) {
  if (typeof root !== 'string' || typeof target !== 'string'
      || !paths.isAbsolute(root) || !paths.isAbsolute(target)) return false;
  const within = paths.relative(root, target);
  return within !== '' && within !== '..'
    && !within.startsWith('..' + paths.sep) && !paths.isAbsolute(within);
}
