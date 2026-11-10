"""Synthetic provider -> actual loopback Backend HTTP -> existing student UI."""
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
match = lambda method, path: lambda response: response.request.method == method and urlsplit(response.url).path == path

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': args['width'], 'height': 900})
        page.set_default_timeout(10000)
        errors, blocked, audit, popups = [], [], [], []
        fault = {'revoke_read': False}
        page.on('pageerror', lambda _: errors.append(True))
        page.on('popup', lambda _: popups.append(True))
        def gate(route):
            url = urlsplit(route.request.url)
            if url.netloc != origin.netloc or url.path.startswith('/api/v1/admin/'):
                blocked.append(True); route.abort()
            elif fault['revoke_read'] and route.request.method == 'GET' and url.path.startswith('/api/v1/exams/'):
                fault['revoke_read'] = False
                route.fulfill(status=401, content_type='application/json', body=json.dumps({'error': {
                    'code': 'CLERK_SESSION_REVOKED', 'message': 'Synthetic U1 UI fault',
                    'request_id': '00000000-0000-4000-8000-000000000901'}}))
            else:
                route.continue_()
        page.route('**/*', gate)
        page.on('response', lambda response: audit.append({'method': response.request.method,
            'path': urlsplit(response.url).path, 'status': response.status})
            if urlsplit(response.url).path.startswith('/api/v1/') else None)
        def provider(index, delayed=False):
            value = args['proofs'][index]; args['proofs'][index] = None
            page.evaluate('''({ proof, delayed }) => {
                window.__UA_SYNTHETIC_CLERK_PROVIDER__ = async () => {
                    if (!proof) throw new Error('SYNTHETIC_PROOF_ALREADY_USED');
                    const current = proof; proof = null;
                    if (delayed) return new Promise(resolve => {
                        window.__UA_RELEASE_SYNTHETIC_PROVIDER__ = () => {
                            delete window.__UA_RELEASE_SYNTHETIC_PROVIDER__; resolve({ proof: current });
                        };
                    });
                    return { proof: current };
                };
            }''', {'proof': value, 'delayed': delayed})
        def screenshot(name):
            if args['width'] == 390:
                page.screenshot(path=str(screens / (name + '.png')), full_page=True)
        def google(index):
            provider(index)
            with page.expect_response(match('GET', '/api/v1/exams')) as exams:
                with page.expect_response(match('POST', '/api/v1/auth/clerk')) as exchange:
                    page.get_by_role('button', name='Google bilan davom etish').click()
            assert exchange.value.status == exams.value.status == 200
            assert exchange.value.request.post_data_json == {}
            expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
            return exchange.value.json()['data'], exams.value.json()['data']
        def logout():
            with page.expect_response(match('POST', '/api/v1/auth/logout')) as ack:
                page.get_by_role('button', name='Chiqish', exact=True).click()
            assert ack.value.status == 200 and ack.value.json()['data']['ok'] is True
            assert 'authorization' not in ack.value.request.all_headers()
            assert list(ack.value.request.post_data_json) == ['refresh_token']
            expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible()
            expect(page.get_by_role('alert')).to_contain_text('Server sessiya yopilganini tasdiqladi')

        page.goto(args['url']); screenshot('entry')
        first, exams = google(0)
        assert len(exams) == 2, json.dumps({'stage': 'initial_exams', 'count': len(exams), 'audit': audit})
        assignment = exams[0]['assignment_id']
        page.get_by_role('button', name='Testni ko‘rish').first.click()
        page.get_by_role('button', name='Boshlash', exact=True).click()
        with page.expect_response(match('POST', f'/api/v1/exams/{assignment}/attempts')) as started:
            page.get_by_role('button', name='Ha, boshlash').click()
        attempt = started.value.json()['data']; aid = attempt['id']
        expect(page.get_by_role('timer')).to_be_visible()
        radio = page.get_by_role('radio').first; question = radio.get_attribute('name')
        with page.expect_response(match('PUT', f'/api/v1/attempts/{aid}/answers/{question}')) as saved:
            radio.check()
        answer = saved.value.json()['data']; assert answer['revision'] == 1
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible(); screenshot('saved')

        # Browser-only 401 injection exercises actual rendered re-entry guidance.
        # The Node integration suite separately revokes the RAM provider session.
        fault['revoke_read'] = True
        with page.expect_response(match('GET', f'/api/v1/exams/{assignment}')) as denied:
            page.get_by_role('button', name='Saqlanganlarni tekshirish', exact=True).click()
        assert denied.value.status == 401
        notice = 'Sessiyani qayta oching. Google yoki email orqali yangidan kiring; test vaqti davom etadi.'
        expect(page.get_by_text(notice, exact=True)).to_be_visible(); screenshot('u1-clerk-reentry')
        assert page.get_by_role('timer').count() == 0 and page.get_by_role('radio').count() == 0
        assert 'Telegramdan yangidan kiring' not in page.locator('body').inner_text()
        expect(page.get_by_text('Qayta kirishda Google yoki email usulini tanlang.', exact=True)).to_be_visible()
        assert '@univeracademybot' not in page.locator('body').inner_text()
        page.get_by_role('button', name='Sinovga kirish', exact=True).click()
        expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible()
        recovered, _ = google(4)
        assert recovered['profile']['person_id'] == first['profile']['person_id']
        with page.expect_response(match('GET', f'/api/v1/attempts/{aid}')) as reentered:
            page.get_by_role('button', name='Testni ko‘rish').first.click()
        assert reentered.value.json()['data']['deadline_at'] == attempt['deadline_at']
        stored = next(a for a in reentered.value.json()['data']['answers'] if a['question_id'] == question)
        assert stored['revision'] == 1 and stored['selected_option_id'] == answer['selected_option_id']

        # Reload holds no app proof. A new synthetic provider JWT must exchange.
        page.reload(); second, _ = google(1)
        assert first['profile']['person_id'] == second['profile']['person_id']
        with page.expect_response(match('GET', f'/api/v1/attempts/{aid}')) as resumed:
            page.get_by_role('button', name='Testni ko‘rish').first.click()
        resumed_data = resumed.value.json()['data']
        assert resumed_data['deadline_at'] == attempt['deadline_at']
        stored = next(a for a in resumed_data['answers'] if a['question_id'] == question)
        assert stored['revision'] == 1 and stored['selected_option_id'] == answer['selected_option_id']
        expect(page.get_by_role('radio').first).to_be_checked()
        page.get_by_role('button', name='Testni topshirish', exact=True).click()
        with page.expect_response(match('POST', f'/api/v1/attempts/{aid}/submit')) as submitted:
            page.get_by_role('button', name='Ha, topshirish').click()
        score = submitted.value.json()['data']; display = score['ordinary']['display']
        points = display['earned_points'].replace('.', ',') + ' / ' + display['max_points'].replace('.', ',')
        expect(page.locator('.score')).to_have_text(points)
        expect(page.locator('.percentage')).to_have_text(display['percentage'].replace('.', ',') + '%')
        assert score['statistical_bonus'] is None; screenshot('result')
        with page.expect_response(match('GET', f'/api/v1/attempts/{aid}/result')) as result:
            page.get_by_role('button', name='Testlarimga qaytish', exact=True).click()
            page.get_by_role('button', name='Testni ko‘rish').first.click()
        assert result.value.json()['data'] == score
        with page.expect_response(match('GET', f'/api/v1/exams/{assignment}/history')) as history:
            page.get_by_role('button', name='Urinishlar tarixi', exact=False).click()
        assert history.value.json()['data']['attempts'][0]['score'] == score
        expect(page.get_by_role('article')).to_contain_text('Rasmiy natija · ' + points); screenshot('history')
        logout()

        # Email is simulated, while fresh-account profile and empty exams are HTTP.
        provider(2)
        page.get_by_label('Email', exact=True).fill('oquvchi@example.test')
        page.get_by_role('button', name='Kod bilan davom etish', exact=True).click()
        page.get_by_label('6 xonali kod').fill('246810')
        with page.expect_response(match('POST', '/api/v1/auth/clerk')) as exchange:
            page.get_by_role('button', name='Tekshirish va kirish').click()
        fresh = exchange.value.json()['data']['profile']
        assert fresh['person_id'] != first['profile']['person_id'] and fresh['active_group_id'] is None
        page.get_by_label('Ism', exact=True).fill('Suniy'); page.get_by_label('Familiya', exact=True).fill('Email')
        with page.expect_response(match('GET', '/api/v1/exams')) as empty:
            page.get_by_role('button', name='Davom etish').click()
        assert empty.value.json()['data'] == []
        expect(page.get_by_role('heading', name='Hozircha test yo‘q', exact=True)).to_be_visible(); screenshot('fresh-empty')
        logout()

        # A delayed synthetic Google callback after cancel must not exchange.
        count = sum(a['path'].endswith('/auth/clerk') for a in audit)
        provider(3, delayed=True); page.get_by_role('button', name='Google bilan davom etish').click()
        page.wait_for_function('typeof window.__UA_RELEASE_SYNTHETIC_PROVIDER__ === "function"')
        page.get_by_role('button', name='Bekor qilish').click()
        page.evaluate('async () => { window.__UA_RELEASE_SYNTHETIC_PROVIDER__(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }')
        expect(page.get_by_role('heading', name='Kabinetga kirish', exact=True)).to_be_visible()
        assert sum(a['path'].endswith('/auth/clerk') for a in audit) == count == 4
        assert page.evaluate('localStorage.length + sessionStorage.length') == 0
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert page.url == args['url'] and not errors and not blocked and not popups
        assert sum(a['status'] == 401 for a in audit) == 1
        assert all(a['status'] in [200, 401] for a in audit)
        print(json.dumps({'status': 'PASS', 'width': args['width'], 'exchange': 4, 'bodyOnlyLogout': 2,
            'U1_correct_Clerk_guidance_and_UI_reentry': True, 'UI_fault': 'single synthetic401; provider revocation separately tested over TCP in Node',
            'reloadResume': True, 'submitResultHistory': True, 'freshUngrouped': True,
            'cancelLateProvider': True, 'externalRequests': 0, 'storageEntries': 0,
            'realClerkGoogleEmailDB': 'NOT_RUN', 'API': 'PROVISIONAL / NOT ACCEPTED'}))
    finally:
        browser.close()
