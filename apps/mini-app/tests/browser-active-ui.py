"""Actual loopback UI regression. Only synthetic proofs arrive over ephemeral stdin."""
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

args = json.load(sys.stdin)
origin = urlsplit(args['url']).netloc
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': args['width'], 'height': 900})
        page.emulate_media(reduced_motion='reduce')
        errors, external, audit = [], [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: external.append(request.url)
                if urlsplit(request.url).netloc != origin else None)
        page.on('request', lambda request: audit.append((request.method, urlsplit(request.url).path))
                if '/api/v1/' in request.url else None)

        def mutations():
            return [row for row in audit if row[0] in ('PUT', 'POST')
                    and ('/answers/' in row[1] or row[1].endswith(('/attempts', '/submit')))]

        def progress(answered):
            expect(page.get_by_role('button', name=f'Savollarni ochish: {answered} ta javob belgilangan', exact=False)).to_be_visible()
            ratio = page.locator('.progress-fill').evaluate('(el) => el.getBoundingClientRect().width / el.parentElement.getBoundingClientRect().width')
            assert abs(ratio - answered / 2) < 0.01, ratio

        def picker():
            button = page.get_by_role('button', name='Savollarni ochish:', exact=False)
            button.focus()
            page.keyboard.press('Enter')
            dialog = page.get_by_role('dialog', name='Savollar', exact=True)
            expect(dialog).to_be_visible()
            expect(button).to_have_attribute('aria-expanded', 'true')
            return dialog

        def question(number):
            dialog = picker()
            dialog.get_by_role('button', name=f'{number}-savol', exact=False).click()
            expect(dialog).not_to_be_visible()
            expect(page.locator('.question .eyebrow')).to_have_text(f'Savol {number} / 2')

        def screenshot(name):
            page.screenshot(path=str(Path(args['evidence']) / f'active-{name}-{args["width"]}.png'), full_page=True)

        page.goto(args['url'])
        page.evaluate('(raw) => { window.__UA_SYNTHETIC_INIT_DATA__ = raw; }', args['initData'][0])
        page.get_by_role('button', name='Sinovga kirish').click()
        page.get_by_label('Ism', exact=True).fill('Suniy')
        page.get_by_label('Familiya', exact=True).fill('Progress')
        page.get_by_role('button', name='Davom etish').click()
        test_title = page.locator('.exam-card h2').inner_text()
        page.get_by_role('button', name='Testni ko‘rish').click()
        page.get_by_role('button', name='Boshlash', exact=True).click()
        page.get_by_role('button', name='Ha, boshlash').click()
        expect(page.get_by_role('timer')).to_be_visible()
        assert page.locator('.brand, .sample-notice, .page-heading, footer').count() == 0
        expect(page.locator('.exam-bar').get_by_role('heading', level=1)).to_have_text(test_title)
        assert page.locator('.exam-bar').get_by_role('timer').count() == 1
        assert '%' not in page.locator('.exam-bar').inner_text()
        assert page.locator('.answer-progress').bounding_box()['height'] >= 44
        progress(0)
        screenshot('empty')
        writes = mutations()
        question(2)
        progress(0)  # Last question, zero answers: currentOrder must not drive progress.
        dialog = picker()
        expect(dialog.get_by_role('button', name='2-savol', exact=False)).to_have_attribute('aria-current', 'step')
        assert dialog.locator('.unanswered').count() == 2
        page.keyboard.press('Escape')
        expect(page.get_by_role('button', name='Savollarni ochish:', exact=False)).to_be_focused()
        page.get_by_role('button', name='Oldingi', exact=False).click()
        page.get_by_role('button', name='Keyingi', exact=False).click()
        assert mutations() == writes, 'Navigation wrote an answer or submitted'

        def hold_ack(route):
            reply = route.fetch()  # Actual server save; delay only the browser ACK.
            progress(0)
            expect(page.get_by_text('Saqlanmoqda…', exact=True)).to_be_visible()
            route.fulfill(response=reply)

        page.route('**/api/v1/attempts/*/answers/*', hold_ack, times=1)
        page.get_by_role('radio').first.check()
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
        progress(1)
        dialog = picker()
        assert dialog.locator('.answered').count() == 1 and dialog.locator('.unanswered').count() == 1
        expect(dialog.get_by_role('button', name='2-savol', exact=False)).to_have_class('answered')
        screenshot('picker')
        page.get_by_role('button', name='Savollar oynasini yopish').click()
        page.get_by_role('button', name='Tanlovni tozalash').click()
        expect(page.get_by_text('Javob tanlanmagan', exact=True)).to_be_visible()
        progress(0)
        page.get_by_role('radio').first.check()
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
        progress(1)
        saved_radio = page.get_by_role('radio', checked=True).locator('..').inner_text()
        page.reload()
        page.evaluate('(raw) => { window.__UA_SYNTHETIC_INIT_DATA__ = raw; }', args['initData'][1])
        page.get_by_role('button', name='Sinovga kirish').click()
        page.get_by_role('button', name='Testni ko‘rish').click()
        expect(page.get_by_role('timer')).to_be_visible()
        progress(1)
        writes = mutations()
        question(2)
        assert page.get_by_role('radio', checked=True).locator('..').inner_text() == saved_radio
        assert mutations() == writes
        screenshot('saved')

        def lose_clear_ack(route):
            reply = route.fetch()
            assert reply.status == 200
            route.abort('failed')  # Server cleared it; the browser has no ACK yet.

        page.route('**/api/v1/attempts/*/answers/*', lose_clear_ack, times=1)
        page.get_by_role('button', name='Tanlovni tozalash').click()
        expect(page.get_by_text('Tasdiqlanmagan', exact=True)).to_be_visible()
        expect(page.get_by_role('alert')).to_be_visible()
        progress(1)
        screenshot('save-error')
        writes = mutations()
        question(1)
        assert mutations() == writes
        page.get_by_role('button', name='Saqlanganlarni tekshirish').click()
        expect(page.get_by_role('button', name='Testni topshirish', exact=True)).to_be_enabled()
        progress(0)
        page.get_by_role('radio').first.check()
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
        progress(1)
        question(2)
        page.get_by_role('radio').first.check()
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
        progress(2)
        screenshot('complete')
        page.get_by_role('button', name='Testni topshirish', exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('0 ta savol javobsiz')
        page.get_by_role('button', name='Ha, topshirish').click()
        expect(page.get_by_role('heading', name='Natijangiz', exact=True)).to_be_visible()
        assert sum(method == 'POST' and path.endswith('/attempts') for method, path in audit) == 1
        assert sum(method == 'POST' and path.endswith('/submit') for method, path in audit) == 1
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert page.evaluate('localStorage.length + sessionStorage.length') == 0
        # The intentional browser-side lost ACK is a request failure, not a pageerror.
        assert not errors and not external, (errors, external)
        print(json.dumps({'status': 'PASS', 'width': args['width'], 'progress_empty_half_full': True,
                          'last_unanswered_question_still_zero': True, 'progress_waits_for_save_ACK': True,
                          'clear_reload_reconcile': True, 'navigation_mutations': 0,
                          'keyboard_dialog_and_focus': True, 'save_error_visible': True,
                          'start_requests': 1, 'submit_requests': 1,
                          'browser_errors': len(errors), 'external_requests': len(external)}))
    finally:
        browser.close()
