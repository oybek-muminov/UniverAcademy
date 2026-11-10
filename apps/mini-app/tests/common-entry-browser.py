"""Synthetic common entry tests. Only loopback page resources are allowed."""
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect
args = json.loads(sys.stdin.readline())
origin = urlsplit(args['url'])
assert origin.scheme == 'http' and origin.hostname == '127.0.0.1'
screens = Path(args['screens']); screens.mkdir(parents=True, exist_ok=True)
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        cases = [(str(w), w, '/') for w in [320, 390, 1280]] + [
            ('app_denied', 390, '/tests/common-entry.fixture.html?fault=app_denied'),
            ('cancelled', 390, '/tests/common-entry.fixture.html?fault=cancelled'),
            ('code_expired', 390, '/tests/common-entry.fixture.html?fault=code_expired'),
            ('provider_offline', 390, '/tests/common-entry.fixture.html?fault=provider_offline'),
            ('webview', 390, '/tests/common-entry.fixture.html?context=telegram_webview'),
            ('cancel_pending', 390, '/'),
        ]
        for name, width, path in cases:
            print('AUTH_PROTOTYPE_CASE ' + name, file=sys.stderr, flush=True)
            context = browser.new_context(viewport={'width': width, 'height': 900})
            page = context.new_page(); page.set_default_timeout(8000)
            errors, blocked, mutations, popups = [], [], [], []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('popup', lambda _: popups.append(True))
            def gate(route):
                target = urlsplit(route.request.url)
                if target.netloc != origin.netloc:
                    blocked.append(route.request.url); route.abort()
                elif route.request.method != 'GET':
                    mutations.append(route.request.url); route.abort()
                else:
                    route.continue_()
            page.route('**/*', gate)
            page.goto(args['url'].rstrip('/') + path)
            expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='Telegram bilan kirish', exact=False)).to_be_disabled()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if name in ['320', '390', '1280']:
                page.screenshot(path=str(screens / f'{name}-choose-synthetic.png'), full_page=True)
            def email_login(expired=False):
                page.get_by_label('Email', exact=True).fill('oquvchi@example.test')
                page.get_by_role('button', name='Kod bilan davom etish', exact=True).click()
                expect(page.get_by_role('heading', name='Emailni tasdiqlang')).to_be_visible()
                if name == '390':
                    page.screenshot(path=str(screens / '390-code-synthetic.png'), full_page=True)
                    page.get_by_label('6 xonali kod').fill('000000')
                    page.get_by_role('button', name='Tekshirish va kirish').click()
                    expect(page.get_by_role('alert')).to_contain_text('Kod mos kelmadi')
                    expect(page.get_by_label('6 xonali kod')).to_have_value('')
                page.get_by_label('6 xonali kod').fill('246810')
                page.get_by_role('button', name='Tekshirish va kirish').click()
                if expired:
                    expect(page.get_by_role('alert')).to_contain_text('Kod muddati tugagan')
                else:
                    expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
            if name == 'webview':
                page.get_by_role('button', name='Google bilan davom etish').click()
                expect(page.get_by_role('heading', name='Brauzerda davom etish kerak')).to_be_visible()
                expect(page.get_by_role('button', name='Tashqi brauzerga o‘tish', exact=False)).to_be_disabled()
                page.screenshot(path=str(screens / '390-webview-handoff-not-connected.png'), full_page=True)
                page.get_by_role('button', name='Email kodini tanlash').click()
                email_login()
            elif name == 'code_expired':
                email_login(expired=True)
                expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible()
                assert page.get_by_role('heading', name='Mening testlarim').count() == 0
            elif name in ['app_denied', 'cancelled', 'provider_offline']:
                page.get_by_role('button', name='Google bilan davom etish').click()
                expected = {'app_denied': 'Kabinetga kirish huquqi tasdiqlanmadi',
                    'cancelled': 'Google bilan kirish bekor qilindi', 'provider_offline': 'Tasdiq kelmadi'}[name]
                expect(page.get_by_role('alert')).to_contain_text(expected)
                assert page.get_by_role('heading', name='Mening testlarim').count() == 0
            elif name == '390':
                email_login()
                page.screenshot(path=str(screens / '390-app-ready-synthetic.png'), full_page=True)
            elif name == 'cancel_pending':
                page.get_by_role('button', name='Google bilan davom etish').click()
                page.get_by_role('button', name='Bekor qilish').click()
                email_login()
            else:
                page.get_by_role('button', name='Google bilan davom etish').click()
                expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
            if name in ['320', '390', '1280', 'webview', 'cancel_pending']:
                expect(page.get_by_role('button', name='Testni ko‘rish')).to_be_visible()
                page.get_by_role('button', name='Chiqish', exact=True).click()
                expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible()
            assert page.evaluate('localStorage.length + sessionStorage.length') == 0
            assert 'synthetic-private' not in page.locator('body').inner_text()
            assert '246810' not in page.url and 'oquvchi' not in page.url
            assert page.url == args['url'].rstrip('/') + path
            assert not errors and not blocked and not mutations and not popups, (errors, blocked, mutations, popups)
            results.append({'case': name, 'width': width, 'status': 'PASS', 'externalRequests': 0,
                'httpMutations': 0, 'popups': 0, 'realClerkOrGoogle': 'NOT_RUN'})
            context.close()
    finally:
        browser.close()
print(json.dumps({'status': 'AUTHOR_SYNTHETIC_COMMON_ENTRY_BROWSER_PASS', 'cases': results,
    'accountLinking': 'NOT_IMPLEMENTED', 'WebViewBrowserReturn': 'NOT_IMPLEMENTED'}))
