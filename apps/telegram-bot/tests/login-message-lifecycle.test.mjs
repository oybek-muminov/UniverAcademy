import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginMessageLifecycle } from '../src/login-message-lifecycle.mjs';
import { createTelegramDelivery } from '../src/telegram-delivery.mjs';
function harness() {
  let time = 1000000, data, alarm, status = 'needs_clerk', failLookup = false, failDelete;
  const calls = []; let id = 100;
  const storage = { get: async () => structuredClone(data), put: async (_, s) => { data = structuredClone(s); },
    setAlarm: async n => { alarm = n; }, deleteAlarm: async () => { alarm = undefined; },
    transaction: async fn => fn(storage) };
  const env = { LOGIN_MESSAGE_TTL_SECONDS: '60', MINI_CABINET_URL: 'https://mini.univeracademy.uz/',
    MINI_SIGN_IN_URL: 'https://mini.univeracademy.uz/sign-in', TELEGRAM_START_LOOKUP: {
      lookupTelegramStart: async () => { if (failLookup) throw Error(); return { status }; } } };
  const deliver = async (method, body) => { calls.push({ method, body });
    if (method === 'deleteMessage' && failDelete) return failDelete;
    return { kind: 'ok', result: method === 'sendMessage' ? { message_id: id++, chat: { id: body.chat_id } } : true }; };
  const engine = new LoginMessageLifecycle(storage, env, deliver, () => time);
  return { engine, calls, env, storage, deliver, state: () => data, alarm: () => alarm,
    setStatus: s => { status = s; }, failLookup: () => { failLookup = true; },
    failDelete: r => { failDelete = r; }, advance: n => { time += n; } };
}
const context = { telegram_user_id: 42, update_id: 1 };
test('abandoned entry deletes message at expiry without cabinet', async () => {
  const h = harness(); await h.engine.start(context); h.advance(60000); await h.engine.drain();
  assert.ok(h.calls.some(c => c.method === 'deleteMessage' && c.body.message_id === 100));
  assert.equal(h.state().receipts.length, 0);
});
test('private menu reconciles the current staff handoff and falls back to the ordinary Mini on revocation or hint failure', async () => {
  const h = harness();
  let role='teacher', reads=0;
  h.setStatus('linked');
  h.env.TELEGRAM_TEACHER_PILOT_ENABLED='true';
  h.env.TELEGRAM_PILOT_DIRECTORY={async readStaffCabinet(input) {
    assert.deepEqual(input,{telegramUserId:context.telegram_user_id}); reads++;
    if (role==='unavailable') throw Error('SERVICE_UNAVAILABLE');
    return role;
  }};
  const lastMenu=()=>h.calls.filter(c=>c.method==='setChatMenuButton').at(-1)?.body.menu_button;
  await h.engine.start(context);
  assert.equal(lastMenu().web_app.url,h.env.MINI_CABINET_URL+'open-staff/teacher');
  for (const hint of ['admin','owner',null,'unavailable']) {
    role=hint; await h.engine.reconcile();
    const path = hint==='admin'||hint==='owner' ? 'open-staff/'+hint : '';
    assert.deepEqual(lastMenu(),{type:'web_app',text:'Kabinet',web_app:{url:h.env.MINI_CABINET_URL+path}});
  }
  assert.equal(reads,6); // The first /start reads the role twice: once for the button message, once for the menu.
  h.setStatus('disabled'); await h.engine.reconcile();
  assert.deepEqual(lastMenu(),{type:'commands'});
  assert.equal(reads,6);
  assert.equal(h.calls.filter(c=>c.method==='sendMessage').length,1); // Only the first /start sends the browser button.
});
test('expiry cleanup works even when database lookup fails', async () => {
  const h = harness(); await h.engine.start(context); h.advance(60000); h.failLookup(); await h.engine.drain();
  assert.equal(h.state().receipts.length, 0);
});
test('registration gets menu and deletes login message on next reconciliation', async () => {
  const h = harness(); await h.engine.start(context); h.setStatus('linked'); h.advance(30000); await h.engine.drain();
  assert.ok(h.calls.some(c => c.body.menu_button?.type === 'web_app'));
  assert.equal(h.state().receipts.length, 0);
});
test('new start supersedes old message, never deletes new message early', async () => {
  const h = harness(); await h.engine.start(context); await h.engine.start({ ...context, update_id: 2 });
  assert.deepEqual(h.calls.filter(c => c.method === 'deleteMessage').map(c => c.body.message_id), [100]);
  assert.equal(h.state().receipts[0].id, 101);
});
test('duplicate update does not resend', async () => {
  const h = harness(); await h.engine.start(context); await h.engine.start(context);
  assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 1);
});
test('delete retry_after persists targeted receipt and alarm', async () => {
  const h = harness(); await h.engine.start(context); h.advance(60000);
  h.failDelete({ kind: 'retry', delay: 90000 }); await h.engine.drain();
  assert.equal(h.state().receipts[0].next, 1150000);
  assert.ok(h.alarm()); h.failDelete(undefined); h.advance(90000); await h.engine.drain();
  assert.equal(h.state().receipts.length, 0);
});
test('unknown send is recorded and not retried blindly', async () => {
  const h = harness(); const engine = new LoginMessageLifecycle(h.storage, h.env,
    async (m,b) => m === 'sendMessage' ? {kind:'unknown'} : h.deliver(m,b), () => 1000000);
  await engine.start(context); assert.equal(h.state().lastSend, 'unconfirmed');
  await engine.start(context); assert.equal(h.state().receipts.length, 0);
});
test('restored engine can clean receipt after eviction', async () => {
  const h = harness(); await h.engine.start(context);
  const restored = new LoginMessageLifecycle(h.storage, h.env, h.deliver, () => 1060000);
  await restored.drain(); assert.equal(h.state().receipts.length, 0);
});
test('deletion too old uses empty markup fallback on next retry', async () => {
  const h = harness(); await h.engine.start(context); h.advance(60000);
  h.failDelete({kind:'not_deletable'}); await h.engine.drain(); h.advance(60000); await h.engine.drain();
  assert.ok(h.calls.some(c => c.method === 'editMessageReplyMarkup'));
});
test('API adapter sanitizes network failures and honors Telegram backoff', async () => {
  const send = createTelegramDelivery('123:abcdefghijklmnopqrstuvwxyz', async () => new Response(JSON.stringify({
    ok:false,error_code:429,parameters:{retry_after:20}}), {status:429}));
  assert.deepEqual(await send('deleteMessage', {}), {kind:'retry',delay:20000});
  const failed = createTelegramDelivery('123:abcdefghijklmnopqrstuvwxyz', async () => { throw Error('secret'); });
  assert.deepEqual(await failed('deleteMessage', {}), {kind:'unknown'});
});
test('transport uses Workers-compatible manual redirects and never follows 3xx', async () => {
  let calls=0;
  const send=createTelegramDelivery('123:abcdefghijklmnopqrstuvwxyz',async (_,options)=>{
    calls++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://elsewhere.example'}});
  });
  assert.deepEqual(await send('sendMessage',{}),{kind:'unknown'});assert.equal(calls,1);
});
test('429 send retry is durable, survives duplicate update and restart, and waits retry_after', async () => {
  const h=harness();let attempts=0;let time=1000000;
  const deliver=async(m,b)=>m==='sendMessage'&&++attempts===1?{kind:'retry',delay:90000}:h.deliver(m,b);
  let engine=new LoginMessageLifecycle(h.storage,h.env,deliver,()=>time);
  await engine.start(context);assert.equal(h.state().lastSend,'rate_limited');assert.equal(h.state().sendRetry.next,1090000);
  await engine.start(context);assert.equal(attempts,1);
  engine=new LoginMessageLifecycle(h.storage,h.env,deliver,()=>time);
  time=1089999;await engine.drain();assert.equal(attempts,1);
  time=1090000;await engine.drain();assert.equal(attempts,2);assert.equal(h.state().sendRetry,null);
  assert.equal(h.state().lastSend,'confirmed');assert.equal(h.state().receipts[0].expires,1150000);
  assert.ok(h.alarm());
});
test('new start replaces old queued send; old alarm cannot emit another login button', async () => {
  const h=harness();let attempts=0;let time=1000000;
  const engine=new LoginMessageLifecycle(h.storage,h.env,async(m,b)=>m==='sendMessage'&&++attempts===1?{kind:'retry',delay:90000}:h.deliver(m,b),()=>time);
  await engine.start(context);await engine.start({...context,update_id:2});
  assert.equal(attempts,1);assert.equal(h.state().sendRetry.next,1090000);
  time=1090000;await engine.drain();assert.equal(attempts,2);assert.equal(h.state().sendRetry,null);
});
test('registration while rate limited cancels queued sign-in rather than sending obsolete button', async () => {
  const h=harness();let sends=0;
  const engine=new LoginMessageLifecycle(h.storage,h.env,async(m,b)=>m==='sendMessage'?(sends++,{kind:'retry',delay:90000}):h.deliver(m,b),()=>1000000);
  await engine.start(context);h.setStatus('linked');await engine.reconcile();
  assert.equal(sends,1);assert.equal(h.state().sendRetry,null);assert.equal(h.state().lastSend,'not_needed');
});
test('unknown retry outcome clears retry intent so next alarm cannot duplicate', async () => {
  const h=harness();let sends=0;let time=1000000;
  const engine=new LoginMessageLifecycle(h.storage,h.env,async(m,b)=>m==='sendMessage'?(++sends===1?{kind:'retry',delay:1000}:{kind:'unknown'}):h.deliver(m,b),()=>time);
  await engine.start(context);time+=1000;await engine.drain();assert.equal(sends,2);
  assert.equal(h.state().sendRetry,null);assert.equal(h.state().lastSend,'unconfirmed');
  time+=60000;await engine.drain();assert.equal(sends,2);
});
test('definitive permanent send rejection is not confused with unknown and not blindly retried', async () => {
  const h=harness();let sends=0;
  const engine=new LoginMessageLifecycle(h.storage,h.env,async(m,b)=>m==='sendMessage'?(sends++,{kind:'blocked'}):h.deliver(m,b),()=>1000000);
  await engine.start(context);assert.equal(h.state().lastSend,'rejected');assert.equal(h.state().sendRetry,null);
  await engine.drain();assert.equal(sends,1);
});
test('long retry_after is never shortened; send ends safely beyond retry window', async () => {
  const send=createTelegramDelivery('123:abcdefghijklmnopqrstuvwxyz',async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:200000}},{status:429}));
  assert.equal((await send('sendMessage',{})).delay,200000000);
  const h=harness();const engine=new LoginMessageLifecycle(h.storage,h.env,async(m,b)=>m==='sendMessage'?{kind:'retry',delay:200000000}:h.deliver(m,b),()=>1000000);
  await engine.start(context);assert.equal(h.state().sendRetry,null);assert.equal(h.state().lastSend,'retry_window_exhausted');
});
test('delete retry_after survives repeated reconciliation and new start', async () => {
  const h=harness();await h.engine.start(context);h.advance(60000);
  h.failDelete({kind:'retry',delay:90000});await h.engine.drain();
  const count=()=>h.calls.filter(c=>c.method==='deleteMessage'&&c.body.message_id===100).length;
  assert.equal(count(),1);assert.equal(h.state().receipts[0].notBefore,1150000);
  await h.engine.reconcile();await h.engine.start({...context,update_id:2});
  assert.equal(count(),1);assert.equal(h.state().receipts.find(r=>r.id===100).next,1150000);
  h.advance(89999);await h.engine.reconcile();assert.equal(count(),1);
  h.advance(1);h.failDelete(undefined);await h.engine.reconcile();assert.equal(count(),2);
});
test('menu retry_after survives reconciliation and new start', async () => {
  const h=harness();let time=1000000, menus=0;
  const engine=new LoginMessageLifecycle(h.storage,h.env,async(m,b)=>{
    if(m==='setChatMenuButton'){menus++;if(menus===1)return {kind:'retry',delay:90000};}
    return h.deliver(m,b);
  },()=>time);
  await engine.start(context);assert.equal(menus,1);
  await engine.reconcile();await engine.start({...context,update_id:2});assert.equal(menus,1);
  assert.equal(h.state().menuNotBefore,1090000);assert.equal(h.state().menuDue,1090000);
  time=1089999;await engine.reconcile();assert.equal(menus,1);
  time=1090000;await engine.reconcile();assert.equal(menus,2);assert.equal(h.state().menuNotBefore,null);
});
test('diagnostics emit only fixed enums and cannot break persisted work', async () => {
  const h = harness(), events = [];
  h.engine.observe = event => { events.push(event); throw Error('observer failure'); };
  await h.engine.start(context);
  assert.equal(h.state().lastSend, 'confirmed');
  assert.ok(events.some(e => e.send === 'confirmed'));
  assert.ok(events.every(e => Object.keys(e).join(',') === 'event,send,menu,cleanup'));
  const state = h.state(); state.lastSend = 'secret-user-data'; state.menuFailure = 'secret'; state.cleanupFailure = 'secret';
  await h.engine.save(state);
  assert.deepEqual(events.at(-1), {event:'telegram_menu_lifecycle',send:'none',menu:'none',cleanup:'none'});
  assert.ok(!JSON.stringify(events).includes('secret'));
});

