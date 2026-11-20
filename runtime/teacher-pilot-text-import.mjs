// Small, explicit file format for the first physics pilot. It produces a staff draft only.
import {secondsFromHours} from '../packages/test-content/duration.mjs';

const DEFAULT_DURATION = 300;
const labels = ['A', 'B', 'C', 'D'];
function invalid(line, reason) {
  throw Object.assign(new Error(reason), {
    status: 422, code: 'INVALID_TEXT_IMPORT', detail: line + '-qator. ' + reason,
  });
}

export function parseTeacherTestText(text) {
  if (typeof text !== 'string') invalid(1, 'UTF-8 matn yuboring.');
  const source = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const lines = source.map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter(row => row.value.length > 0);
  let cursor = 0;
  function take(pattern, note) {
    const row = lines[cursor];
    const match = row && pattern.exec(row.value);
    if (!match) invalid(row?.line ?? source.length, note);
    cursor += 1;
    return { row, value: match[1].trim() };
  }
  function answers(number) {
    if (/^[-*]/u.test(lines[cursor]?.value ?? '')) {
      const options = [];
      let correctIndex = -1;
      for (let i = 0; i < 4; i++) {
        const {row, value} = take(/^[-*]\s+(.+)$/u, number + '-savol uchun javobni «- matn» yoki «* matn» shaklida yozing.');
        if (row.value.startsWith('*')) {
          if (correctIndex !== -1) invalid(row.line, 'Faqat bitta to‘g‘ri javobni * bilan belgilang.');
          correctIndex = i;
        }
        options.push(value);
      }
      if (correctIndex === -1) invalid(lines[cursor - 1].line, 'To‘g‘ri javobni * bilan belgilang.');
      return {options, correctIndex};
    }
    const options = labels.map(label => take(new RegExp('^' + label + '[.)]\\s*(.+)$', 'iu'),
      number + '-savol uchun «' + label + ') …» varianti kutilgan.').value);
    const answer = take(/^Javob:\s*([ABCD])$/iu, number + '-savol oxirida «Javob: A», B, C yoki D yozing.');
    return {options, correctIndex:labels.indexOf(answer.value.toUpperCase())};
  }
  const title = take(/^Nomi:\s*(.+)$/iu, 'Test sarlavhasini «Nomi: …» shaklida yozing.').value;
  if (title.length > 160) invalid(lines[0].line, 'Sarlavhani 160 belgigacha qisqartiring.');
  let duration_seconds = DEFAULT_DURATION;
  if (/^Vaqt\b/iu.test(lines[cursor]?.value ?? '')) {
    const row = lines[cursor++];
    const hours = /^Vaqt\s*\(soat\):\s*(.+)$/iu.exec(row.value);
    const legacy = /^Vaqt\s*\(soniya\):\s*(\d+)$/iu.exec(row.value);
    duration_seconds = hours ? secondsFromHours(hours[1]) : legacy ? Number(legacy[1]) : null;
    if (!Number.isSafeInteger(duration_seconds) || duration_seconds < 1 || duration_seconds > 86400)
      invalid(row.line, 'Davomiylikni 24 soatgacha kiriting. Masalan, «Vaqt (soat): 0,5».');
  }
  const questions = [];
  while (cursor < lines.length) {
    const number = questions.length + 1;
    const row = lines[cursor];
    const question = /^(\d+)[.)]\s*(.+)$/u.exec(row.value);
    if (!question || Number(question[1]) !== number) invalid(row.line, 'Navbatdagi savolni «' + number + '. …» shaklida yozing.');
    cursor += 1;
    questions.push({ text:question[2].trim(), ...answers(number) });
  }
  if (!questions.length) invalid(source.length, 'Sarlavhadan so‘ng kamida bitta savol kiriting.');
  return { title, duration_seconds, questions };
}
