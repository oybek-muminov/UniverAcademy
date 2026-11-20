// Owner has a single authenticated read on the staff surface.
export function cabinetRole(path,method) {
  if(path==='/api/v1/owner/pilot/dashboard' && method==='GET') return 'owner';
  return /^\/api\/v1\/(teacher|admin|student)\/pilot\//.exec(path)?.[1];
}
