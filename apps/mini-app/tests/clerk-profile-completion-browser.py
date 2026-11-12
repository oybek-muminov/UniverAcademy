"""Existing UI only; synthetic SDK + ephemeral loopback RAM Backend, no providers."""
import json
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

args = json.loads(sys.stdin.readline())
assert all(urlsplit(args[k]).hostname == '127.0.0.1' for k in ['assets', 'api'])
scenario = args['scenario']
private_proofs = list(args['proofs'])
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': args['width'], 'height': 900})
        page.set_default_timeout(10000)
        errors, blocked, audit = [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        def route(r):
            u = urlsplit(r.request.url)
            if u.scheme == 'https' and u.netloc == 'app.example.test':
                path = u.path if u.path.startswith('/assets/') else '/tests/clerk-prebuilt.fixture.html'
                r.fulfill(response=r.fetch(url=args['assets'] + path))
            elif u.scheme == 'https' and u.netloc == 'api.example.test' and u.path.startswith('/api/v1/'):
                assert '/admin/' not in u.path and not u.path.endswith('/link') and '/auth/telegram' not in u.path
                headers = {k: v for k, v in r.request.all_headers().items() if k != 'origin'}
                response = r.fetch(url=args['api'].removesuffix('/api/v1') + u.path, headers=headers)
                r.fulfill(response=response, headers={**response.headers, 'access-control-allow-origin': 'https://app.example.test'})
            else:
                blocked.append(u.netloc)
                r.abort()
        page.route('**/*', route)
        def record(r):
            if urlsplit(r.url).netloc == 'api.example.test':
                audit.append({'method': r.request.method, 'path': urlsplit(r.url).path, 'status': r.status})
        page.on('response', record)
        def count(method, path):
            return len([r for r in audit if r['method'] == method and r['path'] == path])
        def proof(index):
            value = args['proofs'][index]
            args['proofs'][index] = None
            page.evaluate('''value => { window.__UA_PREBUILT_TEST_PROOF__ = async () => {
                if (!value) throw new Error('SYNTHETIC_PROOF_CONSUMED'); const proof = value; value = null; return proof;
            }; }''', value)
        def enter(index):
            page.goto('https://app.example.test/sign-in?cached=1&webview=1')
            expect(page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish', exact=True)).to_be_visible()
            assert page.get_by_role('heading', name='Mening testlarim', exact=True).count() == 0
            page.evaluate('__UA_PREBUILT_TEST_SESSION__', args['sessionId'])
            proof(index)
            with page.expect_response(lambda r: r.request.method == 'GET' and urlsplit(r.url).path == '/api/v1/me'):
                page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish', exact=True).click()
        def cabinet():
            expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
            expect(page.get_by_role('heading', name='Hozircha test yo‘q', exact=True)).to_be_visible()
            assert page.get_by_label('Ism', exact=True).count() == 0
        enter(0)
        if scenario in ['first-only-edit-reload', 'last-only']:
            expect(page.get_by_role('heading', name='Avval tanishib olaylik', exact=True)).to_be_visible()
            expect(page.get_by_label('Ism', exact=True)).to_have_value('' if scenario == 'last-only' else 'Server Ism')
            expect(page.get_by_label('Familiya', exact=True)).to_have_value('Server Familiya' if scenario == 'last-only' else '')
            assert count('PATCH', '/api/v1/me') == 0 and count('GET', '/api/v1/exams') == 0
            if scenario == 'first-only-edit-reload':
                page.get_by_label('Ism', exact=True).fill('Tahrirlangan Ism')
                page.get_by_label('Familiya', exact=True).fill('Tahrirlangan Familiya')
                with page.expect_response(lambda r: r.request.method == 'PATCH' and urlsplit(r.url).path == '/api/v1/me') as saved:
                    page.get_by_role('button', name='Davom etish →', exact=True).click()
                assert saved.value.status == 200
                assert saved.value.request.post_data_json == {'first_name': 'Tahrirlangan Ism', 'last_name': 'Tahrirlangan Familiya'}
                cabinet()
                enter(1)
                cabinet()
                expect(page.locator('.student-line strong')).to_have_text('Tahrirlangan Ism')
                assert count('PATCH', '/api/v1/me') == 1  # Completed stored names are never rewritten on login.
        elif scenario == 'patch503':
            expect(page.get_by_role('alert')).to_be_visible()
            page.wait_for_timeout(100)
            assert count('PATCH', '/api/v1/me') == 1
            assert [r['status'] for r in audit if r['method'] == 'PATCH'] == [503]
            assert count('GET', '/api/v1/exams') == 0
            assert page.get_by_role('heading', name='Mening testlarim', exact=True).count() == 0
        else:
            cabinet()
            assert count('PATCH', '/api/v1/me') == (0 if scenario == 'completed' else 1)
            assert count('GET', '/api/v1/exams') == 1
            expect(page.locator('.student-line strong')).to_have_text('Edited Ism' if scenario == 'completed' else 'Server Ism')
        assert not errors, errors
        assert not blocked, blocked
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        public = page.content() + page.url + page.evaluate('JSON.stringify({local: {...localStorage}, session: {...sessionStorage}})')
        assert all(value not in public for value in private_proofs)
        print(json.dumps({'scenario': scenario, 'width': args['width'], 'result': 'PASS', 'audit': audit,
                          'browser_errors': 0, 'external_requests': 0, 'proof_leakage': False, 'overflow': False,
                          'scope': 'synthetic SDK + loopback RAM, no provider/SQL/real WebView'}))
    finally:
        browser.close()
