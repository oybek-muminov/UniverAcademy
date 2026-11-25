import {useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {readStagingInvite} from './staging-student-port.ts';
import type {EntryGroupDashboard, PilotAttempt, PilotCommands, PilotDashboard, PilotResult, QuestionBlock, StagingStudentPort} from './staging-student-port.ts';
import {openingLabel,nextScheduleDelay} from './group-test-schedule.mjs';
import {isTransient,failureOutcome,remainingSeconds,resyncDelay,clockText} from './staging-panel-policy.mjs';
import {renderBlocks} from './rich-blocks.mjs';
import {asFailure, createOperationJournal, failureMessage, StudentFailure} from './transport.ts';
import './rich-blocks.css';

function Rich({blocks,port}:{blocks:QuestionBlock[];port:StagingStudentPort}) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = host.current!, controller = new AbortController();
    node.replaceChildren();
    renderBlocks(node,blocks,{loadKatex:() => import('katex'),loadAsset:port.media,signal:controller.signal});
    return () => { controller.abort(); node.replaceChildren(); };
  },[blocks,port]);
  return <span ref={host}/>;
}
const messages: Record<string,string> = {
  ADMISSION_CLOSED:'Hozir bu testni boshlash mumkin emas. Guruh jadvalini yangilang.',
  INVALID_INVITE:'Taklif topilmadi yoki bu hisob uchun berilmagan.',
  INVITE_EXPIRED:'Taklif muddati tugagan. O‘qituvchidan yangi taklif so‘rang.',
  GROUP_MEMBERSHIP_CONFLICT:'Siz boshqa guruhga biriktirilgansiz. Adminga murojaat qiling.',
  ATTEMPT_EXPIRED:'Vaqt tugadi. Saqlangan javoblaringiz hisobga olinadi.',
  ATTEMPT_TERMINAL:'Bu test allaqachon yakunlangan.',
  ATTEMPT_SUPERSEDED:'Urinish yangilangan. Holat qayta o‘qiladi.',
  REVISION_CONFLICT:'Javob holati o‘zgargan. Saqlangan javoblar qayta o‘qiladi.',
  EXAM_ACCESS_REVOKED:'Bu testga kirish huquqingiz yopilgan.',
  NOT_FOUND:'Test topilmadi. Ro‘yxat qayta o‘qiladi.',
};
export default function StagingStudentPanel({port,person,onAuthLost,onJoined,ordinaryExams,takeEntryDashboard}:{
  takeEntryDashboard?(): EntryGroupDashboard | undefined;
  port:StagingStudentPort;person:string;onAuthLost():void;onJoined():Promise<void>;ordinaryExams(groupAssignments?:ReadonlySet<string>):ReactNode;
}) {
  const [dashboard,setDashboard] = useState<PilotDashboard|null>(null);
  const [attempt,setAttempt] = useState<PilotAttempt|null>(null), [result,setResult] = useState<PilotResult|null>(null);
  const [attemptTitle,setAttemptTitle] = useState('');
  const [startIntent,setStartIntent] = useState<PilotDashboard['assignments'][number]|null>(null);
  const [questionIndex,setQuestionIndex] = useState(0);
  const [invite,setInvite] = useState(() => readStagingInvite()), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false);
  const [previouslyGrouped,setPreviouslyGrouped] = useState(false);
  const [confirm,setConfirm] = useState(false), [needsRead,setNeedsRead] = useState(false);
  // Timer: server time at receipt plus local monotonic elapsed time; the phone's wall clock is not used.
  const [clock,setClock] = useState<{serverNow:number;receivedAt:number}|null>(null), [seconds,setSeconds] = useState<number|null>(null);
  const [syncDue,setSyncDue] = useState(false), [reloadDue,setReloadDue] = useState(false), retries = useRef(0);
  const mounted = useRef(false), lock = useRef(false), dashboardReceived = useRef(0);
  const [journal] = useState(() => {
    try { return createOperationJournal(window.sessionStorage); } catch { return createOperationJournal(); }
  });
  async function command<K extends keyof PilotCommands>(action:K, body:PilotCommands[K][0]) {
    // Only digests of the actor and payload are journalled. Persisted retry keys
    // cannot reveal a student's selected answer or invitation.
    const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([person,action,body])));
    const scope = Array.from(new Uint8Array(bytes),n => n.toString(16).padStart(2,'0')).join('');
    const value = await port.command(action,body,journal.key(scope));
    journal.clear(scope);
    return value;
  }
  async function refresh(entry?:EntryGroupDashboard, keepResult = false) {
    let next:PilotDashboard;
    try { next = entry?.dashboard ?? await port.dashboard(); }
    catch (error) {
      // A dropped connection leaves the screen as it is. Any other failure (wrong person, bad shape,
      // lost access) means the shown group content can no longer be trusted, so it is removed.
      if (mounted.current && !isTransient(asFailure(error).kind)) { setDashboard(null); setAttempt(null); setResult(null); setStartIntent(null); }
      throw error;
    }
    if (!mounted.current) return;
    dashboardReceived.current = entry?.receivedAt ?? performance.now();
    setPreviouslyGrouped(next.group?.status === 'active');
    setStartIntent(null); setDashboard(next); setAttempt(null); if (!keepResult) setResult(null);
    setNeedsRead(false); setConfirm(false); setSyncDue(false); retries.current = 0;
    return next;
  }
  async function run(operation:()=>Promise<unknown>, keepNotice = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true); if (!keepNotice) setNotice('');
    try { await operation(); }
    catch (error) {
      if (!mounted.current) return;
      const failure = asFailure(error);
      if (failure.kind === 'auth') { setDashboard(null); setAttempt(null); setResult(null); onAuthLost(); return; }
      const outcome = failureOutcome(failure.kind, !!attempt);
      if (outcome.scopeLost) {
        // Scope was lost: hide protected content, then read the real state once instead of leaving an empty page.
        setAttempt(null); setDashboard(null); setResult(null); setStartIntent(null); setConfirm(false); setSyncDue(false); setReloadDue(true);
      } else if (outcome.resync) {
        setConfirm(false);
        if (outcome.lockAnswers) setNeedsRead(true);
        setSyncDue(true);
      }
      if (failure.code === 'ADMISSION_CLOSED') setStartIntent(null);
      setNotice(messages[failure.code] ?? (attempt && isTransient(failure.kind)
        ? 'Aloqa muammosi: oxirgi amal tasdiqlanmadi. Qayta urinib ko‘ring; aloqa tiklanganda saqlangan javoblar o‘zi tekshiriladi.'
        : failureMessage(failure,'clerk')));
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void run(() => refresh(takeEntryDashboard?.()));
    return () => { mounted.current = false; };
  },[port]);
  useEffect(() => {
    if (!dashboard || busy || attempt || result || startIntent) return;
    const delay = nextScheduleDelay(dashboard, performance.now() - dashboardReceived.current);
    if (delay === null) return;
    const timer = setTimeout(() => void run(refresh), delay);
    return () => clearTimeout(timer);
  },[dashboard,busy,attempt,result,startIntent,port]);
  useEffect(() => {
    if (!attempt || !clock) { setSeconds(null); return; }
    const tick = () => setSeconds(remainingSeconds({deadlineAt:attempt.deadlineAt,serverNow:clock.serverNow,receivedAt:clock.receivedAt,now:performance.now()}));
    tick(); const interval = setInterval(tick,250);
    return () => clearInterval(interval);
  },[attempt?.id,attempt?.deadlineAt,clock]);
  const timeIsUp = !!attempt && seconds === 0;
  useEffect(() => {
    if (!timeIsUp) return;
    setNeedsRead(true); setConfirm(false); setNotice('Vaqt tugadi. Natija tekshirilmoqda…'); retries.current = 0; setSyncDue(true);
  },[timeIsUp,attempt?.id]);
  // Re-read the saved state automatically after a failure, when the connection returns and when the app comes back.
  useEffect(() => {
    const delay = resyncDelay(retries.current);
    if (!syncDue || !attempt || busy || delay === null) return;
    const timer = setTimeout(() => {
      retries.current += 1;
      void run(async () => {
        const fresh = await command('resumeAttempt',{attemptId:attempt.id});
        await adopt(fresh);
        if (fresh.status !== 'in_progress') setNotice('Vaqt tugadi. Natija ro‘yxatda ko‘rinadi.');
      }, true);
    }, delay);
    return () => clearTimeout(timer);
  },[syncDue,attempt?.id,busy]);
  useEffect(() => {
    if (!attempt) return;
    const wake = () => { if (document.visibilityState === 'visible') { retries.current = 0; setSyncDue(true); } };
    window.addEventListener('online',wake); document.addEventListener('visibilitychange',wake);
    return () => { window.removeEventListener('online',wake); document.removeEventListener('visibilitychange',wake); };
  },[attempt?.id]);
  useEffect(() => {
    if (!reloadDue || busy) return;
    setReloadDue(false);
    void run(refresh,true);
  },[reloadDue,busy]);
  async function adopt(data:PilotAttempt, title?:string) {
    if (data.status !== 'in_progress') { await refresh(); return; }
    if (!Array.isArray(data.questions) || !data.questions.length || !Array.isArray(data.answers)) {
      throw new StudentFailure('protocol','RESPONSE_INVARIANT_FAILED');
    }
    if (attempt?.id !== data.id) setQuestionIndex(0);
    if (title) setAttemptTitle(title);
    setStartIntent(null);
    setClock({serverNow:Number.isSafeInteger(data.serverNow) ? data.serverNow! : Date.now(),receivedAt:performance.now()});
    setAttempt(data); setConfirm(false); setNeedsRead(false); setSyncDue(false); retries.current = 0;
  }
  const feedback = <p role="status">{notice}</p>;
  if (attempt) {
    const answered = new Set(attempt.answers.filter(a=>a.optionId !== null).map(a=>a.questionId));
    const saved = answered.size, count = attempt.questions.length;
    const index = Math.min(questionIndex,count-1), q = attempt.questions[index];
    const currentAnswer = attempt.answers.find(answer => answer.questionId === q.id);
    return <section className="card">{feedback}<h2>{attemptTitle || 'Guruh testi'}</h2>
      {seconds !== null && <p><strong role="timer" aria-label="Qolgan vaqt" className={seconds <= 60 ? 'urgent' : ''}>{clockText(seconds)}</strong></p>}
      <p>Saqlangan javoblar: {saved} / {attempt.questions.length} · Tugash vaqti: {new Date(attempt.deadlineAt).toLocaleTimeString('uz-UZ',{hour:'2-digit', minute:'2-digit', timeZone:'Asia/Tashkent'})} (Toshkent)</p>
      <p className="question-key"><span><i className="key-unanswered" aria-hidden="true"/>Javobsiz</span>
        <span><i className="key-answered" aria-hidden="true"/>Javob saqlangan</span><span><i className="key-current" aria-hidden="true"/>Joriy savol</span></p>
      <nav className="question-nav" aria-label="Savollar">
        {attempt.questions.map((question,i)=><button type="button" key={question.id} disabled={busy || confirm}
          aria-current={i===index ? 'step' : undefined} aria-label={(i+1)+'-savol, '+(answered.has(question.id)?'javob tasdiqlangan':'javobsiz')}
          className={answered.has(question.id)?'answered':'unanswered'} onClick={()=>setQuestionIndex(i)}>{i+1}</button>)}
      </nav>
      <fieldset key={q.id} disabled={busy || needsRead || confirm || timeIsUp}>
        <legend>{index+1}. <Rich blocks={q.prompt_blocks} port={port}/></legend>
        {q.options.map(opt=><label className="option" key={opt.id}><input type="radio" name={q.id}
          checked={currentAnswer?.optionId === opt.id}
          onChange={()=>void run(async()=>{
            const revision=currentAnswer?.revision ?? 0;
            const answer=await command('saveAnswer',{attemptId:attempt.id,questionId:q.id,optionId:opt.id,expectedRevision:revision});
            setAttempt({...attempt,answers:[...attempt.answers.filter(a=>a.questionId!==q.id),answer]});
            setNotice((index+1)+'-savolning javobi saqlandi.');
          })}/><Rich blocks={opt.blocks} port={port}/></label>)}
      </fieldset>
      <div className="question-actions">
        <button className="secondary" disabled={busy || confirm || index===0} onClick={()=>setQuestionIndex(index-1)}>← Oldingi</button>
        <button className="secondary" disabled={busy || confirm || index===count-1} onClick={()=>setQuestionIndex(index+1)}>Keyingi →</button>
      </div>
      {confirm ? <><p>Testni yakunlaysizmi? {saved} ta javob saqlangan. {count-saved} ta savol javobsiz.</p>
        <button disabled={busy} onClick={()=>void run(async()=>{
          const score=await command('submitAttempt',{attemptId:attempt.id});
          // The score is on screen as soon as the server confirms; reloading the list afterwards cannot take it away.
          setAttempt(null); setConfirm(false); setNeedsRead(false); setSyncDue(false); setResult({...score,title:attemptTitle});
          try { await refresh(undefined,true); }
          catch (error) { if (!isTransient(asFailure(error).kind)) throw error; setNotice('Natija saqlandi. Ro‘yxatni keyinroq yangilang.'); }
        })}>Ha, javoblarni yuborish</button>
        <button disabled={busy} onClick={()=>setConfirm(false)}>Testga qaytish</button></> :
        <button disabled={busy || needsRead || timeIsUp} onClick={()=>setConfirm(true)}>Testni yakunlash</button>}
      <button disabled={busy} onClick={()=>void run(async()=>adopt(await command('resumeAttempt',{attemptId:attempt.id})))}>Saqlangan javoblarni yangilash</button>
      <button disabled={busy} onClick={()=>void run(refresh)}>Kabinetga qaytish</button></section>;
  }
  if (result) return <section className="card">{feedback}<h2>Test natijasi</h2><p>{result.title}</p><p>{result.earned} / {result.maximum} ball · {result.percentage}%</p>
    <button disabled={busy} onClick={()=>void run(refresh)}>Kabinetga qaytish</button></section>;
  if (startIntent && dashboard) return <section className="card">{feedback}<h2>Testni boshlaysizmi?</h2>
    <p>{startIntent.title}. Tasdiqlaganingizda test vaqti boshlanadi.</p>
    <button className="primary" disabled={busy} onClick={()=>void run(async()=>adopt(await command('startAttempt',{assignmentId:startIntent.id}),startIntent.title))}>Ha, boshlash</button>
    <button className="secondary" disabled={busy} onClick={()=>setStartIntent(null)}>Ortga</button></section>;
  const grouped = dashboard?.group?.status === 'active';
  if (!grouped && !invite && !previouslyGrouped) return <>{notice && feedback}{ordinaryExams()}</>;
  const assignedAttempts = new Set(dashboard?.assignments.map(exam => exam.attemptId));
  const resultByAttempt = new Map<string,PilotResult>();
  for (const row of dashboard?.results ?? []) {
    const id = row.attemptId;
    if (id !== undefined && !resultByAttempt.has(id)) resultByAttempt.set(id, row);
  }
  return <><section className="card">{feedback}<h2>Guruhim</h2>
    {dashboard && <><p>{dashboard.group?.name ?? 'Hozircha guruhga biriktirilmagansiz.'}</p>
      {invite && <button disabled={busy} onClick={()=>void run(async()=>{
        const group = await command('acceptInvite',{token:invite});
        const joined = await refresh();
        if (!mounted.current) return;
        if (joined?.group?.id !== group.id || joined.group.status !== 'active') throw new StudentFailure('protocol','RESPONSE_INVARIANT_FAILED');
        await onJoined();
        if (!mounted.current) return;
        const url = new URL(location.href); url.searchParams.delete('invite'); history.replaceState(null,'',url);
        setInvite(null); setNotice('Siz «'+joined.group.name+'» guruhiga qo‘shildingiz.');
      })}>Taklifni qabul qilish</button>}
    </>}
    {dashboard && grouped && <><h2>Guruh testlari</h2>
      {!dashboard.assignments.length && <p>Hozircha sizga guruh testi tayinlanmagan.</p>}
      {dashboard.assignments.map(exam => {
        const result = exam.attemptId === null ? undefined : resultByAttempt.get(exam.attemptId);
        return <section key={exam.id}><h3>{exam.title}</h3>
        {exam.status==='scheduled' && exam.opensAt !== undefined ? <p>{openingLabel(exam.opensAt)}</p> :
          exam.status==='closed' ? <p>Testni boshlash muddati tugagan.</p> :
          exam.status==='available' ? <button disabled={busy} onClick={()=>setStartIntent(exam)}>Testni boshlash</button> :
          exam.status==='in_progress' && exam.attemptId ? <button disabled={busy} onClick={()=>void run(async()=>adopt(await command('resumeAttempt',{attemptId:exam.attemptId!}),exam.title))}>Testni davom ettirish</button> :
          result ? <button disabled={busy} onClick={()=>setResult(result)}>Natijani ko‘rish</button> :
          <p>Test yakunlangan.</p>}</section>;
      })}
      {dashboard.results.filter(row => row.attemptId === undefined || !assignedAttempts.has(row.attemptId)).map(row=>
        <section key={row.attemptId}><h3>{row.title}</h3><button disabled={busy} onClick={()=>setResult(row)}>Natijani ko‘rish</button></section>)}</>}
    <button disabled={busy} onClick={()=>void run(refresh)}>Guruhni yangilash</button></section>
    {ordinaryExams(grouped ? new Set(dashboard!.assignments.map(exam => exam.id)) : undefined)}</>;
}
