import test from 'node:test';
import assert from 'node:assert/strict';
import {createReturningBotWorker} from '../src/returning-worker.mjs';
import {dispatchStagingInvite} from '../src/staging-invite-dispatch.mjs';
import {dispatchOneStagingNotification} from '../../../runtime/staging-invite-dispatch-job.mjs';

const urls = {cabinet:'https://mini.example.org/',signIn:'https://mini.example.org/sign-in'};
const token = 'grp_' + 'a'.repeat(32);
const webhookSecret = 'S'.repeat(32);
function webhook({peer=401,from=peer,secret=webhookSecret,text='/start '+token}={}) {
  return new Request('https://bot.example/telegram/webhook',{method:'POST',headers:{
    'X-Telegram-Bot-Api-Secret-Token':secret,'Content-Type':'application/json'},
    body:JSON.stringify({update_id:19,message:{message_id:6,chat:{id:peer,type:'private'},from:{id:from,is_bot:false},text}})});
}
test('a verified private invitation opens the configured Mini App and does not grant membership',async()=>{
  const observed=[];
  const env={TELEGRAM_WEBHOOK_SECRET:webhookSecret,TELEGRAM_TEACHER_PILOT_ENABLED:'true',
    MINI_CABINET_URL:urls.cabinet,MINI_SIGN_IN_URL:urls.signIn,
    TELEGRAM_PILOT_DIRECTORY:{async recordPilotPrivateStart(input){observed.push(input)}},
    TELEGRAM_START_LOOKUP:{async lookupTelegramStart(){return {status:'linked'}}}};
  const worker = createReturningBotWorker();
  assert.equal((await worker.fetch(webhook({secret:'different'}),env)).status,401);
  assert.equal(await (await worker.fetch(webhook({from:502}),env)).text(),'');
  assert.deepEqual(observed,[]);
  const full = await (await worker.fetch(webhook(),env)).json();
  assert.equal(full.chat_id,401); assert.deepEqual(observed,[{telegramUserId:401}]);
  assert.equal(full.reply_markup.inline_keyboard[0][0].web_app.url,urls.cabinet+'?invite='+token);
  const disabled=await (await worker.fetch(webhook(),{...env,TELEGRAM_TEACHER_PILOT_ENABLED:'false'})).json();
  assert.equal(disabled.reply_markup.inline_keyboard[0][0].web_app.url,urls.cabinet);
  assert.equal(observed.length,1);
});
test('private start sends one fixed browser link only to linked staff and preserves the student invite', async () => {
  const worker = createReturningBotWorker();
  let role = 'teacher', state = 'linked', reads = 0;
  const env = {TELEGRAM_WEBHOOK_SECRET:webhookSecret, TELEGRAM_TEACHER_PILOT_ENABLED:'true',
    MINI_CABINET_URL:urls.cabinet, MINI_SIGN_IN_URL:urls.signIn,
    TELEGRAM_START_LOOKUP:{lookupTelegramStart:async()=>({status:state})},
    TELEGRAM_PILOT_DIRECTORY:{recordPilotPrivateStart:async()=>{}, async readStaffCabinet(input) {
      assert.deepEqual(input,{telegramUserId:401}); reads++;
      if (role === 'unavailable') throw Error('SERVICE_UNAVAILABLE');
      return role;
    }}};
  async function buttons(text) {
    const response = await worker.fetch(webhook({text}), env);
    assert.equal(response.status,200);
    return (await response.json()).reply_markup.inline_keyboard;
  }
  for (const [hint,path] of [['teacher','/'],['admin','/admin'],['owner','/owner']]) {
    role=hint;
    assert.deepEqual(await buttons('/start'), [[{text:'Kabinet',url:'https://ustoz.univeracademy.uz'+path}]]);
  }
  const beforeInvite = reads;
  assert.equal((await buttons('/start '+token))[0][0].web_app.url, urls.cabinet+'?invite='+token);
  assert.equal(reads,beforeInvite);
  for (const hint of [null,'https://wrong.example','unavailable']) {
    role=hint;
    assert.deepEqual(await buttons('/start'), [[{text:'Kabinet',web_app:{url:urls.cabinet}}]]);
  }
  const beforeUnlinked = reads;
  state='needs_clerk';
  assert.equal((await buttons('/start'))[0][0].web_app.url, urls.signIn);
  state='disabled';
  assert.equal(await (await worker.fetch(webhook({text:'/start'}),env)).text(),'');
  assert.equal(reads,beforeUnlinked);
});
test('only a matching Telegram receipt confirms a claim, and only explicit throttling asks for redelivery',async()=>{
  const outcomes = [
    [{kind:'ok',result:{message_id:7,chat:{id:401}}},{status:'sent'}],
    [{kind:'ok',result:{message_id:7,chat:{id:200}}},{status:'unconfirmed'}],
    [{kind:'retry',delay:32000},{status:'retry',retryAfterMs:32000}],
    [{kind:'unknown'},{status:'unconfirmed'}], [null,{status:'unconfirmed'}], [{kind:'blocked'},{status:'rejected'}],
  ];
  for(const [reply,expected] of outcomes){
    let claimed=false, written, sent=0;
    const store={async claimInviteDelivery(){if(claimed)return null;claimed=true;return {id:'one',telegramUserId:401,token}},
      async finishInviteDelivery(id,value){assert.equal(id,'one');written=value}};
    async function deliver(method,body){
      sent++;assert.equal(method,'sendMessage'); assert.equal(body.chat_id,401);
      assert.equal(body.reply_markup.inline_keyboard[0][0].web_app.url,urls.cabinet+'?invite='+token);
      if(reply===null)throw Error('lost response');
      return reply;
    }
    assert.equal(await dispatchStagingInvite(store,deliver,urls),expected.status);
    assert.equal(await dispatchStagingInvite(store,deliver,urls),'empty');
    assert.deepEqual(written,expected);assert.equal(sent,1);
  }
  assert.equal(await dispatchOneStagingNotification({}),'disabled');
});
