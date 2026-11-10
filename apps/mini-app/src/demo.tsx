import { createDemoPort } from './demo-port.ts';
import type { DemoFault } from './demo-port.ts';
import { lifecycleLabel, StudentFlow } from './flow.ts';
import type { Lifecycle } from './flow.ts';
import { StudentApp } from './student-app.tsx';

const demo = createDemoPort();
const demoFlow = new StudentFlow(demo.port);

export function DemoApp({ studentFlow = demoFlow, localHttp = false, onEnter, onLogout }: {
  studentFlow?: StudentFlow; localHttp?: boolean; onEnter?: () => Promise<void>; onLogout?: () => Promise<void>;
} = {}) {
  const flow = studentFlow;
  return <StudentApp studentFlow={flow} mode={localHttp ? 'local_fixture' : 'demo'}
    onEnter={onEnter} onLogout={onLogout} demoControls={!localHttp && (
<details className="demo-tools"><summary>Namuna holatlarini sinash</summary><p>Faqat lokal namuna uchun. Keyingi amalga ta’sir qiladi.</p>
      <label htmlFor="demo-fault">Sinov holati</label><select id="demo-fault" onChange={e => demo.setFault(e.target.value as DemoFault)}>
        <option value="none">Oddiy oqim</option><option value="offline">Aloqa yo‘q</option>
        <option value="conflict">Javob boshqa qurilmada o‘zgargan</option><option value="lost-save">Javob saqlangan, tasdiq kelmagan</option>
        <option value="recovery">Yangi bo‘sh urinish ochilgan</option><option value="lost-submit">Topshirilgan, tasdiq kelmagan</option>
        <option value="short-timer">Yangi test uchun 3 soniyalik vaqt</option>
        <option value="auth">401 — sessiyani yangidan ochish</option><option value="forbidden">403 — ruxsat yo‘q</option>
        <option value="missing">404 — ochilmadi</option><option value="invalid">422 — tanlov qabul qilinmadi</option>
        <option value="limited">429 — vaqtinchalik cheklov</option><option value="temporary">503 — vaqtinchalik xizmat xatosi</option>
      </select><label htmlFor="demo-lifecycle">Urinish holati (namuna)</label><select id="demo-lifecycle" defaultValue="in_progress"
        onChange={e => { demo.setLifecycle(e.target.value as Lifecycle); void flow.reconcile(); }}>
        {Object.entries(lifecycleLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></details>
    )} />;
}
