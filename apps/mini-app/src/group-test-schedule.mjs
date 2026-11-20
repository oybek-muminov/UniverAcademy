const tashkent = new Intl.DateTimeFormat('uz-UZ', {
  year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit',
  hourCycle:'h23', timeZone:'Asia/Tashkent',
});

export function openingLabel(opensAt) {
  return 'Boshlanishi: ' + tashkent.format(opensAt) + ' (Toshkent vaqti)';
}

export function nextScheduleDelay(dashboard, elapsedMs) {
  if (!Number.isSafeInteger(dashboard.serverNow)) return null;
  let next = Infinity;
  for (const exam of dashboard.assignments) {
    const boundary = exam.status === 'scheduled' ? exam.opensAt : exam.status === 'available' ? exam.closesAt : null;
    if (Number.isSafeInteger(boundary) && boundary > dashboard.serverNow) next = Math.min(next, boundary);
  }
  if (!Number.isFinite(next)) return null;
  return Math.min(2147483647, Math.max(0, next - dashboard.serverNow - elapsedMs) + 50);
}
