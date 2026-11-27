// The Owner surface: one read, two commands (look up a student, make a Teacher). Nothing else, on its own site.
export function cabinetRole(path,method) {
  if(path==='/api/v1/owner/pilot/dashboard' && (method==='GET'||method==='OPTIONS')) return 'owner';
  if(/^\/api\/v1\/owner\/pilot\/commands\/(findStudent|assignTeacher)$/.test(path) && (method==='POST'||method==='OPTIONS')) return 'owner';
  return /^\/api\/v1\/(teacher|admin|student)\/pilot\//.exec(path)?.[1];
}
