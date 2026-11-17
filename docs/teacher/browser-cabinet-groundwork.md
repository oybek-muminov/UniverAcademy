# Browser teacher cabinet: groundwork, not live integration

Base: main `95c3561c569798e5cff612c25aa9048e900fe3a1`.

## Confirmed product boundaries

- One existing person/account keeps student access when appointed teacher by admin/owner.
- One browser teacher cabinet; no separate teacher Mini App implementation.
- The bot may link to that same browser cabinet. Telegram ID, URL parameters and an
  existing Telegram session do not grant teacher access. Clerk identity and server
  authorization are required at the destination.
- No self-promotion UI, new role mutation, second registration or duplicate backend.
- Account deletion and bot lifecycle work are separate; their files are untouched.

## Implemented here

`apps/teacher-web/` contains a dependency-free browser presentation shell:
profile and approved subjects, scoped group/test lists, student-mode navigation and
sign-out through an injected port. It has loading, signed-out, forbidden, unavailable
and unconfigured states. It renders user text with `textContent`, not HTML.

Loads use abort plus generation checks. Refresh and identity changes clear previous
profile data immediately. Repeat exit clicks are locked; old load success/error cannot
replace new identity. Page hide clears data; Back/Forward restore and visibility return
revalidate instead of restoring cached teacher information. No auth token or identity
is kept in local/session storage, cookies, URL parameters or fixtures in the build.

`src/port.d.ts` is **an internal presentation port, not an accepted HTTP contract**.
The default entry intentionally uses `unconfiguredPort` and performs no network
requests. The fixture page in `tests/browser.html` is synthetic and excluded from build.
Do not deploy this shell as an authenticated teacher cabinet.

## Canonical backend dependencies (not silently invented)

Current `packages/api-client/staff-openapi.json` marks itself PROVISIONAL, NOT ACCEPTED.
Its six `/admin/*` mutations do not supply profile/capability/group/test-list reads.
`runtime/cloudflare-entry.mjs` does not currently route those staff operations.
Existing `staff-state.ts` has approval, subject and group-scope rules and must remain
the authority. The frontend must not copy or override those rules.

Before wiring the port, the Backend owner must provide:

1. Authenticated profile/capability read mapped from verified Clerk subject to one
   person. Teacher/approved/enabled fields come from current server state, not JWT
   metadata alone or a UI-selected role.
2. Server-scoped, paginated group and test-version reads, including canonical labels,
   contract hash and expiry/revocation behavior. This initial view bounds rows at 500;
   it is not a paging implementation or evidence of platform capacity.
3. Browser origin/Clerk instance and canonical student destination. No production
   hostname or post-auth redirect has been guessed here. Redirect URLs must be trusted
   application configuration, never arbitrary callback query parameters.
4. An adapter that subscribes to Clerk identity/session changes and calls
   `identityChanged()`, obtains current verified server data on each load, uses Clerk
   sign-out, and switches to student view without creating another account.
5. Confirmed MVP operations from the separate product conversation before adding
   test upload, publish, group editing, scoring or assignment controls. No unaccepted
   provisional write policy is made executable by this shell.

Every server read and write must enforce scope independently. Frontend checks are
only defense-in-depth and presentation, never an authorization boundary.

## Validation

```
npm --prefix apps/teacher-web test
npm --prefix apps/teacher-web run build
```

21 unit tests passed; static build and `git diff --check` passed. A DOM flow/XSS fixture
is available at `tests/browser.html?check` when served locally. Chromium could not
start in this execution environment (`socket() failed: Operation not permitted`),
including the approved escalation attempt, so browser interaction and visual QA
are **NOT RUN**, not passed. Live Clerk/server integration, provider configuration and deployment were not
performed. Source publication does not activate this shell or configure its adapter.
The dedicated teacher-web CI runs the isolated tests and static build on changes.
