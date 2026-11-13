"""Local demo smoke check. Uses the environment's existing Playwright and Chromium."""
import os
import shutil
from playwright.sync_api import sync_playwright, expect

url = os.environ.get('MINI_APP_TEST_URL', 'http://127.0.0.1:5173/')


def start(page, short_timer=False):
    page.goto(url)
    page.get_by_role('button', name='Namunani ochish').click()
    page.get_by_label('Ism', exact=True).fill('Namuna')
    page.get_by_label('Familiya', exact=True).fill('O‘quvchi')
    page.get_by_role('button', name='Davom etish').click()
    page.get_by_role('button', name='Testni ko‘rish').click()
    if short_timer:
        page.get_by_text('Namuna holatlarini sinash', exact=True).click()
        page.get_by_label('Sinov holati').select_option('short-timer')
    page.get_by_role('button', name='Boshlash', exact=True).click()
    expect(page.get_by_role('dialog')).to_be_visible()
    page.get_by_role('button', name='Ha, boshlash').click()
    expect(page.get_by_role('radio').first).to_be_enabled()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    errors = []
    pages = []
    for width in (320, 390, 1280):
        page = browser.new_page(viewport={'width': width, 'height': 844})
        page.on('pageerror', lambda error: errors.append(str(error)))
        external = []
        page.on('request', lambda request: external.append(request.url) if not request.url.startswith(url.rstrip('/')) else None)
        start(page)
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        page.get_by_role('radio').first.check()
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
        page.get_by_role('button', name='Keyingi').click()
        page.get_by_role('radio').nth(2).check()
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
        page.get_by_role('button', name='Testni topshirish', exact=True).click()
        expect(page.get_by_role('dialog')).to_contain_text('2 ta savol javobsiz')
        page.keyboard.press('Escape')
        expect(page.get_by_role('dialog')).not_to_be_visible()
        page.get_by_role('button', name='Testni topshirish', exact=True).click()
        page.get_by_role('button', name='Ha, topshirish').click()
        expect(page.get_by_role('heading', name='Natijangiz', exact=True)).to_be_visible()
        expect(page.get_by_text('75,00%', exact=True)).to_be_visible()
        expect(page.get_by_text('Tanlagan javoblaringizdan hisoblanmaydi.', exact=False)).to_be_visible()
        page.get_by_role('button', name='Urinishlar tarixi', exact=False).click()
        expect(page.get_by_role('heading', name='O‘z urinishlaringiz')).to_be_visible()
        expect(page.get_by_role('article').get_by_text('Topshirilgan', exact=True)).to_be_visible()
        assert not external, external
        pages.append(f'lifecycle-{width}px')
        page.close()

    page = browser.new_page(viewport={'width': 390, 'height': 844})
    page.on('pageerror', lambda error: errors.append(str(error)))
    start(page)
    page.get_by_text('Namuna holatlarini sinash', exact=True).click()
    page.get_by_label('Sinov holati').select_option('conflict')
    page.get_by_role('radio').first.check()
    expect(page.get_by_role('button', name='Testni topshirish', exact=True)).to_be_disabled()
    page.get_by_role('button', name='Saqlanganlarni tekshirish').click()
    expect(page.get_by_role('button', name='Mening tanlovimni saqlash')).to_be_visible()
    page.get_by_role('button', name='Mening tanlovimni saqlash').click()
    expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
    page.get_by_label('Sinov holati').select_option('lost-save')
    page.get_by_role('radio').nth(2).check()
    expect(page.get_by_text('Tasdiqlanmagan', exact=True)).to_be_visible()
    page.get_by_role('button', name='Saqlanganlarni tekshirish').click()
    expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
    page.get_by_label('Sinov holati').select_option('recovery')
    page.get_by_role('radio').nth(1).check()
    expect(page.get_by_text('Tasdiqlanmagan', exact=True)).to_be_visible()
    page.get_by_role('button', name='Saqlanganlarni tekshirish').click()
    expect(page.get_by_text('Urinish o‘zgargan.', exact=False)).to_be_visible()
    expect(page.get_by_text('Javob tanlanmagan', exact=True)).to_be_visible()
    assert page.get_by_role('radio', checked=True).count() == 0
    expect(page.get_by_role('button', name='Savollarni ochish: 0 ta javob belgilangan', exact=False)).to_be_visible()
    pages.append('conflict-lost-ack-new-generation')
    page.close()

    page = browser.new_page(viewport={'width': 390, 'height': 844})
    start(page, short_timer=True)
    expect(page.get_by_role('timer')).to_have_text('00:00', timeout=6000)
    expect(page.get_by_role('button', name='Testni topshirish', exact=True)).to_be_disabled()
    page.get_by_role('button', name='Saqlanganlarni tekshirish').click()
    expect(page.locator('.pill.green')).to_have_text('Vaqti tugagan')
    pages.append('deadline-read')
    page.close()

    page = browser.new_page(viewport={'width': 390, 'height': 844})
    page.on('pageerror', lambda error: errors.append(str(error)))
    start(page)
    page.get_by_text('Namuna holatlarini sinash', exact=True).click()
    for status, label in [('cancelled', 'Bekor qilingan'), ('recovery_lapsed', 'Qayta urinish oynasi tugagan'), ('ready', 'Qayta urinish tayyor')]:
        page.get_by_label('Urinish holati (namuna)', exact=True).select_option(status)
        expect(page.get_by_role('heading', name='Urinish holati', exact=True)).to_be_visible()
        expect(page.locator('.pill.green')).to_have_text(label)
        assert page.get_by_text('75,00%', exact=True).count() == 0
        assert page.get_by_role('radio').count() == 0
    page.get_by_role('button', name='Boshlash', exact=True).click()
    page.get_by_role('button', name='Ha, boshlash').click()
    expect(page.get_by_role('radio').first).to_be_enabled()
    page.get_by_label('Sinov holati').select_option('invalid')
    page.get_by_role('radio').first.check()
    expect(page.get_by_role('alert')).to_contain_text('Ma’lumot qabul qilinmadi')
    page.get_by_label('Sinov holati').select_option('none')
    page.get_by_role('button', name='Saqlanganlarni tekshirish').click()
    page.get_by_role('button', name='Saqlangan javobni qoldirish').click()
    page.get_by_label('Sinov holati').select_option('forbidden')
    page.get_by_role('button', name='Saqlanganlarni tekshirish').click()
    expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
    expect(page.get_by_role('alert')).to_contain_text('ruxsat yo‘q')
    assert page.get_by_role('radio').count() == 0
    pages.append('ready-cancelled-lapsed-validation-scope-ux')
    page.close()
    assert not errors, errors
    print('PASS:', ', '.join(pages), '; browser errors:', len(errors))
    browser.close()
