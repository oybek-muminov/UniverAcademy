import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';

const {JSDOM} = createRequire(new URL('../teacher-local-pilot/tooling/package.json', import.meta.url))('jsdom');
const {build} = createRequire(new URL('../../apps/teacher-web/ustoz-pages/package.json', import.meta.url))('esbuild');
const appDirectory = fileURLToPath(new URL('../../apps/mini-app/', import.meta.url));

test('staff handoff opens the selected public HTTPS route by itself once, keeps the tap fallback and the Mini App in place', async () => {
  const artifact = await build({
    stdin:{contents:`
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {createElement} from 'react';
      import {StaffBrowserEntry, StaffBrowserChoices} from './src/staff-browser-entry.tsx';
      const root = createRoot(document.querySelector('main'));
      window.show = role => flushSync(() => root.render(role ? createElement(StaffBrowserEntry, {role}) : createElement(StaffBrowserChoices)));
    `,resolveDir:appDirectory},tsconfig:appDirectory+'tsconfig.json',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}
  });
  const dom = new JSDOM('<main></main>',{url:'https://mini.univeracademy.uz/?invite=private#test',runScripts:'outside-only'});
  try {
    const {window} = dom;
    const launched = [];
    window.Telegram = {WebApp:{platform:'android',initData:'private',openLink(url){launched.push(url);}}};
    window.eval(artifact.outputFiles[0].text);
    const destinations = {teacher:'https://ustoz.univeracademy.uz/',admin:'https://ustoz.univeracademy.uz/admin',owner:'https://ustoz.univeracademy.uz/owner'};
    for (const [role,url] of Object.entries(destinations)) {
      const previous = launched.length;
      window.show(role);
      await pause(0);
      assert.deepEqual(launched.slice(previous),[url]);
      assert.match(window.document.querySelector('[role="status"]').textContent,/brauzerda ochilmoqda/);
      const link = window.document.querySelector('a');
      assert.equal(link.href,url);
      link.click();
      assert.deepEqual(launched.slice(previous),[url,url]);
      window.show(null);
      window.show(role);
      await pause(0);
      assert.deepEqual(launched.slice(previous),[url,url]);
    }
    window.show(null);
    const links = [...window.document.querySelectorAll('details a')];
    assert.deepEqual(links.map(a=>a.href).sort(),Object.values(destinations).sort());
    for (const link of links) {
      assert.equal(link.target, '_blank');
      assert.equal(link.getAttribute('referrerpolicy'), 'no-referrer');
    }
    const fallback = links[0];
    const defaults = [];
    window.document.addEventListener('click', event => { defaults.push(event.defaultPrevented); event.preventDefault(); });
    window.Telegram.WebApp.openLink = () => {throw Error('Unavailable');};
    fallback.click();
    delete window.Telegram.WebApp.openLink;
    fallback.click();
    assert.deepEqual(defaults,[false,false]);
    assert.equal(window.location.origin,'https://mini.univeracademy.uz');
  } finally { dom.window.close(); }
});

