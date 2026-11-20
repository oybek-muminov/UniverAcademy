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
    status.textContent = dashboard.groups.length ? '' : 'Hozircha guruh yo‘q.';
    for (const group of dashboard.groups) {
      const article = document.createElement('article'), title = document.createElement('h2');
      const teacher = document.createElement('p');
      title.textContent = group.name;
      teacher.textContent = group.teacherName;
      article.append(title, teacher);
      list.append(article);
    }
  } catch (error) { status.textContent = 'Guruhlarni olishda xato: ' + error.message; }
}
document.querySelector('#reload').addEventListener('click', refresh);
refresh();
