const status = document.querySelector('#notice'), list = document.querySelector('#requests');
const headers = { 'Content-Type':'application/json' };
async function request(path, options) {
  const response = await fetch('/local-pilot/admin/' + path, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error?.code ?? 'SERVER_ERROR'), { status:response.status });
  return body.data;
}
async function refresh() {
  try {
    let dashboard;
    try { dashboard = await request('dashboard'); }
    catch (error) {
      if (error.status !== 401) throw error;
      await request('session', { method:'POST', headers, body:JSON.stringify({ actor:'admin' }) });
      dashboard = await request('dashboard');
    }
    list.replaceChildren();
    const pending = dashboard.groups.filter(group => group.status === 'pending');
    status.textContent = pending.length ? 'Tasdiq kutayotgan guruhlar: ' + pending.length : 'Tasdiq kutayotgan guruh yo‘q.';
    for (const group of pending) {
      const article = document.createElement('article'), title = document.createElement('h2');
      title.textContent = group.name;
      const button = document.createElement('button');
      button.textContent = 'Guruhni tasdiqlash';
      const idempotencyKey = crypto.randomUUID();
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await request('commands/approveGroup', { method:'POST', headers:{ ...headers, 'Idempotency-Key':idempotencyKey }, body:JSON.stringify({ groupId:group.id }) });
          await refresh();
          status.textContent = group.name + ' guruhi tasdiqlandi.';
        } catch (error) { button.disabled = false; status.textContent = 'Tasdiqlash bajarilmadi: ' + error.message; }
      });
      article.append(title, button);
      list.append(article);
    }
  } catch (error) { status.textContent = 'Guruhlarni olishda xato: ' + error.message; }
}
document.querySelector('#reload').addEventListener('click', refresh);
refresh();