test('the actual Mini menu route launches staff without loading the sign-in stack or sending an API request', async () => {
  const artifact = await build({
    entryPoints:[appDirectory+'src/main.tsx'], tsconfig:appDirectory+'tsconfig.json',bundle:true,write:false,
    splitting:true, format:'esm',outdir:'virtual',loader:{'.css':'empty'},metafile:true,
    define:{'import.meta.env':JSON.stringify({DEV:false,MODE:'production',VITE_AUTH_ENTRY:'common'}),'__AUTH_PROTOTYPE_PREVIEW__':'false','process.env.NODE_ENV':'"production"'}
  });
  const routes = Object.entries(artifact.metafile.outputs);
  const handoff = routes.find(([,info])=>info.entryPoint?.endsWith('/staff-menu-handoff.ts'));
  const main = routes.find(([,info])=>info.entryPoint?.endsWith('/main.tsx'));
  assert.ok(main && handoff);
  function eagerInputs(filename, visited=new Set()) {
    if (visited.has(filename)) return [];
    visited.add(filename);
    const file=artifact.metafile.outputs[filename];
    return [...Object.keys(file.inputs),...file.imports.filter(dep=>dep.kind==='import-statement').flatMap(dep=>eagerInputs(dep.path,visited))];
  }
  assert.doesNotMatch([...eagerInputs(main[0]),...eagerInputs(handoff[0])].join('\n'), /node_modules\/(?:@clerk|react)|owner-port|common-production|telegram-atomic/);
  const app = await build({
    entryPoints:[appDirectory+'src/main.tsx'],tsconfig:appDirectory+'tsconfig.json',bundle:true,write:false,format:'iife',loader:{'.css':'empty'},
    define:{'import.meta.env':JSON.stringify({DEV:false,MODE:'production',VITE_AUTH_ENTRY:'common'}),'__AUTH_PROTOTYPE_PREVIEW__':'false','process.env.NODE_ENV':'"production"'}
  });
  for (const role of ['teacher','admin','owner','unknown']) {
    const dom=new JSDOM('<div id="root"><main><section><h1></h1><p role="status"></p></section></main></div>',{
      url:'https://mini.univeracademy.uz/open-staff/'+role+'?next=https://other.example',runScripts:'outside-only'});
    try {
      const {window}=dom;
      const opened=[],requests=[];
      window.Telegram={WebApp:{platform:'android',openLink:url=>opened.push(url)}};
      window.fetch=(req)=>{requests.push(req);throw Error('Unexpected API call');};
      window.eval(app.outputFiles[0].text);
      await pause(5);
      const link=window.document.querySelector('a');
      if (role === 'unknown') {
        assert.equal(link,null);
        assert.match(window.document.body.textContent,/topilmadi/);
      } else {
        const destination='https://ustoz.univeracademy.uz/'+(role==='teacher'?'':role);
        assert.deepEqual(opened,[destination]);
        assert.match(window.document.querySelector('[role="status"]').textContent,/brauzerda ochilmoqda/);
        link.click();
        assert.deepEqual(opened,[destination,destination]);
        assert.equal(window.document.querySelector('a.cabinet-recheck').pathname,'/');
      }
      assert.equal(requests.length,0);
    } finally { dom.window.close(); }
  }
});

test('automatic staff launch falls back to the visible link when the bridge cannot open it, and never runs outside Telegram', async () => {
  const artifact = await build({
    stdin:{contents:`
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {createElement} from 'react';
      import {StaffBrowserEntry} from './src/staff-browser-entry.tsx';
      const root = createRoot(document.querySelector('main'));
      window.show = role => flushSync(() => root.render(role ? createElement(StaffBrowserEntry, {role}) : null));
    `,resolveDir:appDirectory},tsconfig:appDirectory+'tsconfig.json',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}
  });
  const failing = new JSDOM('<main></main>',{url:'https://mini.univeracademy.uz/',runScripts:'outside-only'});
  try {
    const {window} = failing;
    let attempts = 0;
    window.Telegram = {WebApp:{platform:'android',initData:'private',openLink(){attempts++;throw Error('Unavailable');}}};
    window.eval(artifact.outputFiles[0].text);
    window.show('teacher');
    await pause(0);
    assert.equal(attempts,1);
    assert.equal(window.document.querySelector('[role="status"]'),null);
    assert.equal(window.document.querySelector('a.cabinet-browser-button').href,'https://ustoz.univeracademy.uz/');
    window.show(null);
    window.show('teacher');
    await pause(0);
    assert.equal(attempts,1);
  } finally { failing.window.close(); }
  const plain = new JSDOM('<main></main>',{url:'https://mini.univeracademy.uz/',runScripts:'outside-only'});
  try {
    const {window} = plain;
    let launched = 0;
    window.Telegram = {WebApp:{platform:'unknown',initData:'',openLink(){launched++;}}};
    window.eval(artifact.outputFiles[0].text);
    window.show('owner');
    await pause(0);
    assert.equal(launched,0);
  } finally { plain.window.close(); }
});
