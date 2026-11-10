"""Real same-environment HTTP browser flow; staff operations stay in Node."""
import json
from pathlib import Path
import re
import select
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def receive():
    line = sys.stdin.readline()
    assert line, 'DRIVER_INPUT_REQUIRED'
    return json.loads(line)


args = receive()
origin = urlsplit(args['url'])
assert origin.scheme == 'http' and origin.hostname == '127.0.0.1'
assert len(args['initData']) == 3 and len(set(args['initData'])) == 3
screens = Path(args['screenshotDir']); screens.mkdir(parents=True, exist_ok=False)


def response_is(method, path):
    return lambda response: response.request.method == method and urlsplit(response.url).path == path


def ack(stage, person):
    ready, _, _ = select.select([sys.stdin], [], [], 30)
    assert ready, 'STAFF_DRIVER_ACK_TIMEOUT'
    value = receive()
    assert value['stage'] == stage and value['confirmed'] is True
    assert value['runId'] == args['runId'] and value['personId'] == person
    assert value['groupId'] == args['groupId']
    return value


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=shutil.which('chromium'), headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': args['width'], 'height': 900})
        errors, blocked, audit = [], [], []
        page.on('pageerror', lambda _: errors.append(True))

        def gate(route):
            target = urlsplit(route.request.url)
            if target.netloc != origin.netloc or target.path.startswith('/api/v1/admin/'):
                blocked.append(True); route.abort()
            else:
                route.continue_()

        page.route('**/*', gate)
        page.on('response', lambda response: audit.append({
            'method': response.request.method, 'path': urlsplit(response.url).path, 'status': response.status,
        }) if urlsplit(response.url).path.startswith('/api/v1/') else None)

        def launch(raw):
            page.evaluate('(raw) => { window.__UA_SYNTHETIC_INIT_DATA__ = raw; }', raw)
            page.get_by_role('button', name='Sinovga kirish').click()

        def empty():
            expect(page.get_by_role('heading', name='Hozircha test yo‘q', exact=True)).to_be_visible()
            assert page.get_by_role('button', name='Testni ko‘rish').count() == 0
            assert not any(row['method'] in ('PUT', 'POST') and '/attempts' in row['path'] for row in audit)

        def snapshot(name):
            page.screenshot(path=str(screens / f'{name}.png'), full_page=True)

        def announce(stage, person, **data):
            print(json.dumps({'stage': stage, 'runId': args['runId'], 'personId': person,
                'width': args['width'], **data}), flush=True)

        # A fresh registered student has neither membership nor an assignment.
        page.goto(args['url']); launch(args['initData'][0])
        page.get_by_label('Ism', exact=True).fill('Suniy')
        page.get_by_label('Familiya', exact=True).fill('Fizika')
        with page.expect_response(response_is('PATCH', '/api/v1/me')) as registered:
            with page.expect_response(response_is('GET', '/api/v1/exams')) as exams:
                page.get_by_role('button', name='Davom etish').click()
        profile = registered.value.json()['data']; person = profile['person_id']
        assert registered.value.status == exams.value.status == 200
        assert profile['active_group_id'] is None and profile['registration_complete'] is True
        assert exams.value.json()['data'] == []
        empty(); snapshot('ungrouped')
        announce('await_staff_publication', person)

        # Actual HTTP publication is complete; assignment is still paused.
        publication = ack('membership_added', person)
        version_id = publication['publishedVersionId']
        assert version_id not in args['seedVersionIds']
        page.reload()
        with page.expect_response(response_is('GET', '/api/v1/me')) as member:
            with page.expect_response(response_is('GET', '/api/v1/exams')) as exams:
                launch(args['initData'][1])
        assert member.value.status == exams.value.status == 200
        assert member.value.json()['data']['person_id'] == person
        assert member.value.json()['data']['active_group_id'] == args['groupId']
        assert exams.value.json()['data'] == []
        empty(); snapshot('membership-only')
        announce('await_assignment', person, membership_observed=True, exams_empty=True)

        # The assignment ID arrives late from the real HTTP create response.
        assignment = ack('assignment_added', person)
        assert assignment['publishedVersionId'] == version_id
        assignment_id = assignment['assignmentId']
        with page.expect_response(response_is('GET', '/api/v1/exams')) as exams:
            page.get_by_role('button', name='Testlar ro‘yxatini yangilash', exact=True).click()
        rows = exams.value.json()['data']; assert exams.value.status == 200 and len(rows) == 1
        meta = rows[0]
        assert meta['assignment_id'] == assignment_id and meta['version_id'] == version_id
        assert meta['demo_id'] == publication['demoId']
        assert meta['duration_seconds'] == publication['durationSeconds'] == 420
        expect(page.get_by_role('heading', name=meta['title'], exact=True)).to_be_visible()
        page.get_by_role('button', name='Testni ko‘rish').click()
        page.get_by_role('button', name='Boshlash', exact=True).click()
        with page.expect_response(response_is('POST', f'/api/v1/exams/{assignment_id}/attempts')) as started:
            page.get_by_role('button', name='Ha, boshlash').click()
        assert started.value.status == 200
        attempt = started.value.json()['data']; attempt_id = attempt['id']
        assert attempt['assignment_id'] == assignment_id
        from datetime import datetime
        stamp = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
        assert stamp(attempt['deadline_at']) - stamp(attempt['started_at']) == 420
        for question in attempt['questions']:
            assert question['prompt_blocks'][0]['markdown'].startswith('Yangi sintetik fizika ')
        expect(page.get_by_text(re.compile(r'Yangi sintetik fizika [12]'), exact=True)).to_be_visible()
        expect(page.get_by_role('timer')).to_be_visible()
        remaining = lambda text: sum(int(n) * m for n, m in zip(text.split(':'), (60, 1)))
        timer_before = remaining(page.get_by_role('timer').inner_text())
        assert 0 < timer_before <= 420
        radio = page.get_by_role('radio', name=args['answerLabel'], exact=True)
        question_id = radio.get_attribute('name')
        with page.expect_response(response_is('PUT', f'/api/v1/attempts/{attempt_id}/answers/{question_id}')) as saved:
            radio.check()
        assert saved.value.status == 200
        answer = saved.value.json()['data']
        assert answer['question_id'] == question_id and answer['selected_option_id'] is not None
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
        snapshot('new-question-saved')

        # Literal reload, fresh same-person login, server-saved answer and deadline.
        page.reload(); launch(args['initData'][2])
        expect(page.get_by_role('heading', name='Mening testlarim', exact=True)).to_be_visible()
        with page.expect_response(response_is('GET', f'/api/v1/attempts/{attempt_id}')) as resumed:
            page.get_by_role('button', name='Testni ko‘rish').click()
        assert resumed.value.status == 200
        resumed_data = resumed.value.json()['data']
        assert resumed_data['id'] == attempt_id and resumed_data['generation'] == attempt['generation']
        assert resumed_data['deadline_at'] == attempt['deadline_at']
        stored = next(a for a in resumed_data['answers'] if a['question_id'] == question_id)
        assert stored['selected_option_id'] == answer['selected_option_id'] and stored['revision'] == answer['revision']
        expect(page.get_by_role('radio', name=args['answerLabel'], exact=True)).to_be_checked()
        expect(page.get_by_text('✓ Tasdiqlangan', exact=True)).to_be_visible()
        assert 0 < remaining(page.get_by_role('timer').inner_text()) <= timer_before
        snapshot('resumed')

        page.get_by_role('button', name='Testni topshirish', exact=True).click()
        with page.expect_response(response_is('POST', f'/api/v1/attempts/{attempt_id}/submit')) as submitted:
            page.get_by_role('button', name='Ha, topshirish').click()
        assert submitted.value.status == 200
        score = submitted.value.json()['data']
        assert score['ordinary']['display'] == args['expectedDisplay']
        assert score['statistical_bonus'] is None
        display = score['ordinary']['display']
        points = display['earned_points'].replace('.', ',') + ' / ' + display['max_points'].replace('.', ',')
        expect(page.locator('.score')).to_have_text(points)
        expect(page.locator('.percentage')).to_have_text(display['percentage'].replace('.', ',') + '%')
        snapshot('result')
        with page.expect_response(response_is('GET', f'/api/v1/attempts/{attempt_id}/result')) as result:
            page.get_by_role('button', name='Testlarimga qaytish', exact=True).click()
            page.get_by_role('button', name='Testni ko‘rish').click()
        assert result.value.status == 200 and result.value.json()['data'] == score
        with page.expect_response(response_is('GET', f'/api/v1/exams/{assignment_id}/history')) as history:
            page.get_by_role('button', name='Urinishlar tarixi', exact=False).click()
        assert history.value.status == 200
        entry = history.value.json()['data']['attempts'][0]
        assert entry['lifecycle_status'] == 'submitted' and entry['score'] == score
        assert entry['started_at'] == attempt['started_at'] and entry['deadline_at'] == attempt['deadline_at']
        expect(page.get_by_role('article')).to_contain_text('Rasmiy natija · ' + points)
        snapshot('history')
        assert sum(r['method'] == 'POST' and r['path'].endswith('/attempts') for r in audit) == 1
        assert sum(r['method'] == 'PUT' and '/answers/' in r['path'] for r in audit) == 1
        assert page.evaluate('localStorage.length + sessionStorage.length') == 0
        assert page.evaluate('window.__UA_SYNTHETIC_INIT_DATA__ === undefined')
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert not errors and not blocked
        for forbidden in ['correct_option_id', 'explanation_blocks', 'synthetic-admin-proof', 'synthetic-teacher-proof']:
            assert forbidden not in json.dumps({'meta': meta, 'attempt': attempt, 'resumed': resumed_data, 'score': score})
        announce('complete', person, status='PASS', ungrouped_empty=True, membership_only_empty=True,
            literal_reload_saved_answer_and_same_deadline=True, new_question_from_HTTP_publication=True,
            display=display, raw_submit_result_history_match=True, browser_errors=0, blocked_requests=0)
    finally:
        browser.close()
