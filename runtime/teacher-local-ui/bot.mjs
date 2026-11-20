const start = document.querySelector('#start');
const message = document.querySelector('#message');
const link = document.querySelector('#student');
const token = new URL(location.href).searchParams.get('start');
if (!token) { start.disabled = true; message.textContent = 'O‘qituvchi yaratgan taklif havolasini oching.'; }
start.addEventListener('click', async () => {
  start.disabled = true;
  try {
    const response = await fetch('/local-pilot/bot/start', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ command:'/start ' + token }) });
    const body = await response.json();
    if (!response.ok) throw Error();
    const dest = new URL(body.data.studentPath, location.origin);
    if (dest.origin !== location.origin || dest.pathname !== '/student/') throw Error();
    message.textContent = body.data.text;
    link.href = dest.href;
    link.hidden = false;
  } catch {
    message.textContent = 'Taklif ochilmadi. O‘qituvchidan havolani tekshirishni so‘rang.';
    start.disabled = false;
  }
});
