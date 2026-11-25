export const staffOrigin = 'https://ustoz.univeracademy.uz';
const cabinets = new Map([
  ['/', {role:'teacher', title:'O‘qituvchi kabineti'}],
  ['/admin', {role:'admin', title:'Admin kabineti'}],
]);

export function staffDestination(location) {
  if (location.origin !== staffOrigin || location.search || location.hash) return null;
  return cabinets.get(location.pathname) ?? null;
}
