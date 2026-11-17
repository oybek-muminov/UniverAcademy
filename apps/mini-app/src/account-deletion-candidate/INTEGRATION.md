# Account deletion candidate: local integration only

Deletion/reverification remains disabled-default and unmounted. Only exact public
`/account-deletion-status` is locally mounted in main.tsx before every authentication
or demo branch. No deployment or actual account deletion was performed.

## Deletion submission contract

Controller requires explicit versioned `delete-account-v1` confirmation, fresh same
Clerk identity, and captured cabinet scope. Real `useReverification` integration is
still required: first-factor conservative fva age<5minutes, fresh skipCache token,
identity checks before/after awaits. Never use getToken alone as reverification.
Do not wrap destructive submission in automatic SDK retry callbacks.
Reference: https://clerk.com/docs/guides/secure/reverification

HTTP port POST `/api/v1/me/deletion` sends requestId,receipt,confirmation JSON;
Authorization carries captured app bearer and x-clerk-token carries fresh Clerk JWT.
Only backend-guaranteed pre-acceptance401/403 is definite rejection. All other errors
remain ambiguous. GET `/api/v1/me/deletion/status` uses x-deletion-receipt only.
404 is unavailable, never completion. Both paths omit credentials/referrer, reject
redirects, disable cache and have whole-fetch/body deadlines(default10s, bounded5–15s).
Timeout aborts transport and releases UI via Promise.race, retaining recovery receipt.

## Durable receipts and public recovery

Receipt is32random bytes in canonical base64url43, requestId is independent UUID.
Persist both scoped store AND public index before sending. Compose via
withRecoveryIndex(scopedStore,index); any write failure prevents submission. Failed
scoped write rolls back only its exact unsubmitted index ticket if possible.
Index uses one localStorage key per random requestId, with only requestId+receipt;
no PII, Clerk token or app token. Separate keys prevent cross-tab index overwrites.
There is NO arbitrary20ticket cap. Storage quota failure remains fail-closed.

Definite pre-acceptance rejection or authoritative completion may remove its exact
scoped+index receipt. Scoped removal receives expected requestId+receipt and refuses
to erase a newer receipt written by another tab. Unknown/pending/expired results
retain receipts indefinitely; they are never auto-evicted or manually forgettable.

Public recovery-entry uses pure HTTPS/page-origin VITE_MINI_APP_ORIGIN/VITE_API_ORIGIN
validation without importing authentication bootstrap. No /me fetch, Clerk bootstrap
or active app session is required. Explicit numbered selection and explicit polling;
no automatic network request. Missing config/storage and empty index have neutral UI.
Receipt never appears in URL, rendered text, logs or analytics. Shared-device warning
explains the request might belong to another user. Only generic status is displayed.
No recovery action clears current account sessions or signs anybody out.

After remote completed ONLY, the user can explicitly forget that device's receipt
with two-step confirmation and cancel. This local-only action compares exact stored
requestId+receipt; changed capability or storage errors retain error state. It never
calls the network or changes an account. Pending/unknown/404 have no forget control.

## Validation

`node --test apps/mini-app/tests/account-deletion-{candidate,recovery}.test.mjs`
`npm --prefix apps/mini-app run check`

Tests cover receipt recovery, ambiguous failures, exact cleanup, rejection lifecycle,
partial-write rollback, multi-tab preservation, completed-only forget, deadlines,
and transformed-main public-route smoke verifying auth modules are not imported.
These tests are not real Clerk/browser E2E or production evidence. Before enabling
deletion, validate real reverification, deployed status availability/CORS, saga
recovery and browser navigation after server revokes app sessions.

Scoped storage also uses separate immutable requestId keys under the account scope
prefix, not a mutable singleton. read selects the lexicographically first retained
receipt; public recovery lists all. Removing an old request cannot remove another
request inserted by another tab between getItem and removeItem. No migration is
needed because this candidate was never deployed. Adversarial interleaving tested.

## Real auth-host integration (local, feature gated)

AccountDeletionHost now binds the real useReverification proof-only callback, fresh
skipCache token and same Clerk user/session to the captured ready cabinet. It renders
confirmation/status and passes onDeleteAccount/deletionBusy into StudentApp, without
editing dashboard files. VITE_ACCOUNT_DELETION_ENABLED must explicitly equal true.
Missing active Clerk shows reauthentication required, never invokes deletion.

Owner auth.createDeletionPort(expectedPerson) keeps app bearer inside trusted owner
transport. Mutation withAccess executes once; HTTP outcome is captured as a value
inside action so definite rejection survives normalization without clearing session.
Person checks surround submission. Status uses receipt alone even after tokens revoke.

Pending/unknown state exposes a receipt-free public recovery link, also available when
Clerk is unavailable. Completion clears only the matching captured cabinet and routes
to public recovery. Confirmed completion now retains public receipt while removing
scoped receipt; definite rejection removes both. Thus public recovery can independently
confirm completed and offer explicit local forget. URL never claims success.
