import assert from 'node:assert/strict';
import test from 'node:test';
import {sendTeacherNotice, deleteTeacherNotice} from '../src/teacher-notice.mjs';
import {createTelegramDelivery} from '../src/telegram-delivery.mjs';

test('a Telegram receipt must identify the linked private chat and message',async()=>{
  for(const result of [
    {chat:{id:51,type:'private'},message_id:1},
    {chat:{id:50,type:'group'},message_id:1},
    {chat:{id:50,type:'private'},message_id:0}
  ]) {
    let saved;
    const store = {claimSend:async()=>({claim:'a',chatId:50}),finishSend:async(key,status)=>{assert.equal(key,'a');saved=status;}};
    await sendTeacherNotice(store,async(method,body)=>{
      assert.deepEqual([method,body],['sendMessage',{chat_id:50,text:'UniverAcademy’da sizga o‘qituvchi huquqi berildi.'}]);
      return {kind:'ok',result};
    });
    assert.deepEqual(saved,{status:'unconfirmed'});
  }
});

test('Telegram throttling defers a notice and a missing message completes deletion',async()=>{
  const reply = (error_code,description,parameters)=>createTelegramDelivery('123:'+'A'.repeat(25),
    async()=>Response.json({ok:false,error_code,description,parameters},{status:error_code}));
  let saved;
  const store = {claimSend:async()=>({claim:'a',chatId:50}),claimDelete:async()=>({claim:'b',chatId:50,messageId:90}),
    finishSend:async(_,status)=>{saved=status;},finishDelete:async(_,status)=>{saved=status;}};
  await sendTeacherNotice(store,reply(429,'Too Many Requests',{retry_after:2}));
  assert.deepEqual(saved,{status:'retry',delay:2000});
  await sendTeacherNotice(store,reply(400,'Bad Request: chat not found'));
  assert.deepEqual(saved,{status:'blocked'});
  await deleteTeacherNotice(store,reply(400,'Bad Request: message to delete not found'));
  assert.deepEqual(saved,{status:'deleted'});
  await deleteTeacherNotice(store,reply(429,'Too Many Requests',{retry_after:3}));
  assert.deepEqual(saved,{status:'delete_retry',delay:3000});
});
