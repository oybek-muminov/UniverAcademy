"""Real localhost browser/UI flow. Launch proofs arrive only over ephemeral stdin."""
import json
import shutil
import sys
from playwright.sync_api import sync_playwright, expect

args = json.load(sys.stdin)
url, width = args['url'], args['width']
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': width, 'height': 900})
    errors, external, audit = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if not request.url.startswith(url.rstrip('/')) else None)
    page.on('response', lambda response: audit.append((response.request.method,
        response.url.split('/api/v1', 1)[-1], response.status,
        'authorization' in response.request.headers)) if '/api/v1/' in response.url else None)
    page.goto(url)
    # Fresh synthetic launch goes directly into this document's RAM before click;
    # no init script, storage/window.name persistence or initData replay.
    page.evaluate('(raw) => { window.__UA_SYNTHETIC_INIT_DATA__ = raw; }', args['initData'][0])
    assert page.evaluate('typeof window.__UA_SYNTHETIC_INIT_DATA__ === "string"')
    page.get_by_role('button', name='Sinovga kirish').click()
    try:
        page.locator('#first-name').wait_for(timeout=5000)
    except Exception:
        raise AssertionError(json.dumps({'stage': 'login', 'ui': page.locator('body').inner_text(),
                                        'browser_errors': errors, 'audit': audit})) from None
    page.get_by_label('Ism', exact=True).fill('Suniy')
    page.get_by_label('Familiya', exact=True).fill('Sinov')
    page.get_by_role('button', name='Davom etish').click()
    page.get_by_role('button', name='Testni ko‘rish').click()
    page.get_by_role('button', name='Boshlash', exact=True).click()
    page.get_by_role('button', name='Ha, boshlash').click()
    expect(page.get_by_role('timer')).to_be_visible()
    original_timer = page.get_by_role('timer').inner_text()
    page.get_by_role('radio', name='6 N', exact=True).or_(
        page.get_by_role('radio', name='5 m/s', exact=True)).check()
    expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
    saved_label = page.get_by_role('radio', checked=True).locator('..').inner_text()
    saved_question = page.get_by_role('radio', checked=True).get_attribute('name')
    page.reload()
    page.evaluate('(raw) => { window.__UA_SYNTHETIC_INIT_DATA__ = raw; }', args['initData'][1])
    page.get_by_role('button', name='Sinovga kirish').click()
    expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
    page.get_by_role('button', name='Testni ko‘rish').click()
    expect(page.get_by_role('timer')).to_be_visible()
    expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
    assert page.get_by_role('radio', checked=True).locator('..').inner_text() == saved_label
    assert page.get_by_role('radio', checked=True).get_attribute('name') == saved_question
    def seconds(text):
        m, s = map(int, text.split(':'))
        return m * 60 + s
    assert 0 < seconds(page.get_by_role('timer').inner_text()) <= seconds(original_timer)
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
    assert page.evaluate('localStorage.length + sessionStorage.length') == 0
    assert page.evaluate('window.__UA_SYNTHETIC_INIT_DATA__ === undefined')
    page.get_by_role('button', name='Testni topshirish', exact=True).click()
    page.get_by_role('button', name='Ha, topshirish').click()
    expect(page.get_by_role('heading', name='Natijangiz', exact=True)).to_be_visible()
    expect(page.locator('.score')).to_have_text('1,0 / 2,0')
    expect(page.locator('.percentage')).to_have_text('50,00%')
    assert page.get_by_text('Statistik bonus:', exact=False).count() == 0
    page.screenshot(path=args['screenshot'], full_page=True)
    page.get_by_role('button', name='Urinishlar tarixi', exact=False).click()
    expect(page.get_by_role('article')).to_contain_text('Rasmiy natija · 1,0 / 2,0')
    page.get_by_role('button', name='Chiqish', exact=True).click()
    expect(page.get_by_role('alert')).to_have_text('Server sessiya yopilganini tasdiqladi.')
    logout = [entry for entry in audit if entry[1] == '/auth/logout']
    assert len(logout) == 1 and logout[0][2] == 200 and logout[0][3] is False
    assert sum(1 for entry in audit if entry[0] == 'POST' and entry[1].endswith('/attempts')) == 1
    assert not errors, errors
    assert not external, external
    print(json.dumps({'width': width, 'status': 'PASS', 'source': 'real loopback HTTP via Backend owner client',
        'points': '1,0 / 2,0', 'percentage': '50,00%', 'literal_reload_fresh_launch_resume': True,
        'logout200_without_authorization': True, 'browser_errors': len(errors), 'external_requests': len(external)}))
    browser.close()
