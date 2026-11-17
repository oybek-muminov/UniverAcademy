# Provider instance binding (review candidate)

Before each recovery DELETE, the same fixed Clerk API origin and secret key must return:
1. `GET /v1/instance`: `id` equals independently reviewed deployment `expectedInstanceId`, and `environment_type` is `production`.
2. `GET /v1/domains`: a non-satellite entry has `frontend_api_url` exactly equal to the verified/pinned `expectedIssuer`.
3. The claimed job issuer must equal that expected issuer; it is supplied as the second transport argument.

No response-provided URL is fetched. Secret keys only go to `https://api.clerk.com`. Readiness is repeated, not cached as a boolean. A user404 is accepted only after both readiness requests. Any readiness redirect, 404, invalid shape, wrong instance, wrong issuer, timeout, oversized body or denied request keeps the job frozen. Configuration must come from reviewed deployment, never a client request. Rotation requires updating the actual key without weakening the pinned instance/issuer.

There is one total deadline across readiness and deletion, with a bounded body per response. All verification here uses simulated transport. No production Clerk call or deletion was performed. Endpoint permissions and actual production shapes still require authorized read-only readiness validation before mounting.

Official sources checked 2026-11-17:
- https://clerk.com/docs/reference/backend/instance/get
- https://clerk.com/docs/reference/backend/types/backend-instance
- https://raw.githubusercontent.com/clerk/javascript/main/packages/backend/src/api/endpoints/DomainApi.ts
- https://raw.githubusercontent.com/clerk/javascript/main/packages/backend/src/api/resources/Domain.ts
