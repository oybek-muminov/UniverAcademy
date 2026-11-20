// Used only by the localhost pilot. The deployed bot worker keeps its existing /start handler.
const invitePayload = /^grp_[A-Za-z0-9_-]{1,60}$/;

export function isTeacherPilotInviteToken(token) {
  return typeof token === 'string' && token.length <= 64 && invitePayload.test(token) && !/\s/.test(token);
}

export function teacherPilotBotLinks(token) {
  if (!isTeacherPilotInviteToken(token)) throw new TypeError('Invalid group invitation token');
  return {
    telegramUrl: 'https://t.me/univeracademybot?start=' + token,
    localBotUrl: '/bot/?start=' + token,
  };
}

export function teacherPilotBotStart(command) {
  if (typeof command !== 'string' || command.length > 88) return null;
  const parts = command.split(' ');
  if (parts.length !== 2 || !isTeacherPilotInviteToken(parts[1])) return null;
  if (parts[0] !== '/start' && !(parts[0].startsWith('/start@') && parts[0].slice(7).toLowerCase() === 'univeracademybot')) return null;
  return {
    text: 'Sizni guruhga taklif qilishdi. O‘quvchi kabinetini ochib, taklifni tasdiqlang.',
    studentPath: '/student/?invite=' + parts[1],
  };
}
