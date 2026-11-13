"""Exact-source score is computed by the real local server, never this browser."""
import json
import shutil
import sys
from playwright.sync_api import sync_playwright, expect

args = json.load(sys.stdin)
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 390, 'height': 900})
    errors, external = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if not request.url.startswith(args['url'].rstrip('/')) else None)
    page.goto(args['url'])
    page.evaluate('(raw) => { window.__UA_SYNTHETIC_INIT_DATA__ = raw; }', args['initData'])
    page.get_by_role('button', name='Sinovga kirish').click()
    page.get_by_label('Ism', exact=True).fill('Suniy')
    page.get_by_label('Familiya', exact=True).fill('Raqam')
    page.get_by_role('button', name='Davom etish').click()
    page.get_by_role('button', name='Testni ko‘rish').click()
    page.get_by_role('button', name='Boshlash', exact=True).click()
    page.get_by_role('button', name='Ha, boshlash').click()
    page.get_by_role('radio', name='6 N', exact=True).check()
    expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
    page.get_by_role('button', name='Testni topshirish', exact=True).click()
    with page.expect_response(lambda response: response.request.method == 'POST' and response.url.endswith('/submit')) as submitted:
        page.get_by_role('button', name='Ha, topshirish').click()
    reply = submitted.value
    assert reply.status == 200
    result = reply.json()['data']
    assert result['ordinary']['display']['earned_points'] == args['expected']
    assert result['ordinary']['display']['max_points'] == args['expected']
    assert result['statistical_bonus'] is None
    localized = args['expected'].replace('.', ',')
    expect(page.locator('.score')).to_have_text(localized + ' / ' + localized)
    expect(page.locator('.percentage')).to_have_text('100,00%')
    with page.expect_response(lambda response: response.url.endswith('/result')) as fetched_result:
        # Result was already fetched by the UI after submit; read it through the
        # same browser owner-client flow by reopening the selected exam.
        page.get_by_role('button', name='Testlarimga qaytish', exact=True).click()
        page.get_by_role('button', name='Testni ko‘rish').click()
    assert fetched_result.value.status == 200
    assert fetched_result.value.json()['data'] == result
    with page.expect_response(lambda response: response.url.endswith('/history')) as fetched_history:
        page.get_by_role('button', name='Urinishlar tarixi', exact=False).click()
    assert fetched_history.value.status == 200
    entry = fetched_history.value.json()['data']['attempts'][0]
    assert entry['lifecycle_status'] == 'submitted' and entry['cancellation'] is None
    for field in ['started_at', 'deadline_at', 'completed_at']:
        assert isinstance(entry[field], str) and entry[field].endswith('Z')
    assert entry['score'] == result
    assert entry['score']['statistical_bonus'] is None
    expect(page.get_by_role('article')).to_contain_text('Rasmiy natija · ' + localized + ' / ' + localized)
    page.screenshot(path=args['screenshot'], full_page=True)
    assert not errors, errors
    assert not external, external
    print(json.dumps({'status': 'PASS', 'exact_server_fixture_source': args['input'],
        'actual_HTTP200_display': result['ordinary']['display']['earned_points'],
        'browser_localized': localized, 'percentage': '100,00%', 'history_matches': True,
        'raw_submit_result_history_match': True,
        'browser_errors': len(errors), 'external_requests': len(external)}))
    browser.close()
