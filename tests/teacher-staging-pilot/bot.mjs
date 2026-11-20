import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { createReturningBotWorker } from '../../apps/telegram-bot/src/returning-worker.mjs';
import { createInviteSchedule } from '../../runtime/cloudflare-invite-schedule.mjs';
import { studentOrigin } from './requests.mjs';

export function testBot(directory, deliveryUrl) {
  const secret=randomBytes(24).toString('base64url');
  const worker=createReturningBotWorker();
  const ends={cabinet:studentOrigin+'/',signIn:studentOrigin+'/sign-in'};
  const env={
    TELEGRAM_TEACHER_PILOT_ENABLED:'true',TELEGRAM_WEBHOOK_SECRET:secret,
    TELEGRAM_PILOT_DIRECTORY:{recordPilotPrivateStart:row=>directory.recordPrivateStart(row)},
    TELEGRAM_START_LOOKUP:{lookupTelegramStart:async()=>({status:'linked'})},
    MINI_CABINET_URL:ends.cabinet, MINI_SIGN_IN_URL:ends.signIn
  };
  async function start(telegramUserId,token) {
    const response=await worker.fetch(new Request('https://bot.stage-classroom.example.com/telegram/webhook',{
      method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},
      body:JSON.stringify({update_id:randomInt(1,1000000),message:{
        message_id:1,date:Math.floor(Date.now()/1000),from:{is_bot:false,id:telegramUserId},
        chat:{id:telegramUserId,type:'private'},text:'/start'+(token?' '+token:'')
      }})
    }),env);
    const message=await response.json();
    assert.equal(response.status,200,JSON.stringify(message));
    assert.equal(message.chat_id,telegramUserId);
    return new URL(message.reply_markup.inline_keyboard[0][0].web_app.url);
  }
  function schedule(reply) {
    const testToken = '17:' + randomBytes(24).toString('hex');
    const scheduled = createInviteSchedule({ fetcher: async (url, init) => {
      assert.equal(url, 'https://api.telegram.org/bot' + testToken + '/sendMessage');
      assert.equal(init.method, 'POST');
      return reply(JSON.parse(init.body));
    } });
    return () => scheduled({}, {
      UA_TELEGRAM_PILOT_DISPATCH_ENABLED: 'true', UA_TELEGRAM_BOT_TOKEN: testToken,
      UA_CABINET_STUDENT_ORIGIN: studentOrigin, UA_ALLOWED_ORIGINS: JSON.stringify([studentOrigin]),
      TEACHER_PILOT_HYPERDRIVE: { connectionString: deliveryUrl }
    });
  }
  return { start, schedule };
}
