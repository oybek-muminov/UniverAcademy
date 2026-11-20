import {useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {readStagingInvite} from './staging-student-port.ts';
import type {PilotAttempt, PilotCommands, PilotDashboard, PilotResult, QuestionBlock, StagingStudentPort} from './staging-student-port.ts';
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
export default function StagingStudentPanel({port,person,onAuthLost,onJoined,ordinaryExams}:{
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
  const mounted = useRef(false), lock = useRef(false);
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
  async function refresh() {
    let next:PilotDashboard;
    try { next = await port.dashboard(); }
    catch (error) {
      if (mounted.current) { setDashboard(null); setAttempt(null); setResult(null); setStartIntent(null); }
      throw error;
    }
    if (!mounted.current) return;
    setPreviouslyGrouped(next.group?.status === 'active');
    setStartIntent(null); setDashboard(next); setAttempt(null); setResult(null); setNeedsRead(false); setConfirm(false);
    return next;
  }
  async function run(operation:()=>Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNotice('');
    try { await operation(); }
    catch (error) {
      if (!mounted.current) return;
      const failure = asFailure(error);
      if (failure.kind === 'auth') { setDashboard(null); setAttempt(null); setResult(null); onAuthLost(); return; }
      if (failure.kind === 'forbidden' || failure.kind === 'missing') { setAttempt(null); setDashboard(null); setResult(null); }
      else if (attempt) { setNeedsRead(true); setConfirm(false); }
      const messages: Record<string,string> = {INVALID_INVITE:'Taklif topilmadi yoki bu hisob uchun berilmagan.',
        INVITE_EXPIRED:'Taklif muddati tugagan. O‘qituvchidan yangi taklif so‘rang.',
        GROUP_MEMBERSHIP_CONFLICT:'Siz boshqa guruhga biriktirilgansiz. Adminga murojaat qiling.'};
      setNotice(messages[failure.code] ?? failureMessage(failure,'clerk'));
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void run(refresh); return () => { mounted.current = false; }; },[port]);
  useEffect(() => {
    if (!attempt) return;
    const delay = Math.max(0, Date.parse(attempt.deadlineAt) - Date.now());
    if (!Number.isFinite(delay) || delay > 2147483647) return;
    const timer = setTimeout(() => { setNeedsRead(true); setConfirm(false); setNotice('Vaqt tugadi. Urinish holatini yangilang.'); }, delay);
    return () => clearTimeout(timer);
  },[attempt?.id,attempt?.deadlineAt]);
  async function adopt(data:PilotAttempt, title?:string) {
    if (data.status !== 'in_progress') { await refresh(); return; }
    if (!Array.isArray(data.questions) || !data.questions.length || !Array.isArray(data.answers)) {
      throw new StudentFailure('protocol','RESPONSE_INVARIANT_FAILED');
    }
    if (attempt?.id !== data.id) setQuestionIndex(0);
    if (title) setAttemptTitle(title);
    setStartIntent(null);
    setAttempt(data); setConfirm(false); setNeedsRead(false);
  }
  const feedback = <p role="status">{notice}</p>;
  if (attempt) {
    const answered = new Set(attempt.answers.filter(a=>a.optionId !== null).map(a=>a.questionId));
    const saved = answered.size, count = attempt.questions.length;
    const index = Math.min(questionIndex,count-1), q = attempt.questions[index];
    return <section className="card">{feedback}<h2>{attemptTitle || 'Guruh testi'}</h2>
      <p>Saqlangan javoblar: {saved} / {attempt.questions.length} · Tugash vaqti: {new Date(attempt.deadlineAt).toLocaleTimeString('uz-UZ',{hour:'2-digit', minute:'2-digit', timeZone:'Asia/Tashkent'})} (Toshkent)</p>
      <p className="question-key"><span><i className="key-unanswered" aria-hidden="true"/>Javobsiz</span>
        <span><i className="key-answered" aria-hidden="true"/>Javob saqlangan</span><span><i className="key-current" aria-hidden="true"/>Joriy savol</span></p>
      <nav className="question-nav" aria-label="Savollar">
        {attempt.questions.map((question,i)=><button type="button" key={question.id} disabled={busy || confirm}
          aria-current={i===index ? 'step' : undefined} aria-label={(i+1)+'-savol, '+(answered.has(question.id)?'javob tasdiqlangan':'javobsiz')}
          className={answered.has(question.id)?'answered':'unanswered'} onClick={()=>setQuestionIndex(i)}>{i+1}</button>)}
      </nav>
      <fieldset key={q.id} disabled={busy || needsRead || confirm}>
        <legend>{index+1}. <Rich blocks={q.prompt_blocks} port={port}/></legend>
        {q.options.map(opt=><label className="option" key={opt.id}><input type="radio" name={q.id}
          checked={attempt.answers.some(a=>a.questionId===q.id && a.optionId===opt.id)}
          onChange={()=>void run(async()=>{
            const revision=attempt.answers.find(a=>a.questionId===q.id)?.revision ?? 0;
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
        <button disabled={busy} onClick={()=>void run(async()=>{const score=await command('submitAttempt',{attemptId:attempt.id});await refresh();setResult({...score,title:attemptTitle});})}>Ha, javoblarni yuborish</button>
        <button disabled={busy} onClick={()=>setConfirm(false)}>Testga qaytish</button></> :
        <button disabled={busy || needsRead} onClick={()=>setConfirm(true)}>Testni yakunlash</button>}
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
  if (!grouped && !invite && !previouslyGrouped) return ordinaryExams();
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
      {dashboard.assignments.map(exam=><section key={exam.id}><h3>{exam.title}</h3>
        {exam.status==='available' ? <button disabled={busy} onClick={()=>setStartIntent(exam)}>Testni boshlash</button> :
          exam.status==='in_progress' && exam.attemptId ? <button disabled={busy} onClick={()=>void run(async()=>adopt(await command('resumeAttempt',{attemptId:exam.attemptId!}),exam.title))}>Testni davom ettirish</button> :
          dashboard.results.some(r=>r.attemptId===exam.attemptId) ? <button disabled={busy} onClick={()=>setResult(dashboard.results.find(r=>r.attemptId===exam.attemptId)!)}>Natijani ko‘rish</button> :
          <p>Test yakunlangan.</p>}</section>)}
      {dashboard.results.filter(row=>!dashboard.assignments.some(exam=>exam.attemptId===row.attemptId)).map(row=>
        <section key={row.attemptId}><h3>{row.title}</h3><button disabled={busy} onClick={()=>setResult(row)}>Natijani ko‘rish</button></section>)}</>}
    <button disabled={busy} onClick={()=>void run(refresh)}>Guruhni yangilash</button></section>
    {ordinaryExams(grouped ? new Set(dashboard!.assignments.map(exam => exam.id)) : undefined)}</>;
}
