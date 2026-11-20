import assert from 'node:assert/strict';
import test from 'node:test';
import { isTeacherPilotInviteToken, teacherPilotBotLinks, teacherPilotBotStart } from '../src/teacher-pilot-invite.mjs';

test('an invitation carries the same token from the teacher link through the bot to the local student', () => {
  const token = 'grp_' + 'a'.repeat(60);
  const { telegramUrl, localBotUrl } = teacherPilotBotLinks(token);
  assert.equal(telegramUrl, 'https://t.me/univeracademybot?start=' + token);
  assert.equal(localBotUrl, '/bot/?start=' + token);
  for (const command of ['/start ', '/start@UniverAcademyBot ']) {
    assert.equal(teacherPilotBotStart(command + token).studentPath, '/student/?invite=' + token);
  }
});

test('other starts stay available for the regular bot; malformed invites do not get forwarded', () => {
  for (const token of [null, 'grp_', 'grp_x\n', 'grp_abc&injected=1', 'grp_' + 'a'.repeat(61), 'unknown']) {
    assert.equal(isTeacherPilotInviteToken(token), false);
    assert.throws(() => teacherPilotBotLinks(token), TypeError);
  }
  for (const cmd of ['/start', '/start ', '/start@otherbot grp_example', '/start  grp_test', '/START grp_abc', '/start grp_x\n']) {
    assert.equal(teacherPilotBotStart(cmd), null);
  }
});
