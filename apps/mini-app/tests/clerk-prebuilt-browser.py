"""Actual React SDK SignIn wrapper; synthetic mount implementation and proofs.
The reserved HTTPS->loopback route is only a test bridge, not production CORS.
"""
import json
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

args = json.loads(sys.stdin.readline())
assert all(urlsplit(args[k]).hostname == '127.0.0.1' for k in ['assets', 'api'])
scenario = args['scenario']
match = lambda method, path: lambda r: r.request.method == method and urlsplit(r.url).path == path
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': 390, 'height': 900}); page.set_default_timeout(10000)
        errors, blocked, audit, referrers = [], [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        def route(r):
            u = urlsplit(r.request.url)
            if u.scheme == 'https' and u.netloc == 'app.example.test':
                if u.path.startswith('/assets/') and r.request.headers.get('referer'): referrers.append(True)
                path = u.path if u.path.startswith('/assets/') else '/tests/clerk-prebuilt.fixture.html'
                response = r.fetch(url=args['assets'] + path); r.fulfill(response=response)
            elif u.scheme == 'https' and u.netloc == 'api.example.test' and u.path.startswith('/api/v1/'):
                assert '/admin/' not in u.path and not u.path.endswith('/link')
                headers = {k: v for k, v in r.request.all_headers().items() if k != 'origin'}
                response = r.fetch(url=args['api'].removesuffix('/api/v1') + u.path, headers=headers)
                r.fulfill(response=response, headers={**response.headers, 'access-control-allow-origin': 'https://app.example.test'})
            else:
                blocked.append(u.netloc); r.abort()
        page.route('**/*', route)
        page.on('response', lambda r: audit.append({'method': r.request.method, 'path': urlsplit(r.url).path, 'status': r.status})
            if urlsplit(r.url).netloc == 'api.example.test' else None)
        def proof(index):
            value = args['proofs'][index]; args['proofs'][index] = None
            page.evaluate('''value => { window.__UA_PREBUILT_TEST_PROOF__ = async () => {
                if (!value) throw new Error('TEST_PROOF_CONSUMED'); const next = value; value = null; return next;
            }; }''', value)
        def state(): return page.evaluate('__UA_PREBUILT_TEST_AUDIT__()')
        def session(value): page.evaluate('__UA_PREBUILT_TEST_SESSION__', value)
        def entered(): expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
        def enter():
            with page.expect_response(match('GET', '/api/v1/exams')):
                with page.expect_response(match('POST', '/api/v1/auth/clerk')) as exchange:
                    page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish', exact=True).click()
            assert exchange.value.status == 200 and exchange.value.request.post_data_json == {}; entered()
        def count(path): return len([r for r in audit if r['path'] == path])
        query = '?cached=1' if scenario == 'cached-session' else '?webview=1' if scenario == 'webview' else ''
        page.goto('https://app.example.test/sign-in' + query)
        if scenario == 'webview':
            expect(page.get_by_role('heading', name='Brauzerda davom etish kerak')).to_be_visible()
            assert state()['mounts'] == [] and not audit and state()['proofReads'] == 0
        else:
            if scenario == 'cached-session':
                expect(page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish')).to_be_visible()
                assert state()['mounts'] == [] and not audit and state()['proofReads'] == 0
            else:
                page.get_by_role('button', name='__SDK_TEST_COMPLETE_FORM__', exact=True).click()
                expect(page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish')).to_be_visible()
                assert not audit and state()['proofReads'] == 0
                props = state()['mounts'][0]
                assert props['routing'] == 'hash' and props['withSignUp'] is True and props['oauthFlow'] == 'popup'
                assert props['forceRedirectUrl'] == props['signUpForceRedirectUrl'] == 'https://app.example.test/sign-in'
                assert 'appearance' not in props and 'unsafeMetadata' not in props
            assert page.get_by_label('Email', exact=True).count() == 0  # no custom fallback
            proof(0)
            if scenario in ['cancel-body', 'user-cancel']:
                page.evaluate('__UA_PREBUILT_TEST_HOLD_BODY__ = true')
                page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish').click()
                page.wait_for_function('typeof __UA_PREBUILT_TEST_RELEASE_BODY__ === "function"')
                if scenario == 'user-cancel':
                    page.get_by_role('button', name='Bekor qilish', exact=True).click()
                else:
                    session('sess_ReplacementSynthetic')
                page.evaluate('__UA_PREBUILT_TEST_RELEASE_BODY__()')
                if scenario == 'user-cancel':
                    page.get_by_role('button', name='__SDK_TEST_COMPLETE_FORM__').click()
                expect(page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish')).to_be_visible()
                assert count('/api/v1/me') == 0
                assert page.get_by_role('heading', name='Mening testlarim', exact=True).count() == 0
                assert state()['session'] == ('sess_WidgetSynthetic' if scenario == 'user-cancel' else 'sess_ReplacementSynthetic')
                proof(1); enter()
                assert count('/api/v1/auth/clerk') == 2
            else:
                enter()
                if scenario == 'logout-new-session':
                    original = state()['session']; mount_count = len(state()['mounts'])
                    page.evaluate('__UA_PREBUILT_TEST_DELAY_SIGNOUT__ = true')
                    with page.expect_response(match('POST', '/api/v1/auth/logout')) as out:
                        page.get_by_role('button', name='Chiqish', exact=True).click()
                    assert out.value.status == 200 and 'authorization' not in out.value.request.all_headers()
                    page.wait_for_function('typeof __UA_PREBUILT_TEST_RELEASE_SIGNOUT__ === "function"')
                    assert len(state()['mounts']) == mount_count
                    session('sess_NewDuringLogoutSynthetic')
                    page.evaluate('__UA_PREBUILT_TEST_RELEASE_SIGNOUT__()')
                    expect(page.get_by_text('Server sessiya yopilganini tasdiqladi.', exact=True)).to_be_visible()
                    assert state()['session'] == 'sess_NewDuringLogoutSynthetic' and state()['signOuts'] == [original]
                    assert count('/api/v1/auth/clerk') == 1
                    proof(1); enter(); assert count('/api/v1/auth/clerk') == 2
                elif scenario == 'revoked':
                    session(None)
                    expect(page.get_by_role('button', name='__SDK_TEST_COMPLETE_FORM__')).to_be_visible()
                    assert page.get_by_role('heading', name='Mening testlarim', exact=True).count() == 0
                    assert count('/api/v1/auth/clerk') == 1
                    session('sess_FreshAfterRevocationSynthetic')
                    expect(page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish')).to_be_visible()
                    assert count('/api/v1/auth/clerk') == 1
                    proof(1); enter(); assert count('/api/v1/auth/clerk') == 2
                else:
                    original = state()['session']
                    with page.expect_response(match('POST', '/api/v1/auth/logout')) as out:
                        page.get_by_role('button', name='Chiqish', exact=True).click()
                    assert out.value.status == 200 and 'authorization' not in out.value.request.all_headers()
                    expect(page.get_by_role('button', name='__SDK_TEST_COMPLETE_FORM__')).to_be_visible()
                    expect(page.get_by_text('Server sessiya yopilganini tasdiqladi.', exact=True)).to_be_visible()
                    assert state()['session'] is None and state()['signOuts'] == [original]
                    assert count('/api/v1/auth/clerk') == 1
        assert not errors, errors
        assert not blocked, blocked
        assert not referrers
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        print(json.dumps({'scenario': scenario, 'status': 'PASS', 'SDK': '@clerk/react@6.18.6_REAL_WRAPPER_HOOKS',
            'vendorUI_client_proof': 'SYNTHETIC', 'HTTP': 'REAL_LOOPBACK_RAM', 'apiCalls': len(audit),
            'linkCalls': 0, 'externalRequests': 0, 'vendorFormVisual_realClerkGoogleEmail': 'NOT_RUN'}))
    except Exception:
        print(json.dumps({'scenario': scenario, 'errors': errors, 'blocked': blocked,
            'body': page.locator('body').inner_text()[:300]}), file=sys.stderr)
        raise
    finally:
        browser.close()
