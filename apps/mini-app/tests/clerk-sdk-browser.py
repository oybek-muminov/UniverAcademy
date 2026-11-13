"""Synthetic public SDK facade -> prepared production client -> loopback HTTP."""
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

args = json.loads(sys.stdin.readline())
assert all(urlsplit(args[k]).hostname == '127.0.0.1' for k in ['assets', 'api'])
screens = Path(args['screens']); screens.mkdir(parents=True, exist_ok=True)
match = lambda method, path: lambda r: r.request.method == method and urlsplit(r.url).path == path
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': args['width'], 'height': 900}); page.set_default_timeout(10000)
        errors, blocked, audit = [], [], []
        fault = {'revoke': False}
        page.on('pageerror', lambda _: errors.append(True))
        def route(r):
            u = urlsplit(r.request.url)
            if u.netloc == 'app.example.test' and u.scheme == 'https':
                response = r.fetch(url=args['assets'] + u.path + ('?' + u.query if u.query else '')); r.fulfill(response=response)
            elif u.netloc == 'api.example.test' and u.scheme == 'https' and u.path.startswith('/api/v1/'):
                if fault['revoke'] and r.request.method == 'GET' and u.path.startswith('/api/v1/exams/'):
                    fault['revoke'] = False
                    r.fulfill(status=401, content_type='application/json', headers={'access-control-allow-origin': 'https://app.example.test'},
                        body=json.dumps({'error': {'code': 'CLERK_SESSION_REVOKED', 'message': 'Synthetic SDK UI fault',
                            'request_id': '00000000-0000-4000-8000-000000000902'}}))
                else:
                    # Reserved HTTPS test origin maps to the loopback-only RAM
                    # listener. This injected bridge is not production CORS proof.
                    headers = {k: v for k, v in r.request.all_headers().items() if k != 'origin'}
                    response = r.fetch(url=args['api'].removesuffix('/api/v1') + u.path, headers=headers)
                    r.fulfill(response=response, headers={**response.headers, 'access-control-allow-origin': 'https://app.example.test'})
            else:
                blocked.append(True); r.abort()
        page.route('**/*', route)
        page.on('response', lambda r: audit.append({'method': r.request.method, 'path': urlsplit(r.url).path, 'status': r.status})
            if urlsplit(r.url).netloc == 'api.example.test' else None)
        def proof(index):
            value = args['proofs'][index]; args['proofs'][index] = None
            page.evaluate('''value => { window.__UA_SYNTHETIC_CLERK_SDK_TOKEN__ = async () => {
                if (!value) throw new Error('TEST_PROOF_CONSUMED'); const next = value; value = null; return next;
            }; }''', value)
        def shot(name):
            if args['width'] == 390: page.screenshot(path=str(screens / (name + '.png')), full_page=True)
        def google(index):
            proof(index)
            with page.expect_response(match('GET', '/api/v1/exams')):
                with page.expect_response(match('POST', '/api/v1/auth/clerk')) as response:
                    page.get_by_role('button', name='Google bilan davom etish').click()
            assert response.value.status == 200
            expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
        def logout():
            with page.expect_response(match('POST', '/api/v1/auth/logout')) as ack:
                page.get_by_role('button', name='Chiqish', exact=True).click()
            assert ack.value.status == 200 and 'authorization' not in ack.value.request.all_headers()
            assert list(ack.value.request.post_data_json) == ['refresh_token']
            expect(page.get_by_text('Server sessiya yopilganini tasdiqladi.', exact=True)).to_be_visible()
            page.wait_for_function('__UA_SDK_TEST_AUDIT__().sdkSession === null')
        page.goto('https://app.example.test/tests/clerk-sdk.fixture.html')
        expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible()
        assert page.locator('.demo-badge,.sample-notice').count() == 0
        expect(page.get_by_role('link', name='Telegram orqali kirish', exact=False)).to_have_attribute('href', 'https://t.me/univeracademybot')
        shot('common-entry'); google(0)
        page.get_by_role('button', name='Testni ko‘rish').first.click()
        page.get_by_role('button', name='Boshlash', exact=True).click()
        with page.expect_response(lambda r: r.request.method == 'POST' and urlsplit(r.url).path.endswith('/attempts')) as started:
            page.get_by_role('button', name='Ha, boshlash').click()
        attempt = started.value.json()['data']; aid = attempt['id']
        expect(page.get_by_role('timer')).to_be_visible()
        radio = page.get_by_role('radio').first; question = radio.get_attribute('name')
        with page.expect_response(match('PUT', f'/api/v1/attempts/{aid}/answers/{question}')) as saved:
            radio.check()
        assert saved.value.json()['data']['revision'] == 1
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible(); shot('sdk-saved')
        fault['revoke'] = True
        with page.expect_response(lambda r: r.status == 401):
            page.get_by_role('button', name='Saqlanganlarni tekshirish', exact=True).click()
        expect(page.get_by_text('Sessiyani qayta oching. Google yoki email orqali yangidan kiring; test vaqti davom etadi.', exact=True)).to_be_visible()
        assert page.get_by_role('timer').count() == page.get_by_role('radio').count() == 0
        assert 'Telegramdan yangidan kiring' not in page.locator('body').inner_text(); shot('sdk-reentry')
        page.get_by_role('button', name='Qayta kirish', exact=True).click()
        page.wait_for_function('__UA_SDK_TEST_AUDIT__().sdkSession === null'); google(1)
        with page.expect_response(match('GET', f'/api/v1/attempts/{aid}')) as resumed:
            page.get_by_role('button', name='Testni ko‘rish').first.click()
        assert resumed.value.json()['data']['deadline_at'] == attempt['deadline_at']
        expect(page.get_by_role('radio').first).to_be_checked()
        page.get_by_role('button', name='Testni topshirish', exact=True).click()
        with page.expect_response(match('POST', f'/api/v1/attempts/{aid}/submit')) as submitted:
            page.get_by_role('button', name='Ha, topshirish').click()
        display = submitted.value.json()['data']['ordinary']['display']
        points = display['earned_points'].replace('.', ',') + ' / ' + display['max_points'].replace('.', ',')
        expect(page.locator('.score')).to_have_text(points); shot('sdk-result')
        with page.expect_response(lambda r: r.request.method == 'GET' and urlsplit(r.url).path.endswith('/history')) as history:
            page.get_by_role('button', name='Urinishlar tarixi', exact=False).click()
        assert history.value.json()['data']['attempts'][0]['score']['ordinary']['display'] == display
        expect(page.get_by_role('article')).to_contain_text(points); logout()
        proof(2)
        page.get_by_label('Email', exact=True).fill('student@example.test')
        page.get_by_role('button', name='Tasdiqlash kodini yuborish').click()
        page.get_by_label('6 xonali kod').fill('000000'); page.get_by_role('button', name='Tekshirish va kirish').click()
        expect(page.get_by_role('alert')).to_contain_text('Kod mos kelmadi')
        page.get_by_label('6 xonali kod').fill('123456')
        with page.expect_response(match('POST', '/api/v1/auth/clerk')) as exchange:
            page.get_by_role('button', name='Tekshirish va kirish').click()
        assert exchange.value.json()['data']['profile']['active_group_id'] is None
        page.get_by_label('Ism', exact=True).fill('Suniy'); page.get_by_label('Familiya', exact=True).fill('SDK')
        with page.expect_response(match('GET', '/api/v1/exams')) as empty:
            page.get_by_role('button', name='Davom etish').click()
        assert empty.value.json()['data'] == []
        expect(page.get_by_role('heading', name='Hozircha test yo‘q', exact=True)).to_be_visible(); logout()
        count = sum(c['path'].endswith('/auth/clerk') for c in audit)
        page.evaluate('window.__UA_DELAY_SYNTHETIC_SDK__ = true')
        page.get_by_role('button', name='Google bilan davom etish').click()
        page.wait_for_function('typeof __UA_RELEASE_SYNTHETIC_SDK__ === "function"')
        page.get_by_role('button', name='Bekor qilish').click(); page.evaluate('__UA_RELEASE_SYNTHETIC_SDK__()')
        page.wait_for_function('__UA_SDK_TEST_AUDIT__().sdkSession === null && __UA_SDK_TEST_AUDIT__().signOut.length === 4')
        assert sum(c['path'].endswith('/auth/clerk') for c in audit) == count == 3
        expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible(); shot('sdk-cancelled')
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert page.evaluate('localStorage.length + sessionStorage.length') == 0
        assert not errors and not blocked
        print(json.dumps({'status': 'PASS', 'width': args['width'], 'SDK': 'PUBLIC_FACADE_ONLY', 'HTTP': 'REAL_LOOPBACK_RAM',
            'exchange': count, 'OTP_retry': True, 'save_resume_submit_result_history': True,
            'U1_guidance_reentry': True, 'targetedSDKSignOut': 4, 'cancel_late_finalize_no_exchange': True,
            'realProviderGoogleEmail': 'NOT_RUN', 'externalRequests': 0, 'storageEntries': 0}))
    finally:
        browser.close()
