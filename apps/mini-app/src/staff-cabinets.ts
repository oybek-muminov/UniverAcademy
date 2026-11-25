import { hasTelegramLaunchContext, readTelegramBridge } from './telegram-bridge.ts';

export const staffCabinets = {
  owner: { title: 'Ega kabineti', url: 'https://ega.univeracademy.uz/' },
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

// The first launch of a role in this document opens the browser by itself; later
// mounts (a remount, or coming back to the Mini App) never reopen it. The visible
// link stays available whenever the automatic launch was unavailable or not enough.
const autoOpened = new Set<StaffRole>();
export function autoOpenStaffBrowser(role: StaffRole, scope: Window): 'opened' | 'already' | 'unavailable' {
  if (autoOpened.has(role)) return 'already';
  autoOpened.add(role);
  return openStaffBrowser(role, scope) ? 'opened' : 'unavailable';
}
