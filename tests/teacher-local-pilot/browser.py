"""Exercise the classroom workflow in Chromium. PILOT_SCREENSHOTS optionally stores PNGs."""
from contextlib import contextmanager
from pathlib import Path
import os
import re
import shutil
import struct
import subprocess
from urllib.parse import urlparse
import zlib

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
GROUP = 'Fizika — brauzer sinovi'
RICH_TITLE = 'Mexanika · Tekis harakat'
SVG = b'''<svg xmlns="http://www.w3.org/2000/svg" width="260" height="98" viewBox="0 0 260 98">
<rect x="1" y="1" width="258" height="96" rx="7" fill="#eef7f1"/>
<path d="M30 13V78H237M36 72L199 23" stroke="#205a42" stroke-width="3" fill="none"/>
<circle cx="199" cy="23" r="5" fill="#bb6221"/></svg>'''


def png_diagram():
    """Draw a rising line on a grid using PNG's standard RGB + deflate encoding."""
    width, height = 160, 56

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            line = 9 <= x < 150 and abs(y - (48 - x // 4)) < 2
            grid = x % 20 == 8 or y % 12 == 0
            raw.extend((28, 96, 72) if line else (215, 226, 221) if grid else (247, 250, 247))
    header = struct.pack('>2I5B', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


@contextmanager
def local_server():
    script = """
      import { createTeacherPilotServer } from './runtime/teacher-local-pilot.mjs';
      const server = await createTeacherPilotServer();
      server.listen(0,'127.0.0.1',() => console.log(server.address().port));
    """
    with subprocess.Popen(['node', '--input-type=module', '-e', script], cwd=ROOT,
                          stdout=subprocess.PIPE, text=True) as proc:
        try:
            yield 'http://127.0.0.1:' + str(int(proc.stdout.readline().strip()))
        finally:
            proc.terminate()


def capture(page, name):
    directory = os.environ.get('PILOT_SCREENSHOTS')
    if directory:
        path = Path(directory)
        path.mkdir(parents=True, exist_ok=True)
        page.evaluate('document.fonts.ready')
        page.screenshot(path=path / (name + '.png'), full_page=True)


def verify_rich(view):
    expect(view.locator('.katex')).to_have_count(2)
    expect(view.locator('.katex-error')).to_have_count(0)
    expect(view.locator('math mfrac')).to_have_count(2)
    for alt in ['Masofaning vaqtga bog‘lanishi', 'Tekis harakat grafigi']:
        img = view.get_by_role('img', name=alt)
        expect(img).to_be_visible()
        assert img.evaluate('async img => { await img.decode(); return img.naturalWidth > 8; }')
    expect(view.get_by_text('To‘g‘ri javob', exact=True)).to_have_count(0)


def add_rich_test(teacher):
    teacher.locator('#editor-title').fill(RICH_TITLE)
    teacher.locator('#editor-duration').fill('1200')
    prompt = teacher.get_by_role('group', name='Savol mazmuni', exact=True)
    prompt.get_by_label('Matn', exact=True).fill('Jism 4 soniyada 20 metr yo‘l bosdi. O‘rtacha tezlik qaysi?')
    prompt.get_by_role('button', name='Formula qo‘shish').click()
    prompt.locator('[data-formula-input]').fill(r'\frac{s}{t}')
    prompt.locator('input[type=file]').set_input_files({'name':'harakat.svg','mimeType':'image/svg+xml','buffer':SVG})
    prompt.get_by_label('Rasm tavsifi').fill('Masofaning vaqtga bog‘lanishi')
    for index, label in enumerate(['Bir metr/soniya', 'Besh metr/soniya', 'O‘n metr/soniya', 'Yigirma metr/soniya'], start=1):
        option = teacher.get_by_role('group', name=f'{index}-javob', exact=True)
        option.get_by_label('Matn', exact=True).fill(label)
        if index == 2:
            option.get_by_role('button', name='Formula qo‘shish').click()
            option.locator('[data-formula-input]').fill(r'\frac{20}{4}')
            option.locator('input[type=file]').set_input_files({'name':'grafik.png','mimeType':'image/png','buffer':png_diagram()})
            option.get_by_label('Rasm tavsifi').fill('Tekis harakat grafigi')
            option.get_by_role('radio').check()
    teacher.locator('#student-preview').click()
    verify_rich(teacher.locator('#editor-preview'))
    teacher.locator('#save-editor').click()
    expect(teacher.locator('#saved-test option:checked')).to_have_text(RICH_TITLE)
    teacher.locator('#view-saved').click()
    verify_rich(teacher.locator('#saved-preview'))
    capture(teacher, 'pilot-teacher-preview')
    teacher.locator('#publish-button').click()
    teacher.locator('#assign-form button').click()
    expect(teacher.locator('#assignment-info')).to_contain_text(GROUP)


def finish(student):
    student.get_by_role('button', name='Testni yakunlash').click()
    student.get_by_role('button', name='Ha, javoblarni yuborish').click()
    expect(student.get_by_role('heading', name='Test natijasi')).to_be_visible()
    expect(student.get_by_text('100.00%', exact=True)).to_be_visible()


def main():
    with local_server() as origin, sync_playwright() as p:
        chromium = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
        browser = p.chromium.launch(executable_path=chromium)
        outside_requests, script_errors = [], []

        def local_only(route):
            if urlparse(route.request.url).netloc == urlparse(origin).netloc:
                route.continue_()
            else:
                outside_requests.append(route.request.url)
                route.abort()

        def page(viewport):
            context = browser.new_context(viewport=viewport, service_workers='block')
            context.route('**/*', local_only)
            tab = context.new_page()
            tab.on('pageerror', lambda error: script_errors.append(str(error)))
            return tab

        desktop = {'width': 1240, 'height': 850}
        teacher = page(desktop)
        teacher.goto(origin + '/teacher/')
        teacher.locator('#group-name').fill(GROUP)
        teacher.get_by_role('button', name='Guruh yaratish').click()
        expect(teacher.locator('#member-group option', has_text=GROUP)).to_have_count(1)
        expect(teacher.locator('#member-form')).to_be_visible()
        teacher.locator('#student-number').fill('0100000001')
        teacher.get_by_role('button', name='O‘quvchi qo‘shish').click()
        expect(teacher.locator('#members')).to_contain_text('0100000001')
        teacher.locator('#student-number').fill('0100000002')
        teacher.get_by_role('button', name='Bot orqali yuborish').click()
        expect(teacher.locator('#notice')).to_contain_text('yuborildi')
        student = page({'width': 390, 'height': 844})
        student.goto(origin + '/student/')
        student.get_by_role('button', name=re.compile('0100000002')).click()
        expect(student.get_by_role('heading', name='Botdan kelgan takliflar')).to_be_visible()
        student.get_by_role('link', name=GROUP + ' · Botda ochish').click()
        student.get_by_role('button', name='Botni boshlash').click()
        student.get_by_role('link', name='O‘quvchi kabinetida ochish').click()
        student.get_by_role('button', name='Taklifni qabul qilish').click()
        expect(student.get_by_text(GROUP, exact=True)).to_be_visible()
        teacher.get_by_role('link', name='Testlar', exact=True).click()
        teacher.locator('#test-file').set_input_files(ROOT / 'apps/teacher-web/local-pilot/sample.txt')
        expect(teacher.locator('#preview')).to_contain_text('O‘rtacha tezlik qancha?')
        teacher.locator('#save-draft').click()
        teacher.locator('#publish-button').click()
        teacher.locator('#assign-form button').click()
        expect(teacher.locator('#assignment-info')).to_contain_text(GROUP)
        add_rich_test(teacher)

        student.get_by_role('button', name='Kabinetni yangilash').click()

        def exam(title):
            return student.locator('section').filter(has=student.get_by_role('heading', name=title, exact=True))
        compact = exam('Kinematika — qisqa sinov')
        compact.get_by_role('button', name='Testni boshlash').click()
        student.get_by_role('radio', name='5 m/s', exact=True).check()
        expect(student.get_by_text(re.compile(r'Saqlangan javoblar: 1 / 2'))).to_be_visible()
        student.reload()
        compact.get_by_role('button', name='Testni davom ettirish').click()
        expect(student.get_by_role('radio', name='5 m/s', exact=True)).to_be_checked()
        student.get_by_role('radio', name='Tezlik', exact=True).check()
        finish(student)
        student.get_by_role('button', name='Kabinetga qaytish').click()
        exam(RICH_TITLE).get_by_role('button', name='Testni boshlash').click()
        verify_rich(student.locator('main'))
        assert student.evaluate('document.documentElement.scrollWidth <= innerWidth')
        capture(student, 'pilot-student-rich')
        student.get_by_role('radio', name=re.compile('Besh metr/soniya')).check()
        finish(student)
        teacher.get_by_role('link', name='Natijalar', exact=True).click()
        teacher.locator('#refresh-results').click()
        expect(teacher.locator('#results-body tr')).to_have_count(2)
        expect(teacher.locator('#results-body tr').filter(has_text=RICH_TITLE)).to_contain_text('100.00')
        assert not outside_requests, outside_requests
        assert not script_errors, script_errors
        browser.close()
        print('PASS · Teacher → Admin → recipient inbox → local bot → Student TXT + rich attempts → Teacher results')


if __name__ == '__main__':
    main()
