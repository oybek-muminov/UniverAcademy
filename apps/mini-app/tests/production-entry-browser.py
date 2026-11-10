"""Local synthetic browser test. Reserved hosts route to local source or RAM mocks."""
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

args = json.loads(sys.stdin.readline())
for base in [args['baseUrl']] if 'baseUrl' in args else [b['baseUrl'] for b in args['builds']]:
    local = urlsplit(base)
    assert local.scheme == 'http' and local.hostname == '127.0.0.1'
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        for scenario in ([] if 'builds' in args else ['registered', 'profile', 'retry', 'missing_sdk', 'sdk_error', 'revoked', 'logout']):
            context = browser.new_context(viewport={'width': 390, 'height': 900})
            print('BROWSER_CASE ' + scenario, file=sys.stderr, flush=True)
            page = context.new_page()
            page.set_default_timeout(8000)
            page.set_default_navigation_timeout(10000)
            errors, blocked = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            def route(request):
                target = urlsplit(request.request.url)
                if target.scheme == 'https' and target.netloc == 'app.invalid':
                    response = request.fetch(url=args['baseUrl'] + target.path + ('?' + target.query if target.query else ''), timeout=5000)
                    request.fulfill(response=response)
                else:
                    blocked.append(request.request.url); request.abort()
            page.route('**/*', route)
            page.goto(f'https://app.invalid/tests/production-entry.fixture.html?scenario={scenario}')
            if scenario == 'missing_sdk':
                expect(page.get_by_text('Telegram botdan kabinetni yangidan oching.', exact=False)).to_be_visible()
                assert page.evaluate('syntheticAudit.length') == 0
            elif scenario == 'sdk_error':
                expect(page.get_by_text('Telegram oynasi tayyor bo‘lmadi.', exact=False)).to_be_visible()
                assert page.evaluate('syntheticAudit.length') == 0
            else:
                if scenario == 'retry':
                    expect(page.get_by_role('button', name='Qayta tekshirish')).to_be_visible()
                    page.get_by_role('button', name='Qayta tekshirish').click()
                if scenario == 'profile':
                    expect(page.get_by_text('Ism va familiyangizni kiriting.', exact=True)).to_be_visible()
                    page.get_by_label('Ism', exact=True).fill('Suniy')
                    page.get_by_label('Familiya', exact=True).fill('Entry')
                    page.get_by_role('button', name='Davom etish').click()
                expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
                assert page.locator('.demo-badge,.demo-tools,.sample-notice').count() == 0
                assert page.evaluate('syntheticReadyCount()') == 1
                assert page.evaluate('syntheticAudit.filter(x => x.path === "/auth/telegram").length') == 1
                if scenario == 'revoked':
                    page.get_by_role('button', name='Testlar ro‘yxatini yangilash').click()
                    expect(page.get_by_role('button', name='Qayta kirish')).to_be_visible()
                    assert page.get_by_role('button', name='Testni ko‘rish').count() == 0
                    page.get_by_role('button', name='Qayta kirish').click()
                    expect(page.get_by_text('Telegram botdan kabinetni yangidan oching.', exact=False)).to_be_visible()
                    assert page.evaluate('syntheticAudit.filter(x => x.path === "/auth/telegram").length') == 1
                elif scenario == 'logout':
                    page.get_by_role('button', name='Chiqish', exact=True).click()
                    expect(page.get_by_text('Server sessiya yopilganini tasdiqladi.', exact=False)).to_be_visible()
                    assert page.locator('.student-line').count() == 0
                    logout = page.evaluate('syntheticAudit.filter(x => x.path === "/auth/logout")')
                    assert len(logout) == 1 and not logout[0]['authorized']
                elif scenario == 'registered':
                    page.get_by_role('button', name='Testni ko‘rish').click()
                    page.get_by_role('button', name='Boshlash', exact=True).click()
                    page.get_by_role('button', name='Ha, boshlash').click()
                    expect(page.get_by_role('timer')).to_contain_text('11:')
                    assert page.locator('.brand,.page-heading,.sample-notice').count() == 0
                    expect(page.locator('.progress-fill')).to_have_attribute('style', 'width: 0%;')
                    page.get_by_label('Namuna A', exact=False).check()
                    expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
                    expect(page.locator('.progress-fill')).to_have_attribute('style', 'width: 100%;')
                    before = page.evaluate('syntheticAudit.length')
                    page.get_by_role('button', name='Savollarni ochish:', exact=False).click()
                    expect(page.get_by_role('dialog')).to_be_visible()
                    page.get_by_role('button', name='1-savol, javob tasdiqlangan, joriy', exact=True).click()
                    assert page.evaluate('syntheticAudit.length') == before
                    page.get_by_role('button', name='Saqlanganlarni tekshirish').click()
                    expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
                    page.get_by_role('button', name='Testni topshirish', exact=True).click()
                    page.get_by_role('button', name='Ha, topshirish').click()
                    expect(page.get_by_role('heading', name='Oddiy natija', exact=True)).to_be_visible()
                    expect(page.locator('.score')).to_contain_text('1,5 / 2,0')
                    page.get_by_role('button', name='Urinishlar tarixi').click()
                    expect(page.get_by_role('heading', name='O‘z urinishlaringiz', exact=True)).to_be_visible()
                    expect(page.locator('.history-entry')).to_contain_text('1,5 / 2,0')
                    mutations = page.evaluate('syntheticAudit.filter(x => x.method === "POST" && x.path.includes("attempts"))')
                    assert len(mutations) == 2 and all(x['key'] for x in mutations)
            calls = page.evaluate('syntheticAudit')
            assert all(c['mode'] == 'cors' and c['credentials'] == 'omit' and c['redirect'] == 'error' and c['cache'] == 'no-store' for c in calls)
            assert all(c['exactRaw'] for c in calls if c['path'] == '/auth/telegram')
            assert 'synthetic-SECRET' not in page.locator('body').inner_text()
            assert not errors, errors
            assert not blocked, blocked
            assert page.evaluate('localStorage.length + sessionStorage.length') == 0
            page.evaluate('syntheticUnmount()')
            page.wait_for_timeout(20)
            assert not errors, errors
            results.append({'scenario': scenario, 'status': 'PASS', 'syntheticRequests': len(calls)})
            context.close()
        for spec in args.get('builds', []):
            context = browser.new_context()
            page = context.new_page()
            errors, blocked, sdk, api = [], [], [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            def built_route(route):
                target = urlsplit(route.request.url)
                if route.request.url == 'https://telegram.org/js/telegram-web-app.js?64' and spec['configured']:
                    assert 'referer' not in route.request.all_headers()
                    sdk.append(True)
                    # Fake SDK surface; no real SDK bytes, bot or launch are used.
                    route.fulfill(content_type='application/javascript', body='''
window.syntheticSdkReadyCalls = 0;
window.Telegram = { WebApp: { initData: 'synthetic-built-main-launch', ready() { window.syntheticSdkReadyCalls++; },
get initDataUnsafe() { throw new Error('UNSAFE_IDENTITY_READ'); } } };
''')
                elif target.scheme == 'https' and target.netloc == 'api.example.test' and spec['configured']:
                    method, path = route.request.method, target.path
                    api.append({'method': method, 'path': path, 'auth': 'authorization' in route.request.headers})
                    if method == 'OPTIONS':
                        route.fulfill(status=204, headers={'access-control-allow-origin': 'https://app.invalid',
                            'access-control-allow-methods': 'GET,POST,PATCH,PUT',
                            'access-control-allow-headers': 'Authorization,Content-Type,Idempotency-Key'})
                        return
                    profile = {'person_id': '00000000-0000-4000-8000-000000000008', 'first_name': 'Suniy',
                        'last_name': 'Main', 'roles': ['student'], 'registration_complete': True,
                        'active_group_id': None, 'qadam_id': '0000000001'}
                    if path == '/api/v1/auth/telegram':
                        assert not api[-1]['auth']
                        assert route.request.post_data_json == {'init_data': 'synthetic-built-main-launch'}
                        from datetime import datetime, timezone, timedelta
                        value = {'token_type': 'Bearer', 'access_token': 'synthetic-built-access',
                            'refresh_token': 'synthetic-built-refresh', 'profile': profile,
                            'expires_at': (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
                            'refresh_expires_at': (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()}
                    elif path == '/api/v1/me':
                        assert api[-1]['auth']; value = profile
                    elif path == '/api/v1/exams':
                        assert api[-1]['auth']; value = []
                    elif path == '/api/v1/auth/logout':
                        assert not api[-1]['auth']
                        assert route.request.post_data_json == {'refresh_token': 'synthetic-built-refresh'}
                        value = {'ok': True}
                    else:
                        raise AssertionError('UNEXPECTED_BUILT_MAIN_API_REQUEST')
                    route.fulfill(status=200, content_type='application/json', body=json.dumps({'data': value}),
                        headers={'access-control-allow-origin': 'https://app.invalid'})
                elif target.scheme == 'https' and target.netloc == 'app.invalid':
                    response = route.fetch(url=spec['baseUrl'] + target.path, timeout=5000)
                    route.fulfill(response=response)
                else:
                    blocked.append(route.request.url); route.abort()
            page.route('**/*', built_route)
            page.goto('https://app.invalid' + spec.get('path', '/'))
            if spec['configured']:
                expect(page.get_by_role('heading', name='Hozircha test yo‘q', exact=True)).to_be_visible()
                assert page.evaluate('syntheticSdkReadyCalls') == 1
                assert [call['path'] for call in api if call['method'] != 'OPTIONS'] == [
                    '/api/v1/auth/telegram', '/api/v1/me', '/api/v1/exams']
                page.get_by_role('button', name='Chiqish', exact=True).click()
                expect(page.get_by_text('Server sessiya yopilganini tasdiqladi.', exact=False)).to_be_visible()
            else:
                expect(page.get_by_text('Kabinetga ulanish hali tayyor emas.', exact=False)).to_be_visible()
                assert not api
            assert page.locator('.demo-tools,.demo-badge,.student-line').count() == 0
            assert len(sdk) == (1 if spec['configured'] else 0)
            assert not blocked and not errors, (blocked, errors)
            results.append({'scenario': ('common-optional-telegram-owner-login-logout' if spec.get('common') else 'configured-main-production-owner-login-logout')
                if spec['configured'] else ('common-empty-config-no-sdk' if spec.get('common') else 'empty-config-default-main'),
                'status': 'PASS', 'syntheticSdkLoads': len(sdk), 'interceptedApiRequests': len(api), 'externalApiRequests': 0})
            context.close()
    finally:
        browser.close()
print(json.dumps({'status': 'AUTHOR_SYNTHETIC_BROWSER_PASS', 'cases': results,
    'realTelegram': 'NOT_RUN', 'productionClient': 'PINNED_61cf1d2d_REVIEW', 'corsServer': 'NOT_RUN', 'nativeApiRequests': 0}))
