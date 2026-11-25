import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {createCluster, addProfile, createServiceLogin} from './cluster.mjs';
import {createStagingInviteDeliveryStore} from '../../runtime/teacher-staging-delivery.mjs';
import {sendTeacherNotice, deleteTeacherNotice} from '../../apps/telegram-bot/src/teacher-notice.mjs';

const migration = name => readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');

test('only eligible teachers receive a single private notice and its own receipt expires after 24 hours', async t => {
  const cluster = await createCluster();
  t.after(()=>cluster.close());
  const db = cluster.admin;
  await cluster.installDeletion();
  await db.query(await migration('teacher-staging/up.sql'));
  await db.query('ALTER SCHEMA ua_cabinet OWNER TO ua_owner');
  async function enroll(name, cabinetId, telegramId, teacher=false) {
    const id = await addProfile(db,{name,role:'student',cabinetId,telegramId});
    if (teacher) {
      await db.query("UPDATE ua_private.people SET roles=ARRAY['student','teacher'],profile=jsonb_set(profile,'{roles}',to_jsonb(ARRAY['student','teacher'])) WHERE id=$1",[id]);
      await db.query('INSERT INTO ua_private.staff_access(person_id,approved,manage_roster,manage_content,all_groups,all_subjects) VALUES($1,true,false,false,false,false)',[id]);
      await db.query("INSERT INTO ua_private.teacher_subject_approvals(person_id,subject_id,approved) VALUES($1,'physics',true)",[id]);
    }
    return id;
  }
  const now = Math.floor(Date.now()/1000);
  const firstChat = 700000001, secondChat = 700000003;
  const first = await enroll('Ustoz','0000000001',firstChat,true);
  await enroll('Talaba','0000000002',700000002);
  await db.query(await migration('teacher-notifications/001_teacher_notifications.sql'));
  const login = await createServiceLogin(cluster,'notice_delivery_probe',[{role:'ua_cabinet_delivery',set:true}]);
  const pool = new pg.Pool({connectionString:login,max:4});
  const delivery = createStagingInviteDeliveryStore({pool});
  const store = delivery.teacherNotifications;
  const state = async id => (await db.query('SELECT * FROM ua_cabinet.teacher_notifications WHERE person_id=$1',[id])).rows[0];
  function receipt(chat,id,date) {
    return {kind:'ok',result:{chat:{id:chat,type:'private'},message_id:id,date}};
  }
  const sent = [];
  try {
    const firstSend = async (method,body) => {
      sent.push({method,body});
      return receipt(firstChat,101,now);
    };
    const results = await Promise.all([sendTeacherNotice(store,firstSend),sendTeacherNotice(store,firstSend)]);
    assert.deepEqual(results.sort(),[false,true]);
    assert.deepEqual(sent,[{method:'sendMessage',body:{chat_id:firstChat,text:'UniverAcademy’da sizga fizika o‘qituvchisi huquqi berildi.',reply_markup:{inline_keyboard:[[{text:'Ustoz kabinetini ochish',url:'https://ustoz.univeracademy.uz/'}]]}}}]);
    const row = await state(first);
    assert.equal(row.state,'sent');
    assert.equal(row.delete_after.getTime()-row.sent_at.getTime(),86400000);
    assert.equal(await deleteTeacherNotice(store,()=>assert.fail('Early removal')),false);

    const second = await enroll('Ikkinchi','0000000003',secondChat,true);
    await sendTeacherNotice(store,async()=>({kind:'rejected',chatUnavailable:true}));
    assert.equal((await state(second)).state,'blocked');
    await delivery.recordPrivateStart({telegramUserId:700000002},true);
    assert.equal(await sendTeacherNotice(store,()=>assert.fail('Unrelated /start')),false);
    await delivery.recordPrivateStart({telegramUserId:secondChat},true);
    assert.equal((await state(second)).state,'queued');
    // Replay an older Telegram receipt to exercise the timer without waiting a day in CI.
    await sendTeacherNotice(store,async(method,body)=>{
      assert.equal(method,'sendMessage');
      assert.equal(body.chat_id,secondChat);
      return receipt(secondChat,102,now-86460);
    });
    await db.query('UPDATE ua_private.people SET telegram_id=NULL WHERE id=$1',[second]);
    const deleted = [];
    const remove = async (method,body) => { deleted.push({method,body}); return {kind:'ok',result:true}; };
    await Promise.all([deleteTeacherNotice(store,remove),deleteTeacherNotice(store,remove)]);
    assert.deepEqual(deleted,[{method:'deleteMessage',body:{chat_id:secondChat,message_id:102}}]);
    const finished = await state(second);
    assert.equal(finished.state,'deleted');
    assert.equal(finished.message_id,null);
    assert.equal(finished.chat_id,null);
    assert.equal((await state(first)).state,'sent');
    assert.equal((await db.query('SELECT count(*)::int n FROM ua_cabinet.teacher_notifications')).rows[0].n,2);

    const third = await enroll('Uchinchi','0000000004',700000004,true);
    await sendTeacherNotice(store,async()=>{throw Error('ambiguous transport');});
    assert.equal((await state(third)).state,'unconfirmed');
    await delivery.recordPrivateStart({telegramUserId:700000004},true);
    assert.equal(await sendTeacherNotice(store,()=>assert.fail('Blind retry')),false);

    // Exercise the real delivery role and each existing column grant/RLS policy.
    const chat = 700000004;
    const hint = telegramUserId => delivery.readStaffCabinet({telegramUserId});
    assert.equal(await hint(chat), 'teacher');
    assert.equal(await hint(700000002), null);
    assert.equal(await hint(799999999), null);
    await db.query("UPDATE ua_private.teacher_subject_approvals SET approved=false WHERE person_id=$1", [third]);
    assert.equal(await hint(chat), null);
    const setRoles = roles => db.query("UPDATE ua_private.people SET roles=$2,profile=jsonb_set(profile,'{roles}',to_jsonb($2::text[])) WHERE id=$1", [third, roles]);
    await setRoles(['student','teacher','admin']);
    assert.equal(await hint(chat), 'admin');
    await setRoles(['student','teacher','admin','owner']);
    assert.equal(await hint(chat), 'owner');
    await db.query('UPDATE ua_private.staff_access SET approved=false WHERE person_id=$1',[third]);
    assert.equal(await hint(chat), null);
    await db.query('UPDATE ua_private.staff_access SET approved=true WHERE person_id=$1',[third]);
    await db.query('UPDATE ua_private.people SET enabled=false WHERE id=$1',[third]);
    assert.equal(await hint(chat), null);

  } finally { await pool.end(); }
});
