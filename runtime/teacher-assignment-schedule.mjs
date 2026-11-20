// The cabinet uses one admission day in Tashkent. Individual attempt deadlines
// are set by the exam engine when each student starts.
import {fail} from '../supabase/functions/univeracademy-api/fault.ts';
import {isProtectedNextMidnight} from '../supabase/functions/univeracademy-api/pilot-provisioning.ts';

export const cabinetTimezone='Asia/Tashkent';
const localClock=new Intl.DateTimeFormat('en-GB',{timeZone:cabinetTimezone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const lastWireDate=Date.parse('9999-12-31T23:59:59.999Z');
const hourMs=3_600_000;
export function assignmentSchedule(now,startsAt){
  if(startsAt!==undefined&&(!Number.isSafeInteger(startsAt)||startsAt<=now||startsAt>lastWireDate))fail('INVALID_TIME_WINDOW',422);
  // Preserve the second-aligned immediate openings created by legacy clients.
  const opensAt=startsAt??Math.floor(now/1000)*1000;
  const clock=Object.fromEntries(localClock.formatToParts(opensAt).map(part=>[part.type,part.value]));
  const elapsedSeconds=Number(clock.hour)*3600+Number(clock.minute)*60+Number(clock.second);
  let closesAt=Math.floor(opensAt/1000)*1000+(86400-elapsedSeconds)*1000;
  // If zone rules change before midnight, resolve the boundary against the
  // canonical calendar policy, as with the original hourly boundary search.
  if(!isProtectedNextMidnight(opensAt,closesAt,cabinetTimezone)){
    closesAt=(Math.floor(opensAt/hourMs)+1)*hourMs;
    const limit=closesAt+25*hourMs;
    while(closesAt<limit&&!isProtectedNextMidnight(opensAt,closesAt,cabinetTimezone))closesAt+=hourMs;
    if(closesAt===limit)fail('INVALID_TIME_WINDOW',422);
  }
  if(closesAt>lastWireDate)fail('INVALID_TIME_WINDOW',422);
  return {opens_at:new Date(opensAt).toISOString(),closes_at:new Date(closesAt).toISOString(),timezone:cabinetTimezone};
}
export function studentAssignmentStatus(window,now,attemptStatus,cancelled){
  if(cancelled&&(!attemptStatus||attemptStatus==='in_progress'))return 'closed';
  if(attemptStatus)return attemptStatus;
  if(!Number.isSafeInteger(window.opensAt)||!Number.isSafeInteger(window.closesAt)||now>=window.closesAt)return 'closed';
  return now<window.opensAt?'scheduled':'available';
}
