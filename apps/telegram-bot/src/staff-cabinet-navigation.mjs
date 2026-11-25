// The private directory returns only a role enum. No user-supplied destination,
// account identifier or Telegram proof enters either link.
const destinations = new Map([
  ['teacher', {browser:'https://ustoz.univeracademy.uz/', handoff:'open-staff/teacher'}],
  ['admin', {browser:'https://ustoz.univeracademy.uz/admin', handoff:'open-staff/admin'}],
  ['owner', {browser:'https://ega.univeracademy.uz/', handoff:'open-staff/owner'}],
]);

export async function staffCabinetNavigation(env, telegramUserId) {
  let timer;
  try {
    if (!Object.hasOwn(env, 'TELEGRAM_TEACHER_PILOT_ENABLED') || env.TELEGRAM_TEACHER_PILOT_ENABLED !== 'true') return null;
    const directory = env.TELEGRAM_PILOT_DIRECTORY;
    if (typeof directory?.readStaffCabinet !== 'function') return null;
    const role = await Promise.race([
      directory.readStaffCabinet({telegramUserId}),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); }),
    ]);
    return destinations.get(role) ?? null;
  } catch {
    // An optional staff navigation hint must never block a working student menu.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
