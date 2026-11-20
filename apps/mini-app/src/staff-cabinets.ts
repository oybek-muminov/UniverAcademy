import { hasTelegramLaunchContext, readTelegramBridge } from './telegram-bridge.ts';

export const staffCabinets = {
  owner: { title: 'Ega kabineti', url: 'https://ustoz.univeracademy.uz/owner' },
  admin: { title: 'Admin kabineti', url: 'https://ustoz.univeracademy.uz/admin' },
  teacher: { title: 'O‘qituvchi kabineti', url: 'https://ustoz.univeracademy.uz/' },
} as const;

export type StaffRole = keyof typeof staffCabinets;
export const staffPriority = ['owner', 'admin', 'teacher'] as const;

export function staffHandoffRole(pathname: string) {
  return staffPriority.find(role => pathname === '/open-staff/' + role);
}

export function openStaffBrowser(role: StaffRole, scope: Window) {
  if (!hasTelegramLaunchContext(scope)) return false;
  const bridge = readTelegramBridge(scope);
  if (typeof bridge?.openLink !== 'function') return false;
  try {
    bridge.openLink(staffCabinets[role].url);
    return true;
  } catch {
    return false;
  }
}
