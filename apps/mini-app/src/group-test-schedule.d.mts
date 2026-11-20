import type {PilotDashboard} from './staging-student-port.ts';
export function openingLabel(opensAt:number):string;
export function nextScheduleDelay(dashboard:PilotDashboard, elapsedMs:number):number|null;