test('/start gives a linked teacher, admin or owner a direct browser button and leaves students and failed hints quiet', async () => {
  for (const [role, url] of [['teacher', 'https://ustoz.univeracademy.uz/'], ['admin', 'https://ustoz.univeracademy.uz/admin'], ['owner', 'https://ustoz.univeracademy.uz/owner']]) {
    const h = harness();
    h.setStatus('linked');
    h.env.TELEGRAM_TEACHER_PILOT_ENABLED = 'true';
    h.env.TELEGRAM_PILOT_DIRECTORY = { async readStaffCabinet() { return role; } };
    await h.engine.start(context);
    const sends = h.calls.filter(c => c.method === 'sendMessage');
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].body.reply_markup.inline_keyboard, [[{ text: 'Ustoz kabinetini ochish', url }]]);
    assert.equal(h.state().receipts.length, 1);
    h.advance(60000); await h.engine.drain();
    assert.ok(h.calls.some(c => c.method === 'deleteMessage' && c.body.message_id === 100));
  }
  for (const directory of [{ async readStaffCabinet() { return null; } }, { async readStaffCabinet() { throw Error('SERVICE_UNAVAILABLE'); } }]) {
    const h = harness();
    h.setStatus('linked');
    h.env.TELEGRAM_TEACHER_PILOT_ENABLED = 'true';
    h.env.TELEGRAM_PILOT_DIRECTORY = directory;
    await h.engine.start(context);
    assert.equal(h.calls.filter(c => c.method === 'sendMessage').length, 0);
  }
  const off = harness();
  off.setStatus('linked');
  off.env.TELEGRAM_PILOT_DIRECTORY = { async readStaffCabinet() { return 'teacher'; } };
  await off.engine.start(context);
  assert.equal(off.calls.filter(c => c.method === 'sendMessage').length, 0);
});
