export function secondsFromHours(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim().replace(',', '.');
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const hours = Number(value);
  const seconds = Math.round(hours * 3600);
  return hours <= 24 && seconds >= 1 ? seconds : null;
}

export function hoursFromSeconds(seconds) {
  // Six decimal places keep every whole-second duration intact on a round trip.
  return String(Number((seconds / 3600).toFixed(6)));
}

export function normalizeFileDuration(input) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'duration_hours')) return input;
  const {duration_hours, ...draft} = input;
  const seconds = secondsFromHours(typeof duration_hours === 'number' ? String(duration_hours) : duration_hours);
  if (Object.hasOwn(draft, 'duration_seconds') || seconds === null) {
    const detail = 'JSON faylida davomiylikni bitta birlikda kiriting. Masalan, "duration_hours": 0.5. Eng ko‘pi 24 soat.';
    throw Object.assign(new Error(detail), {code:'INVALID_TEST_FILE', status:422, detail});
  }
  return {...draft, duration_seconds:seconds};
}
