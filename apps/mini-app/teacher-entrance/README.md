# Ustoz entrance: direct web and Telegram plain URL only

The only entry is https://ustoz.univeracademy.uz/ with no query or fragment. A future Telegram bot button must be ordinary InlineKeyboardButton.url with that exact HTTPS value, **not** web_app or login_url. Do not append parameters or pass initData to this entrance. The entrance reads only whether query/fragment exists, rejects it, and never parses, logs, forwards, or authorizes with it. Browser/Telegram may choose the UI in which to open a plain URL; independently current Clerk still authenticates there.

Primary email code authenticates an already existing Clerk email (including a verified email used to sign in with Google) without needing a password. No signup, social fallback, transfer, or account creation. Provider-offered email challenge can complete additional device trust; other factors/tasks remain explicitly unsupported. A signed-in session is not Teacher eligibility. By default the signed-in page shows the pending connection notice. With `VITE_USTOZ_CABINET_READ_ENABLED=true` the direct browser session requests its read-only cabinet from the same origin at `GET /api/v1/teacher/cabinet`. Only the server maps the verified session to an existing person. This view shows the approved subjects, active assigned groups and their assigned tests. Changes of account, sign-out and page suspension clear the previous view.

Source references: [Clerk email code](https://clerk.com/docs/guides/development/custom-flows/authentication/email-sms-otp), [React sign-in methods](https://clerk.com/docs/react/reference/objects/sign-in-future), [Clerk Device Trust](https://clerk.com/docs/guides/development/custom-flows/authentication/device-trust), [Telegram Bot API buttons](https://core.telegram.org/bots/api#inlinekeyboardbutton) and [Telegram's WebApp fragment behavior](https://core.telegram.org/api/bots/webapps).

From apps/mini-app with existing exact lockfile dependencies present, run `./node_modules/.bin/vite build --config teacher-entrance/vite.config.mjs --mode production`. Only dist-teacher-entrance is written. For separately reviewed launch, set VITE_USTOZ_CLERK_PUBLISHABLE_KEY to the existing public production key matching clerk.univeracademy.uz, and VITE_USTOZ_EXISTING_EMAIL_SIGNIN_APPROVED=true after verifying Clerk accepts this hostname and method. No key or approved flag is baked into this candidate, no DNS/Clerk settings changed. Canonical publishing, real Clerk host/session/device trust checks, and bot attachment are separate.


The dedicated host must route this GET to `composeTeacherBrowserPilotPostgres` with the teacher reader pool, trusted Clerk verifier, liveness check, and named subject catalog. The existing registration Worker has no such route. Before enabling this feature, verify the teacher reader's scoped access, group name column, and real subject ID and label. Keep the read flag unset for a sign-in-only deployment.

## Teacher and Admin write pilot

For the dedicated Ustoz build, set `VITE_USTOZ_CABINET_WRITE_ENABLED=true` alongside the existing Clerk sign-in approval and the matching publishable key. The default flags preserve the sign-in and read-only configurations described above. Install `apps/mini-app/package-lock.json` before building. The writable cabinet loads after sign-in and fetches the server-authorized teacher dashboard. The teacher creates an active group in one of their approved subjects. The new group is selected immediately for adding members and sharing or sending a Telegram invite. A published test in the same subject can be assigned once the group has members. The rich question editor accepts text, LaTeX, PNG and SVG. KaTeX loads with the first formula and uses the browser’s MathML rendering. Private images are retrieved as authenticated PNG bytes.

The Ustoz page stays at `/`. Its same-origin gateway must forward `/api/v1/teacher/pilot/` and `/api/v1/admin/pilot/` to the authenticated runtime. It must preserve `Authorization`, `Idempotency-Key`, response status, content type and `Cache-Control: no-store`. Test import uses `POST import-preview` and commands use `POST commands/<action>`. The teacher uploads to `POST media` and its previews use `GET media/<uuid>`. Clerk verification and live role/subject/group checks belong to the server.

An authorized Admin can use **Admin bo‘limi** to see the groups in their existing roster scope, with their teachers and statuses. An Admin-only account can open this section from the teacher-denied screen. The list comes from `GET /api/v1/admin/pilot/dashboard`. Teachers create and use their groups entirely in the teacher cabinet.

From repository root run `node --test tests/teacher-staging-pilot/staff-browser.test.mjs` after installing the Mini App and `tests/teacher-local-pilot/tooling` dependencies. The test exercises the actual DOM component with controlled identity and HTTP responses. Staging authentication, gateway and live delivery require their own deployment checks.

### Pages bundle for the Ustoz host

Use `apps/teacher-web/ustoz-pages` as the Pages project directory. Its two file-based Functions forward only `/api/v1/teacher/pilot/*` and `/api/v1/admin/pilot/*`. Both import `runtime/teacher-staging-proxy.mjs` and use the teacher surface. The Mini App has its own Workers configuration under `apps/mini-app`.

With the reviewed Ustoz Vite variables set, run the following from the repository root.

```sh
npm ci --prefix apps/mini-app --ignore-scripts
npm ci --prefix apps/teacher-web/ustoz-pages --ignore-scripts
npm --prefix apps/teacher-web/ustoz-pages run build
npm --prefix apps/teacher-web/ustoz-pages run verify
```

The resulting Pages upload directory is `apps/mini-app/dist-teacher-entrance`. It contains the HTML, fingerprinted assets, `_worker.js/index.js` and `_routes.json`. Verification runs the compiled Pages package against the legacy Node gateway and in local workerd against a named Worker service binding. It covers Teacher and Admin, the origin, header filtering, default-off behavior and static fallback.

On Pages, enable the cabinet with `UA_CABINET_STAGING_ENABLED=true` and set `UA_CABINET_TEACHER_ORIGIN` to the exact Ustoz HTTPS origin. For the Cloudflare-only path, set `UA_CABINET_RUNTIME=worker` and bind `UA_CABINET_API` to service `univeracademy-api`, named entrypoint `TeacherCabinetGateway`. The binding carries the Ustoz URL and existing staff bearer proof. For the legacy Node path, omit the mode or set it to `node` and configure `UA_CABINET_STAGING_NODE_ORIGIN` and `UA_CABINET_STAGING_PROXY_SECRET` for the same Node deployment. Keep the secret in the Pages environment’s secret store. Serve the compiled Pages directory through the existing `univeracademy-ustoz` project. For an explicitly approved release the operator runs the command below from `apps/teacher-web/ustoz-pages`, substituting the approved branch. Building and verifying the package create local files only.

```sh
./node_modules/.bin/wrangler pages deploy ../../mini-app/dist-teacher-entrance --project-name univeracademy-ustoz --branch "${APPROVED_PAGES_BRANCH:?Set the approved Ustoz Pages branch}"
```
