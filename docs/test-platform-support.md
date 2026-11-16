# Test platform support

## Path-containment guard

`apps/mini-app/tests/path-containment.test.mjs` exercises Node's explicit `win32`
and `posix` path implementations on any supported host. The production target
integrity guard uses the native implementation only after resolving the target's
real path. Passing the pure Windows path cases is not a Windows filesystem or
browser end-to-end acceptance claim.

## Directory durability fixture

`tests/storage-auth/disk-executor.mjs` is a test-only SQL executor double, not a
production database. Its `durableWrite` deliberately retains this strict order:
file write, file fsync, file close, rename, parent-directory open/fsync/close.
Any failure still propagates. In particular, directory `EPERM` must not be
silently ignored, and a successful rename is not a directory durability receipt.

The directory-fsync-backed cases require a Linux host with a filesystem that
supports these operations. They are not currently supported on Windows, where
opening/flushing directories through this Node API may fail. Run them in the
Linux CI job; do not label a skipped or failed Windows durability run as PASS.
This limitation does not disable unrelated API, authentication, or path tests.

These entrypoints import that fixture directly or transitively:

- `tests/clerk-auth/domain-executor-shapes.test.mjs`
- `tests/clerk-auth/domain-http.test.mjs`
- `tests/clerk-auth/domain-session-rows.test.mjs`
- `tests/enrollment/identity-staff.test.mjs`
- `tests/first-test/cors.test.mjs`
- `tests/first-test/http.test.mjs`
- `tests/persistent-http/http.test.mjs`
- `tests/storage-auth/context-protocol.test.mjs`
- `tests/storage-auth/storage.test.mjs`
- `tests/vercel-node/adapter.test.mjs`

Some files mix disk-backed and independent cases. A future Windows test runner
must mark only the directory-durability-dependent cases with an explicit skip
reason, while retaining all independent assertions and the full Linux run.
This patch does not add a broad file skip or weaken the fixture's error semantics.
