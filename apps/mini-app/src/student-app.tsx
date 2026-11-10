import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { localizeServerDisplay, historySummary } from './display.ts';
import type { ReactNode } from 'react';
import type { StudentFlow } from './flow.ts';

const letters = ['A', 'B', 'C', 'D'];

export function StudentApp({ studentFlow, mode, onEnter, onLogout, demoControls }: {
  studentFlow: StudentFlow; mode: 'demo' | 'local_fixture' | 'telegram';
  onEnter?: () => Promise<void>; onLogout?: () => Promise<void>; demoControls?: ReactNode;
}) {
  const flow = studentFlow;
  const s = useSyncExternalStore(flow.subscribe, flow.snapshot);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [confirmation, setConfirmation] = useState<'start' | 'submit' | 'questions' | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const firstName = useRef<HTMLInputElement>(null);
  const lastName = useRef<HTMLInputElement>(null);
  const focusTarget = useRef<HTMLHeadingElement>(null);

  useEffect(() => { focusTarget.current?.focus(); }, [s.screen]);
  useEffect(() => {
    if (confirmation) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation]);
  useEffect(() => {
    setQuestionIndex(0);
    setConfirmation(null);
  }, [s.attempt?.id, s.attempt?.generation]);
  useEffect(() => {
    if (s.screen !== 'attempt') setConfirmation(current => current === 'questions' ? null : current);
  }, [s.screen]);
  useEffect(() => {
    const tick = () => setSeconds(flow.remainingSeconds());
    tick(); const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [s.attempt]);
  useEffect(() => {
    const read = () => {
      if (flow.state.screen === 'attempt' && flow.state.attempt?.active) void flow.reconcile();
    };
    const visible = () => { if (document.visibilityState === 'visible') read(); };
    window.addEventListener('online', read);
    document.addEventListener('visibilitychange', visible);
    return () => { window.removeEventListener('online', read); document.removeEventListener('visibilitychange', visible); };
  }, []);

  const a = s.attempt;
  const q = a?.questions[Math.min(questionIndex, Math.max(0, a.questions.length - 1))];
  const answered = a?.questions.filter(question => a.answers[question.id]?.optionId != null).length ?? 0;
  const testing = s.screen === 'attempt' && !!a;
  const pending = s.draft?.questionId === q?.id ? s.draft : null;
  const confirmedOption = q ? a?.answers[q.id]?.optionId : null;
  const selectedOption = pending ? pending.optionId : confirmedOption;
  const locked = s.busy || s.needsRead || !!s.draft || !!flow.submitKey || seconds === 0;
  const title = { welcome: 'Testga xush kelibsiz', profile: 'Avval tanishib olaylik', exams: 'Mening testlarim',
    instructions: 'Boshlashga tayyormisiz?', attempt: 'Fizika testi', lifecycle: 'Urinish holati', result: 'Natijangiz', history: 'Urinishlar tarixi' }[s.screen];

  return <main className={`shell${testing ? ' test-shell' : ''}`}>
    {!testing && <><header className="brand"><span className="brand-mark" aria-hidden="true">U</span>
      <span>UniverAcademy<small>O‘quvchi kabineti</small></span>{mode !== 'telegram' && <span className="demo-badge">Lokal namuna</span>}</header>
    {mode !== 'telegram' && <p className="sample-notice">{mode === 'local_fixture' ? 'Mahalliy sintetik sinov. Haqiqiy o‘quvchi yoki Telegram hisobidan foydalanmang.' : 'Bu sinov interfeysi. Telegram va haqiqiy test xizmatiga ulanmagan. Sahifa yangilansa namuna boshidan boshlanadi.'}</p>}
    {mode !== 'demo' && s.student && <button className="text-button" onClick={() => void onLogout?.()}>Chiqish</button>}
    <section className="page-heading"><p className="eyebrow">O‘zingizga ishonch bilan</p>
      <h1 ref={focusTarget} tabIndex={-1}>{title}</h1></section></>}
    {s.notice && <div className="notice" role="alert">{s.notice}</div>}
    {s.failure && ['exams', 'attempt', 'lifecycle'].includes(s.screen) && <button className="text-button" disabled={s.busy}
      onClick={() => void (s.screen === 'exams' ? flow.showExams() : flow.reconcile())}>Holatni qayta tekshirish</button>}

    {s.screen === 'welcome' && <section className="card welcome">
      <div className="orbit" aria-hidden="true">↗</div><h2>Birinchi qadam — bilimni sinash</h2>
      <p>Testni boshlang, savollarga javob bering va natijangizni ko‘ring.</p>
      <button className="primary" disabled={s.busy} onClick={() => void (onEnter ? onEnter() : flow.enter())}>{mode === 'telegram' ? 'Qayta kirish' : mode === 'local_fixture' ? 'Sinovga kirish' : 'Namunani ochish'} <span aria-hidden="true">→</span></button>
      <small>{flow.signInMethod === 'clerk' ? 'Qayta kirishda Google yoki email usulini tanlang.' : 'Haqiqiy kirish nuqtasi: @univeracademybot'}</small>
    </section>}

    {s.screen === 'profile' && <form className="card" onSubmit={event => {
      event.preventDefault(); void flow.register(firstName.current!.value, lastName.current!.value);
    }}><h2>Ism va familiyangiz</h2><p>{mode === 'telegram' ? 'Ism va familiyangizni kiriting.' : 'Namuna uchun to‘qima ism ishlatishingiz mumkin.'}</p>
      <label htmlFor="first-name">Ism</label><input id="first-name" ref={firstName} required maxLength={100} autoComplete="given-name" placeholder="Masalan, Aziz" />
      <label htmlFor="last-name">Familiya</label><input id="last-name" ref={lastName} required maxLength={100} autoComplete="family-name" placeholder="Masalan, Karimov" />
      <button className="primary" disabled={s.busy}>Davom etish →</button>
    </form>}

    {s.screen === 'exams' && <>
      <div className="student-line"><span>Salom, <strong>{s.student?.firstName}</strong></span><span className="pill">ID: {s.student?.displayId}</span></div>
      {s.exams.map(exam => <article className="card exam-card" key={exam.id}>
        <div className="card-top"><span className="subject-icon" aria-hidden="true">⚛</span><span className="pill green">Sizga biriktirilgan</span></div>
        <h2>{exam.title}</h2><p>{exam.group}</p>
        <div className="exam-facts"><span><strong>{exam.count}</strong> savol</span><span><strong>{exam.durationLabel}</strong> vaqt</span></div>
        <button className="primary" disabled={s.busy} onClick={() => void flow.openExam(exam)}>Testni ko‘rish →</button>
        <button className="text-button" disabled={s.busy} onClick={() => void flow.showHistory(exam)}>Shu testning tarixi →</button>
      </article>)}
      {!s.exams.length && <section className="card"><h2>Hozircha test yo‘q</h2><p>Guruh testiga o‘qituvchi yoki administrator biriktiradi.</p></section>}
      <button className="text-button" disabled={s.busy} onClick={() => void flow.showExams()}>Testlar ro‘yxatini yangilash</button>
      <div className="future-links"><span>Fanlar <small>Tez kunda</small></span><span>Yo‘l xaritasi <small>Tez kunda</small></span><span>Videodarslar <small>Tez kunda</small></span></div>
    </>}

    {s.screen === 'instructions' && <section className="card">
      <span className="pill green">{s.exam?.group}</span><h2>{s.exam?.title}</h2>
      <p>{s.exam?.startNotice}</p><ul className="instructions">
        <li>{s.exam?.count} ta savol, {s.exam?.durationLabel}.</li><li>Vaqt boshlash tasdig‘idan keyin yuradi. Pauza yo‘q.</li>
        <li>Savollar orasida erkin o‘tishingiz va javobni o‘zgartirishingiz mumkin.</li>
        <li>Faqat tasdiqlangan javoblar saqlangan hisoblanadi.</li>
      </ul><button className="primary" disabled={s.busy || !s.exam?.canStart} onClick={() => setConfirmation('start')}>Boshlash</button>
      <button className="text-button" disabled={s.busy} onClick={() => void flow.showExams()}>Testlarimga qaytish</button>
    </section>}

    {s.screen === 'attempt' && a && <>
      <section className="exam-bar" aria-label="Test va vaqt"><div className="exam-clock">
        <h1 ref={focusTarget} tabIndex={-1}>{s.exam?.title || title}</h1>
        <strong className={seconds <= 60 ? 'urgent' : ''} role="timer" aria-label="Qolgan vaqt">
          {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</strong></div>
        <button type="button" className="answer-progress" aria-haspopup="dialog" aria-controls="exam-dialog"
          aria-expanded={confirmation === 'questions'}
          aria-label={`Savollarni ochish: ${answered} ta javob belgilangan, jami ${a.questions.length} ta savol. Joriy savol ${questionIndex + 1}`}
          onClick={() => setConfirmation('questions')}>
          <span className="progress-track" aria-hidden="true"><span className="progress-fill"
            style={{ width: `${a.questions.length ? answered / a.questions.length * 100 : 0}%` }} /></span>
        </button></section>
      {seconds === 0 && a.active && <div className="notice" role="status">Ko‘rsatilgan vaqt tugadi. Yakuniy holatni tekshiring.</div>}
      {q && <section className="card question"><div className="card-top"><p className="eyebrow">Savol {questionIndex + 1} / {a.questions.length}</p>
        <span className="save-state" aria-live="polite">{pending ? (s.busy ? 'Saqlanmoqda…' : 'Tasdiqlanmagan') : confirmedOption ? '✓ Tasdiqlangan' : 'Javob tanlanmagan'}</span></div>
        <fieldset disabled={locked}><legend>{q.prompt}</legend><div className="options">{q.options.map((option, i) => <label className={`option ${selectedOption === option.id ? 'selected' : ''}`} key={option.id}>
          <input type="radio" name={q.id} checked={selectedOption === option.id} onChange={() => void flow.choose(q.id, option.id)} />
          <span className="letter" aria-hidden="true">{letters[i]}</span><span>{option.text}</span></label>)}</div></fieldset>
        <button className="text-button clear" disabled={locked || !confirmedOption} onClick={() => void flow.choose(q.id, null)}>Tanlovni tozalash</button>
      </section>}
      {s.draft && !s.needsRead && !s.busy && <section className="notice"><p>Saqlanmagan tanlov {a.questions.findIndex(v => v.id === s.draft!.questionId) + 1}-savolga tegishli.</p>
        <button className="secondary" disabled={seconds === 0} onClick={() => void flow.choose(s.draft!.questionId, s.draft!.optionId, true)}>Mening tanlovimni saqlash</button>
        <button className="text-button" onClick={() => flow.keepSaved()}>Saqlangan javobni qoldirish</button></section>}
      <div className="question-actions"><button className="secondary" disabled={questionIndex === 0} onClick={() => setQuestionIndex(i => i - 1)}>← Oldingi</button>
        <button className="secondary" disabled={questionIndex >= a.questions.length - 1} onClick={() => setQuestionIndex(i => i + 1)}>Keyingi →</button></div>
      <div className="finish-actions"><button className="text-button" disabled={s.busy} onClick={() => void flow.reconcile()}>Saqlanganlarni tekshirish</button>
        <button className="primary" disabled={s.busy || s.needsRead || !!s.draft || seconds === 0} onClick={() => setConfirmation('submit')}>{flow.submitKey ? 'Topshirishni qayta tekshirish' : 'Testni topshirish'}</button></div>
    </>}

    {s.screen === 'lifecycle' && a && <section className="card">
      <span className="pill green">{a.statusLabel}</span><h2>{s.exam?.title}</h2>
      <p>{a.status === 'ready' ? 'Ruxsatli yangi urinish hali boshlanmagan. Vaqt boshlash tasdig‘idan keyin yuradi.' :
        a.status === 'cancelled' ? 'Bu urinish bekor qilingan. Eski tanlovlar yangi urinishga ko‘chirilmaydi. Tarixni ko‘rishingiz mumkin.' :
        a.status === 'recovery_lapsed' ? 'Qayta urinishga kirish oynasi tugagan. Yangi ruxsatni o‘qituvchi yoki administrator bilan aniqlashtiring.' :
        'Yakunlangan urinish natijasini qayta tekshiring. Natija yo‘qligi nol ball degani emas.'}</p>
      {a.status === 'ready' && <button className="primary" disabled={s.busy || !s.exam?.canStart} onClick={() => setConfirmation('start')}>Boshlash</button>}
      <button className="text-button" disabled={s.busy} onClick={() => void flow.reconcile()}>Saqlanganlarni tekshirish</button>
      <button className="text-button" disabled={s.busy} onClick={() => void flow.showHistory()}>Urinishlar tarixi →</button>
      <button className="text-button" disabled={s.busy} onClick={() => void flow.showExams()}>Testlarimga qaytish</button>
    </section>}

    {s.screen === 'result' && s.result && <section className="card result">
      <div className="result-mark" aria-hidden="true">✓</div><span className="pill green">{a?.statusLabel}</span><h2>Oddiy natija</h2>
      <p className="score">{localizeServerDisplay(s.result.earned, ',')}<span> / {localizeServerDisplay(s.result.maximum, ',')}</span></p><p className="percentage">{localizeServerDisplay(s.result.percentage, ',')}%</p>
      <p className="sample-result">{s.result.note}</p>
      {s.result.bonus !== null && <p>Statistik bonus: {localizeServerDisplay(s.result.bonus, ',')}</p>}
      <div className="review-note"><strong>Batafsil tahlil</strong><p>{s.result.reviewMessage}</p></div>
      <button className="primary" disabled={s.busy} onClick={() => void flow.showExams()}>Testlarimga qaytish</button>
      <button className="text-button" disabled={s.busy} onClick={() => void flow.showHistory()}>Urinishlar tarixi →</button>
    </section>}

    {s.screen === 'history' && <section className="card"><h2>O‘z urinishlaringiz</h2><p>{s.exam?.title}</p>
      {s.history.length ? s.history.map((entry, i) => <article className="history-entry" key={i}><strong>{entry.title}</strong><span>{entry.status}</span><p>{entry.result ? historySummary(entry.result, !!entry.official, ',') : entry.summary}</p></article>) : <p>Hali urinish yo‘q.</p>}
      <button className="text-button" disabled={s.busy} onClick={() => void flow.showExams()}>← Testlarimga qaytish</button></section>}

    {!testing && <footer><span>UniverAcademy</span><span>Har bir qadam — oldinga.</span></footer>}
    {demoControls}

    <dialog id="exam-dialog" ref={dialog} onCancel={() => setConfirmation(null)} onClose={() => setConfirmation(null)}
      aria-labelledby={confirmation === 'questions' ? 'questions-title' : 'confirm-title'}>
      {confirmation === 'questions' ? <>
        <div className="dialog-heading"><h2 id="questions-title">Savollar</h2>
          <button type="button" className="close-dialog" aria-label="Savollar oynasini yopish" onClick={() => setConfirmation(null)}>×</button></div>
        <p className="question-key"><span><i className="key-unanswered" aria-hidden="true" />Javobsiz</span>
          <span><i className="key-answered" aria-hidden="true" />Belgilangan</span><span><i className="key-current" aria-hidden="true" />Joriy</span></p>
        <nav className="question-nav" aria-label="Savollar">{a?.questions.map((question, i) => <button type="button" key={question.id}
          aria-current={i === questionIndex ? 'step' : undefined}
          aria-label={`${i + 1}-savol${a.answers[question.id]?.optionId != null ? ', javob tasdiqlangan' : ', javobsiz'}${i === questionIndex ? ', joriy' : ''}`}
          className={a.answers[question.id]?.optionId != null ? 'answered' : 'unanswered'}
          onClick={() => { setQuestionIndex(i); setConfirmation(null); }}>{i + 1}</button>)}</nav>
      </> : <><h2 id="confirm-title">{confirmation === 'start' ? 'Testni boshlaysizmi?' : 'Testni topshirasizmi?'}</h2>
      <p>{confirmation === 'start' ? `Tasdiqlasangiz, ${s.exam?.durationLabel} vaqt boshlanadi.` : `${answered} ta javob tasdiqlangan. ${(a?.questions.length ?? 0) - answered} ta savol javobsiz.`}</p>
      <div className="dialog-actions"><button className="secondary" onClick={() => setConfirmation(null)}>Ortga</button>
        <button className="primary" onClick={() => { const action = confirmation; setConfirmation(null); void (action === 'start' ? flow.start() : flow.submit()); }}>Ha, {confirmation === 'start' ? 'boshlash' : 'topshirish'}</button></div></>}
    </dialog>
  </main>;
}
