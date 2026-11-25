import { StudentFailure } from './transport.ts';
import type {FailureKind} from './transport.ts';

export type QuestionBlock = {type:'text'; markdown:string} | {type:'formula'; latex:string; display:'block'|'inline'} |
  {type:'image'; asset:{asset_id:string;url:string}; alt:string; caption?:string};
export type PilotAttempt = {
  id:string; status:string; deadlineAt:string; serverNow?:number;
  questions:{id:string;prompt_blocks:QuestionBlock[];options:{id:string;blocks:QuestionBlock[]}[]}[];
  answers:{questionId:string;optionId:string|null;revision:number}[];
};
export type PilotResult = {attemptId?:string; title?:string; earned:string; maximum:string; percentage:string};
export type PilotDashboard = {
  role:'student'; person_id:string; univeracademy_id:string; name:string; group:{id:string;name:string;status:string}|null;
  serverNow?:number;
  assignments:{id:string;title:string;attemptId:string|null;status:string;opensAt?:number;closesAt?:number}[]; results:PilotResult[];
};
export type EntryGroupDashboard = {dashboard:PilotDashboard; receivedAt:number};
export type PilotCommands = {
  acceptInvite:[{token:string},{id:string;name:string}];
  startAttempt:[{assignmentId:string},PilotAttempt]; resumeAttempt:[{attemptId:string},PilotAttempt];
  saveAnswer:[{attemptId:string;questionId:string;optionId:string;expectedRevision:number},PilotAttempt['answers'][number]];
  submitAttempt:[{attemptId:string},PilotResult];
};
type Access = <T>(action:(access:string)=>Promise<T>,mutation?:boolean)=>Promise<T>;
const actions: ReadonlySet<string> = new Set(['acceptInvite','startAttempt','resumeAttempt','saveAnswer','submitAttempt']);
const failures:Record<number,FailureKind> = {401:'auth',403:'forbidden',404:'missing',409:'conflict',410:'conflict',422:'validation',429:'limited'};
const invalid = () => new StudentFailure('protocol','RESPONSE_INVARIANT_FAILED');
// The URL is an invitation intent. Membership is established by the authenticated server.
export function readStagingInvite(url = globalThis.location?.href):string|null {
  if (!url) return null;
  const values = new URL(url).searchParams.getAll('invite');
  const token = values[0];
  return values.length === 1 && token.length === 36 && /^grp_[A-Za-z0-9_-]{32}$/.test(token) ? token : null;
}
export function createStagingStudentPort(config: {
  baseUrl:string; person:string; current:()=>string|null; access:Access; fetcher:(request:Request)=>Promise<Response>;
}) {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/api/v1' || base.username || base.password || base.search || base.hash) throw invalid();
  const prefix = base.origin + '/api/v1/student/pilot/';
  const check = () => { if (!config.person || config.current() !== config.person) throw new StudentFailure('auth','ACCESS_SUPERSEDED'); };
  async function call<T>(path:string, decode:(response:Response)=>Promise<T>, body?:object,key?:string,signal?:AbortSignal) {
    check();
    return config.access(async bearer => {
      check();
      const headers = new Headers({Authorization: 'Bearer ' + bearer, Accept: 'application/json'});
      if (body) { headers.set('Content-Type','application/json'); headers.set('Idempotency-Key',key!); }
      const timeout = AbortSignal.timeout(15000);
      const response = await config.fetcher(new Request(prefix + path, {method: body ? 'POST' : 'GET',headers,
        body:body ? JSON.stringify(body) : undefined, credentials:'omit', cache:'no-store', redirect:'error', referrerPolicy:'no-referrer',
        signal: signal ? AbortSignal.any([signal,timeout]) : timeout}));
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const code = typeof error?.error?.code === 'string' ? error.error.code : 'UNCONFIRMED';
        // A misconfigured optional gateway must not revoke a working ordinary session.
        const kind = response.status === 401 && !['SESSION_REVOKED','CLERK_SESSION_REVOKED','APP_SESSION_EXPIRED'].includes(code)
          ? 'forbidden' : failures[response.status] ?? 'temporary';
        throw new StudentFailure(kind,code);
      }
      const data = await decode(response);
      check();
      return data;
    }, !!body);
  }
  async function json<T>(response: Response):Promise<T> {
    const envelope = await response.json();
    if (!envelope?.data || typeof envelope.data !== 'object') throw invalid();
    return envelope.data;
  }
  return {
    async dashboard() {
      const value = await call('dashboard',json<PilotDashboard>);
      if (value.role !== 'student' || value.person_id !== config.person || !Array.isArray(value.assignments) || !Array.isArray(value.results)) throw invalid();
      if (value.group !== null && (!value.group || typeof value.group.id !== 'string' || !value.group.id ||
          typeof value.group.name !== 'string' || !value.group.name || typeof value.group.status !== 'string')) throw invalid();
      const validTime = (ms:unknown) => typeof ms === 'number' && Number.isSafeInteger(ms) && Math.abs(ms) <= 8.64e15;
      if (value.serverNow !== undefined && !validTime(value.serverNow)) throw invalid();
      if (value.assignments.some(row => !row || typeof row.id !== 'string' || !row.id || typeof row.title !== 'string' ||
          typeof row.status !== 'string' || ((row.opensAt !== undefined || row.status === 'scheduled') && !validTime(row.opensAt)) ||
          (row.closesAt !== undefined && (!validTime(row.closesAt) || (row.opensAt !== undefined && row.closesAt <= row.opensAt))) ||
          !(row.attemptId === null || typeof row.attemptId === 'string')) ||
          value.results.some(row => !row || typeof row.earned !== 'string' || typeof row.maximum !== 'string' || typeof row.percentage !== 'string' ||
          (row.title !== undefined && typeof row.title !== 'string') || (row.attemptId !== undefined && typeof row.attemptId !== 'string'))) throw invalid();
      return value;
    },
    command<K extends keyof PilotCommands>(action:K, body:PilotCommands[K][0], key:string):Promise<PilotCommands[K][1]> {
      if (!actions.has(action) || !key) throw invalid();
      return call('commands/' + action,json<PilotCommands[K][1]>,body,key);
    },
    async media(block: Extract<QuestionBlock,{type:'image'}>, signal:AbortSignal) {
      const id = block.asset?.asset_id;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || typeof block.asset.url !== 'string' ||
          new URL(block.asset.url, base.origin).href !== prefix + 'media/' + id) throw invalid();
      return call('media/' + id,async response => {
        if (response.headers.get('content-type')?.split(';')[0] !== 'image/png') throw invalid();
        const blob = await response.blob();
        if (blob.size === 0 || blob.size > 8 * 1024 * 1024) throw invalid();
        return blob;
      },undefined,undefined,signal);
    },
  };
}
export type StagingStudentPort = ReturnType<typeof createStagingStudentPort>;
