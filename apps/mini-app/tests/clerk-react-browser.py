"""Real @clerk/react package/hooks; synthetic client/JWT, real RAM Backend HTTP."""
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

args = json.loads(sys.stdin.readline())
assert all(urlsplit(args[k]).hostname == '127.0.0.1' for k in ['assets', 'api'])
screens = Path(args['screens']); screens.mkdir(parents=True, exist_ok=True)
scenario = args['scenario']
match = lambda method, path: lambda r: r.request.method == method and urlsplit(r.url).path == path
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': 390, 'height': 900}); page.set_default_timeout(10000)
        errors, blocked, audit, referrers = [], [], [], []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda message: print('SDK_TEST_CONSOLE ' + message.text, file=sys.stderr) if message.type == 'error' else None)
        def route(r):
            u = urlsplit(r.request.url)
            if u.scheme == 'https' and u.netloc == 'app.example.test':
                if u.path.startswith('/assets/') and r.request.headers.get('referer'): referrers.append(True)
                path = u.path if u.path.startswith('/assets/') else '/tests/clerk-react.fixture.html'
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
            page.evaluate('''value => { window.__UA_REACT_TEST_PROOF__ = async () => {
                if (!value) throw new Error('TEST_PROOF_CONSUMED'); const next = value; value = null; return next;
            }; }''', value)
        def logout():
            with page.expect_response(match('POST', '/api/v1/auth/logout')) as ack:
                page.get_by_role('button', name='Chiqish', exact=True).click()
            assert ack.value.status == 200 and 'authorization' not in ack.value.request.all_headers()
            expect(page.get_by_text('Server sessiya yopilganini tasdiqladi.', exact=True)).to_be_visible()
            page.wait_for_function('__UA_REACT_TEST_AUDIT__().session === null')
        if scenario in ['callback', 'cancel-callback']:
            query = '?state=synthetic-callback-state&code=synthetic-callback-code'
            if scenario == 'cancel-callback': query += '&delay=1'
            page.goto('https://app.example.test/auth/callback' + query)
            if scenario == 'cancel-callback':
                page.wait_for_function('typeof __UA_RELEASE_REACT_FINALIZE__ === "function"')
                page.get_by_role('button', name='Bekor qilish', exact=True).click()
                page.evaluate('__UA_RELEASE_REACT_FINALIZE__()')
                page.wait_for_function('__UA_REACT_TEST_AUDIT__().session === "sess_CallbackFixture"')
                expect(page.get_by_role('status')).to_have_text('Kirish bekor qilindi. Yangidan kirishni boshlashingiz mumkin.')
            else:
                expect(page.get_by_role('status')).to_have_text('Google javobi qabul qilindi. Asosiy kirish oynasiga qayting.')
            expect(page.get_by_role('link', name='Kirish oynasiga qaytish')).to_have_attribute('href', 'https://app.example.test/sign-in')
            assert page.url == 'https://app.example.test/auth/callback'
            assert not audit and page.evaluate('__UA_REACT_TEST_AUDIT__().proofReads') == 0
            assert page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish').count() == 0
        else:
            page.goto('https://app.example.test/sign-in')
            expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible()
            proof(0)
            if scenario == 'explicit-session':
                page.evaluate('__UA_REACT_TEST_EXTERNAL_SESSION__()')
                button = page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish', exact=True)
                expect(button).to_be_visible(); assert not audit
            else:
                button = page.get_by_role('button', name='Google bilan davom etish', exact=True)
            with page.expect_response(match('GET', '/api/v1/exams')):
                with page.expect_response(match('POST', '/api/v1/auth/clerk')) as exchange:
                    button.click()
            assert exchange.value.status == 200 and exchange.value.request.post_data_json == {}
            expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible(); logout()
            if scenario == 'google-email':
                proof(1)
                page.get_by_label('Email', exact=True).fill('student@example.test')
                page.get_by_role('button', name='Tasdiqlash kodini yuborish', exact=True).click()
                page.get_by_label('6 xonali kod').fill('123456')
                with page.expect_response(match('POST', '/api/v1/auth/clerk')) as email:
                    page.get_by_role('button', name='Tekshirish va kirish', exact=True).click()
                assert email.value.status == 200
                expect(page.get_by_role('heading', name='Ism va familiyangiz', exact=True)).to_be_visible()
                page.get_by_label('Ism', exact=True).fill('Suniy'); page.get_by_label('Familiya', exact=True).fill('Review')
                with page.expect_response(match('GET', '/api/v1/exams')) as empty:
                    page.get_by_role('button', name='Davom etish', exact=False).click()
                assert empty.value.json()['data'] == []; logout()
            else:
                count = len(audit); page.evaluate('__UA_REACT_TEST_EXTERNAL_SESSION__()')
                expect(page.get_by_role('button', name='Tasdiqlangan hisob bilan davom etish', exact=True)).to_be_visible()
                assert len(audit) == count
        assert not errors, errors
        assert not blocked, blocked
        assert not referrers
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        page.screenshot(path=str(screens / (scenario + '.png')), full_page=True)
        print(json.dumps({'scenario': scenario, 'status': 'PASS', 'reactSDKPackage': '@clerk/react@6.18.6_REAL_BUNDLED',
            'client_and_proofs': 'SYNTHETIC', 'HTTP': 'REAL_LOOPBACK_RAM', 'apiCalls': len(audit),
            'callbackAutoExchange': 0, 'linkCalls': 0, 'externalRequests': 0, 'realClerkJSProvider': 'NOT_RUN'}))
    except Exception:
        print(json.dumps({'scenario': scenario, 'errors': errors, 'blocked': blocked,
            'body': page.locator('body').inner_text()[:300]}), file=sys.stderr)
        raise
    finally:
        browser.close()
