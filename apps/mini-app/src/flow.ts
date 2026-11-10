import { asFailure, createOperationJournal, failureMessage, StudentFailure } from './transport.ts';
import type { SignInMethod } from './transport.ts';

// UI projections only; actual wire schemas/client remain Backend-owned.
export type Lifecycle = 'ready' | 'in_progress' | 'submitted' | 'expired' | 'forced' | 'cancelled' | 'recovery_lapsed';
export const lifecycleLabel: Record<Lifecycle, string> = {
  ready: 'Qayta urinish tayyor', in_progress: 'Davom etmoqda', submitted: 'Topshirilgan',
  expired: 'Vaqti tugagan', forced: 'Majburiy yakunlangan', cancelled: 'Bekor qilingan', recovery_lapsed: 'Qayta urinish oynasi tugagan',
};
export type Student = { person: string; firstName: string; lastName: string; displayId: string; registrationComplete: boolean };
export type DisplayBlock = { kind: 'text'; text: string } | { kind: 'formula'; latex: string; display: 'inline' | 'block' } |
  { kind: 'image'; assetId: string; url: string; expiresAt: string; contentType: string; alt: string; caption: string | null };
export type SeriesView = { currentAttemptId: string | null; generation: number; officialResultAttemptId: string | null; recovery: 'none' | 'ready' | 'active' | 'lapsed' };
export type Exam = { id: string; title: string; group: string; count: number; durationLabel: string; startNotice: string; canStart: boolean; instructionsContent?: DisplayBlock[]; series?: SeriesView };
export type Question = { id: string; prompt: string; content?: DisplayBlock[]; options: { id: string; text: string; content?: DisplayBlock[] }[] };
export type SavedAnswer = { optionId: string | null; revision: number };
export type Attempt = {
  id: string; assignmentId: string; generation: number; status: Lifecycle; active: boolean; statusLabel: string;
  serverTime: string; deadline: string | null; questions: Question[]; answers: Record<string, SavedAnswer>;
  series?: SeriesView;
};
// Canonical server strings: student points1dp, percentage2dp; localize lexically.
export type Result = { earned: string; maximum: string; percentage: string; bonus: string | null; reviewMessage: string; note: string };
export type HistoryEntry = { title: string; status: string; summary: string; attemptId?: string | null; official?: boolean; result?: Result | null };
export type Draft = { questionId: string; optionId: string | null };
export type SaveIntent = Draft & { attemptId: string; assignmentId: string; generation: number; expectedRevision: number };
export type StudentPort = {
  profile(): Promise<Student | null>;
  register(firstName: string, lastName: string): Promise<Student>;
  exams(): Promise<Exam[]>;
  current(assignmentId: string): Promise<Attempt | null>;
  start(assignmentId: string, operationKey: string): Promise<Attempt>;
  save(intent: SaveIntent): Promise<SavedAnswer>;
  submit(attemptId: string, generation: number, operationKey: string): Promise<void>;
  result(assignmentId: string, attemptId: string): Promise<Result | null>;
  history(assignmentId: string): Promise<HistoryEntry[]>;
};
type Screen = 'welcome' | 'profile' | 'exams' | 'instructions' | 'attempt' | 'lifecycle' | 'result' | 'history';
type State = {
  screen: Screen; busy: boolean; notice: string; failure: StudentFailure | null; retryAt: number;
  student: Student | null; exams: Exam[]; exam: Exam | null; attempt: Attempt | null;
  draft: Draft | null; needsRead: boolean; result: Result | null; history: HistoryEntry[]; clockAnchor: number;
};
export class StudentFlow {
  port: StudentPort;
  now: () => number;
  journal: ReturnType<typeof createOperationJournal>;
  signInMethod: SignInMethod;
  state: State;
  listeners = new Set<() => void>();
  startKey: string | null = null;
  submitKey: string | null = null;
  constructor(port: StudentPort, now = () => performance.now(), journal = createOperationJournal(), signInMethod: SignInMethod = 'telegram') {
    this.port = port; this.now = now; this.journal = journal; this.signInMethod = signInMethod;
    this.state = { screen: 'welcome', busy: false, notice: '', failure: null, retryAt: 0, student: null, exams: [],
      exam: null, attempt: null, draft: null, needsRead: false, result: null, history: [], clockAnchor: now() };
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.state;
  patch(change: Partial<State>) { this.state = { ...this.state, ...change }; this.listeners.forEach(fn => fn()); }
  scope(action: 'start' | 'submit', attempt = this.state.attempt) {
    if (!this.state.student || !this.state.exam) throw new StudentFailure('auth', 'FRESH_LAUNCH_REQUIRED');
    return JSON.stringify([this.state.student.person, this.state.exam.id, action, action === 'submit' ? attempt?.id : '', attempt?.generation ?? 0]);
  }
  fail(error: unknown) {
    const failure = asFailure(error);
    this.patch({ failure, notice: failureMessage(failure, this.signInMethod), retryAt: failure.retryAfterMs === null ? 0 : this.now() + failure.retryAfterMs });
    if (failure.kind === 'auth' || failure.kind === 'forbidden' || failure.kind === 'missing') {
      // Conceal protected content after current auth/scope is lost. Keys remain scoped.
      this.patch({ attempt: null, draft: null, result: null, history: [], exams: [], exam: null, needsRead: true,
        screen: failure.kind === 'auth' ? 'welcome' : 'exams', ...(failure.kind === 'auth' ? { student: null } : {}) });
    }
  }
  async run(action: () => Promise<void>) {
    if (this.state.busy || this.now() < this.state.retryAt) return;
    this.patch({ busy: true, notice: '', failure: null });
    try { await action(); } catch (error) { this.fail(error); } finally { this.patch({ busy: false }); }
  }
  async enter() {
    await this.run(async () => {
      const student = await this.port.profile();
      this.patch({ student, attempt: null, draft: null, result: null, history: [],
        screen: student?.registrationComplete ? 'exams' : 'profile',
        exams: student?.registrationComplete ? await this.port.exams() : [] });
    });
  }
  async register(firstName: string, lastName: string) {
    if (!firstName.trim() || !lastName.trim()) return;
    await this.run(async () => {
      const student = await this.port.register(firstName.trim(), lastName.trim());
      this.patch({ student, exams: await this.port.exams(), screen: student.registrationComplete ? 'exams' : 'profile' });
    });
  }
  async openExam(exam: Exam) {
    await this.run(async () => {
      this.patch({ exam, attempt: null, result: null, draft: null, history: [] });
      this.startKey = null; this.submitKey = null;
      const attempt = await this.port.current(exam.id);
      if (attempt) await this.adopt(attempt);
      else this.patch({ screen: 'instructions', needsRead: false });
    });
  }
  async start() {
    if (this.state.busy || !this.state.exam?.canStart || (this.state.attempt && this.state.attempt.status !== 'ready')) return;
    await this.run(async () => {
      this.startKey = this.journal.key(this.scope('start'));
      await this.adopt(await this.port.start(this.state.exam!.id, this.startKey));
    });
  }
  remainingSeconds() {
    const a = this.state.attempt;
    if (a?.status !== 'in_progress' || !a.deadline) return 0;
    return Math.max(0, Math.ceil((Date.parse(a.deadline) - Date.parse(a.serverTime) - Math.max(0, this.now() - this.state.clockAnchor)) / 1000));
  }
  async adopt(attempt: Attempt) {
    if (attempt.assignmentId !== this.state.exam?.id || !Number.isFinite(Date.parse(attempt.serverTime)) ||
      (attempt.status === 'in_progress' && (!attempt.deadline || !Number.isFinite(Date.parse(attempt.deadline))))) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
    const previous = this.state.attempt;
    const changed = previous && (previous.id !== attempt.id || previous.generation !== attempt.generation);
    let draft = changed || attempt.status !== 'in_progress' ? null : this.state.draft;
    if (draft && (attempt.answers[draft.questionId]?.optionId ?? null) === draft.optionId) draft = null;
    if (changed) this.journal.clear(this.scope('submit', previous));
    this.submitKey = attempt.status === 'in_progress' ? this.journal.peek(this.scope('submit', attempt)) : null;
    if (attempt.status !== 'in_progress') this.journal.clear(this.scope('submit', attempt));
    const active = attempt.status === 'in_progress';
    this.patch({ attempt: { ...attempt, active, statusLabel: lifecycleLabel[attempt.status],
      questions: active ? attempt.questions : [], answers: active ? attempt.answers : {} },
      draft, needsRead: false, clockAnchor: this.now(), screen: active ? 'attempt' : 'lifecycle', result: null,
      notice: changed ? 'Urinish o‘zgargan. Oldingi saqlanmagan tanlov yangi urinishga ko‘chirilmaydi.' :
        draft ? 'Saqlangan javob va sizning tanlovingiz farq qiladi. Qaysi birini qoldirishni tanlang.' : '' });
    if (['submitted', 'expired', 'forced'].includes(attempt.status)) {
      const result = await this.port.result(attempt.assignmentId, attempt.id);
      if (result === null) throw new StudentFailure('protocol', 'RESPONSE_INVARIANT_FAILED');
      this.patch({ result, screen: 'result' });
    }
  }
  async reconcile() {
    if (this.state.busy || !this.state.exam) return;
    this.patch({ needsRead: true });
    await this.run(async () => {
      const attempt = await this.port.current(this.state.exam!.id);
      if (attempt) await this.adopt(attempt);
      else this.patch({ needsRead: true, notice: 'Urinish topilmadi. Testlar ro‘yxatini yangilang.' });
    });
  }
  async choose(questionId: string, optionId: string | null, resolve = false) {
    const a = this.state.attempt;
    // ponytail: one in-flight save; pending intent is bound to assignment/attempt/generation/question.
    if (a?.status !== 'in_progress' || this.state.busy || this.state.needsRead || this.submitKey ||
      (this.state.draft && !resolve) || this.remainingSeconds() <= 0) return;
    if (!a.questions.some(q => q.id === questionId && (optionId === null || q.options.some(o => o.id === optionId)))) return;
    this.patch({ draft: { questionId, optionId } });
    await this.run(async () => {
      try {
        const saved = await this.port.save({ questionId, optionId, assignmentId: a.assignmentId, attemptId: a.id,
          generation: a.generation, expectedRevision: a.answers[questionId]?.revision ?? 0 });
        if (this.state.attempt?.id !== a.id || this.state.attempt.generation !== a.generation) return;
        this.patch({ attempt: { ...a, answers: { ...a.answers, [questionId]: saved } }, draft: null });
      } catch (error) {
        this.patch({ needsRead: true }); this.fail(error);
        if (this.state.attempt) this.patch({ notice: this.state.notice + ' Tanlov hali tasdiqlanmagan; avval saqlangan javoblarni tekshiring.' });
      }
    });
  }
  keepSaved() { if (!this.state.busy && !this.state.needsRead) this.patch({ draft: null, notice: '' }); }
  async submit() {
    const a = this.state.attempt;
    if (this.state.busy || a?.status !== 'in_progress' || this.state.draft || this.state.needsRead || this.remainingSeconds() <= 0) return;
    await this.run(async () => {
      this.submitKey = this.journal.key(this.scope('submit'));
      await this.port.submit(a.id, a.generation, this.submitKey);
      const current = await this.port.current(a.assignmentId);
      if (current) await this.adopt(current);
      else this.patch({ needsRead: true, notice: 'Yakuniy holat tasdiqlanmadi. Avval qayta tekshiring.' });
    });
  }
  async showHistory(exam = this.state.exam) {
    if (!exam) return;
    await this.run(async () => { this.patch({ history: await this.port.history(exam.id), exam, screen: 'history' }); });
  }
  async showExams() { await this.run(async () => { this.patch({ exams: await this.port.exams(), screen: 'exams', attempt: null, draft: null, result: null, history: [] }); }); }
}
