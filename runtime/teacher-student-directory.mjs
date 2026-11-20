export const studentDirectoryPageSize=25;
const directoryPath=/^\/api\/v1\/teacher\/pilot\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/available-students$/;
export const availableStudentsGroup=path=>directoryPath.exec(path)?.[1];
export const validStudentDirectorySearch=search=>search===''||/^\?after=[0-9]{10}$/.test(search);
export function cabinetQueryAllowed(url,method){
  return !url.search||(method==='GET'&&directoryPath.test(url.pathname)&&validStudentDirectorySearch(url.search));
}
