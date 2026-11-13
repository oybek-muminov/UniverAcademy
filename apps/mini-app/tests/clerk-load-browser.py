"""No real provider: production bundle/SDK loader, all non-app URLs intercepted.
No preventDefault or global rejection suppression. Keep observing beyond the
original 15-second poller to detect detached late rejections as well.
"""
import json
import shutil
import sys
import time
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
args = json.loads(sys.stdin.readline())
assert urlsplit(args['assets']).hostname == '127.0.0.1'
cases = ['empty-socket'] if args.get('emptySocket') else ['abort-js'] if args['baseline'] or args['dev'] else ['abort-js', 'empty-js', 'abort-ui']
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        for case in cases:
            page = browser.new_page(); page.set_default_timeout(22000)
            errors, sdk, api, unexpected = [], [], [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.add_init_script('''window.__OBS_TEST_REJECTIONS__ = [];
                addEventListener('unhandledrejection', e => { window.__OBS_TEST_REJECTIONS__.push(e.reason?.code || e.reason?.message || 'unknown'); });''')
            def route(r):
                u = urlsplit(r.request.url)
                if u.netloc == 'app.example.test':
                    path = '/tests/clerk-load.fixture.html' if args['dev'] and u.path == '/sign-in' else u.path
                    response = r.fetch(url=args['assets'] + path + ('?' + u.query if u.query else ''))
                    r.fulfill(response=response)
                elif u.netloc == 'api.example.test':
                    api.append(u.path); r.abort()
                elif 'clerk' in u.netloc and u.netloc.endswith('.example.test'):
                    sdk.append(u.path)
                    if 'clerk.browser.js' in u.path and case in ['empty-js', 'abort-ui']:
                        source = '/* synthetic missing SDK global */' if case == 'empty-js' else (
                            'window.Clerk={loaded:false,load:async()=>{window.__OBS_TEST_LOAD_CALLS__=1;throw new Error("UNEXPECTED_TEST_SDK_LOAD")}};')
                        r.fulfill(status=200, content_type='application/javascript', body=source,
                            headers={'access-control-allow-origin': '*'})
                    else: r.abort()
                else:
                    unexpected.append(u.netloc); r.abort()
            page.route('**/*', route)
            started = time.monotonic(); page.goto('https://app.example.test/sign-in')
            if args.get('emptySocket'):
                expect(page.get_by_role('status')).to_have_text('Kabinetga ulanish hali tayyor emas. Keyinroq qayta oching.')
                page.wait_for_timeout(750)
                assert not sdk and not api and not unexpected and not errors
                assert page.locator('input').count() == 0
                print(json.dumps({'case': 'empty-socket', 'status': 'PASS', 'sdk_requests': 0, 'api_calls': 0, 'actual_provider_network': 0, 'form_mounted': False}))
                page.close(); continue
            expect(page.get_by_role('status')).to_have_text('Kirish xizmati javob bermadi. Keyinroq qayta urinib ko‘ring.', timeout=22000)
            failure_ms = round((time.monotonic() - started) * 1000)
            page.wait_for_timeout(max(0, 17500 - (time.monotonic() - started) * 1000))
            rejected = page.evaluate('__OBS_TEST_REJECTIONS__')
            assert sdk and not api and not unexpected
            assert page.get_by_role('heading', name='Mening testlarim', exact=True).count() == 0
            assert page.locator('input').count() == 0
            assert not page.evaluate('window.__OBS_TEST_LOAD_CALLS__ || 0')
            if case == 'abort-ui': assert any('ui.browser.js' in path or 'clerk-ui' in path for path in sdk), sdk
            if args['baseline']:
                assert len(errors) == len(rejected) == 1, (errors, rejected)
                assert rejected[0] == 'failed_to_load_clerk_js', rejected
            else: assert not errors and not rejected, (errors, rejected)
            # Negative control: unrelated failures are still observable.
            before = len(errors)
            page.evaluate('void Promise.reject(new Error("UNRELATED_OBS_NEGATIVE_CONTROL"))')
            page.wait_for_function('__OBS_TEST_REJECTIONS__.includes("UNRELATED_OBS_NEGATIVE_CONTROL")')
            page.wait_for_timeout(50)
            assert len(errors) == before + 1 and 'UNRELATED_OBS_NEGATIVE_CONTROL' in errors[-1]
            print(json.dumps({'case': case, 'mode': 'dev' if args['dev'] else 'production',
                'status': 'REPRODUCED_OBS_LOAD_1' if args['baseline'] else 'PASS',
                'safe_failure_ms': failure_ms, 'SDK_unhandled_count': len(rejected),
                'api_calls': len(api), 'cabinet_opened': False, 'unrelated_rejection_observable': True,
                'actual_provider_network': 0, 'observation_ms': 17500}))
            page.close()
    finally: browser.close()
