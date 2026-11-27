import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {createCloudflareEntrypoint} from '../../runtime/cloudflare-entry.mjs';
import {createCabinetApi} from '../../runtime/teacher-cabinet-api.mjs';
import {runStagingPilot} from '../../runtime/teacher-staging-store.mjs';
import {createStagingInviteDeliveryStore} from '../../runtime/teacher-staging-delivery.mjs';
import {dispatchStagingInvite} from '../../apps/telegram-bot/src/staging-invite-dispatch.mjs';
import {startAttempt} from '../../supabase/functions/univeracademy-api/attempts.ts';
import {decodePublished} from '../../supabase/functions/univeracademy-api/storage/attempt-rows.ts';
import {createCluster,createServiceLogin} from './cluster.mjs';
import {issuer,party,provisionStaff,provisionStudent,testClerk} from './credentials.mjs';
import {apiOrigin,good,routes,studentOrigin} from './requests.mjs';

// Review-only coverage authored against main 7161afb0f75f90710e5e6e34f12780fc98083c97.
// This exercises observable behavior of the current paths, not production routing or readiness.
const migration=new URL('../../supabase/migrations/teacher-staging/up.sql',import.meta.url);
const candidate=new URL('../../docs/owner-group-transfer-fence.review.sql',import.meta.url);
const one=async(db,sql,values=[])=>(await db.query(sql,values)).rows[0];
const digest=value=>createHash('sha256').update(value).digest('hex');
const never=async()=>assert.fail('Unexpected provider or network transport');
const policy={initDataMaxAgeSeconds:300,futureSkewSeconds:0,accessTtlMs:900000,familyTtlMs:86400000,
  logoutTombstoneMs:86400000,identityCollisionAttempts:4,newLogin:'revoke_previous'};

function bounded(promise,label){
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),4000);});
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}

test('exact registration expiry and post-claim invite delivery versus the review fence',{timeout:90000},async t=>{
  const cluster=await createCluster(),{admin}=cluster;
  let holder,writer,deliveryPool,cabinetPool;
  t.after(async()=>{
    try{await Promise.allSettled([holder?.end(),writer?.end(),deliveryPool?.end(),cabinetPool?.end()]);}
    finally{await cluster.close();}
  });
  await cluster.installDeletion();
  await admin.query(await readFile(migration,'utf8'));
  await admin.query(await readFile(candidate,'utf8'));
  const apiLogin={role:'ua_api_login',inherit:true,set:false};
  const cabinetUrl=await createServiceLogin(cluster,'qa_h5_cabinet',[apiLogin,{role:'ua_cabinet_stage',inherit:false,set:true}]);
  const legacyUrl=await createServiceLogin(cluster,'qa_h5_legacy',[apiLogin]);
  const deliveryUrl=await createServiceLogin(cluster,'qa_h5_delivery',[{role:'ua_cabinet_delivery',inherit:false,set:true}]);
  const limits={connectionTimeoutMillis:5000,statement_timeout:6000,lock_timeout:5000,query_timeout:7000};
  writer=new pg.Client({connectionString:cabinetUrl,...limits});
  holder=new pg.Client({connectionString:cluster.adminUrl,...limits});
  deliveryPool=new pg.Pool({connectionString:deliveryUrl,max:1,...limits});
  const legacyProbe=new pg.Client({connectionString:legacyUrl,...limits});
  async function assertLogin(db,name){
    assert.deepEqual(await one(db,'SELECT current_user AS role, rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user'),
      {role:name,super:false,bypass:false});
  }
  await writer.connect();await holder.connect();
  await assertLogin(writer,'qa_h5_cabinet');
  await assertLogin(deliveryPool,'qa_h5_delivery');
  await legacyProbe.connect();
  try{await assertLogin(legacyProbe,'qa_h5_legacy');}finally{await legacyProbe.end();}
  const clerk=await testClerk();
  const owner=await provisionStaff(admin,'Ega','owner');
  const source=await provisionStaff(admin,'Avvalgi ustoz','teacher');
  const dest=await provisionStaff(admin,'Yangi ustoz','teacher');
  async function begin(db,actor,restricted=false){
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await db.query("SET LOCAL idle_in_transaction_session_timeout='14s'");
    await db.query("SELECT set_config('ua.phase','auth',true),set_config('ua.person_id',$1,true),set_config('ua.person_ids',$2,true),set_config('ua.telegram_id','',true),set_config('ua.clerk_issuer','',true),set_config('ua.clerk_subject','',true)",[actor,JSON.stringify([actor])]);
    if(restricted){
      assert.equal((await one(db,'SELECT id FROM ua_private.lock_people($1::uuid[])',[[actor]])).id,actor);
      await db.query('SET LOCAL ROLE ua_cabinet_stage');
      assert.equal((await one(db,'SELECT current_user AS role')).role,'ua_cabinet_stage');
    }
    await db.query("SELECT set_config('ua.phase','domain',true)");
  }
  async function inTx(db,actor,restricted,fn){
    try{await begin(db,actor,restricted);const value=await fn();await db.query('COMMIT');return value;}
    catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
  }
  const cmd=(actor,role,action,input,now=Date.now())=>inTx(writer,actor,true,()=>runStagingPilot(
    {client:writer,personIds:[actor],now},{personId:actor,role},action,input,randomUUID()));
  const teacher=(action,input,now)=>cmd(source.id,'teacher',action,input,now);
  const group=async name=>{
    const {id}=await teacher('createGroup',{name,subjectId:'physics'});
    return id;
  };
  const revision=async gid=>(await one(admin,'SELECT revision::text AS revision FROM ua_private.groups WHERE id=$1',[gid])).revision;
  const currentOwner=async gid=>(await one(admin,'SELECT teacher_id FROM ua_cabinet.group_requests WHERE id=$1',[gid])).teacher_id;
  const transfer=async(gid,rev,from=source.id,to=dest.id)=>{
    const k=owner.id+'/staging/transferGroup/'+digest(randomUUID());
    return (await one(holder,'SELECT ua_cabinet.owner_transfer_group_fence($1,$2,$3,$4,$5,$6) AS result',
      [owner.id,gid,from,to,rev,k])).result;
  };

  let atExpiry, clients=0, authFactory=0, expiryWrites=0;
  class LegacyClient extends pg.Client {
    constructor(options){super({...options,...limits});clients++;}
    async query(statement){
      const result=await super.query(statement);
      if(statement?.text?.startsWith('UPDATE ua_private.attempts SET body=')){
        expiryWrites++;
        await atExpiry?.(statement,result);
      }
      return result;
    }
  }
  const worker=createCloudflareEntrypoint({
    loadClient:async()=>LegacyClient,transport:never,
    makeClerk:async()=>{
      authFactory++;
      return {verifier:{...clerk.verifier,authorizedParties:[studentOrigin]},liveness:clerk.liveness,close:async()=>{}};
    }
  });
  const env={UA_API_ORIGIN:apiOrigin,UA_ALLOWED_ORIGINS:JSON.stringify([studentOrigin]),
    UA_SESSION_POLICY:JSON.stringify(policy),UA_CLERK_PROVIDER_SETTINGS:JSON.stringify({issuer,authorizedParties:[studentOrigin]}),
    UA_CLERK_SECRET_KEY:'fixture-only-never-sent',HYPERDRIVE:{connectionString:legacyUrl}};
  const request=(student,path,method='GET',body)=>worker.fetch(new Request(apiOrigin+'/api/v1'+path,{
    method,headers:{origin:studentOrigin,authorization:'Bearer '+student.token,
      ...(body===undefined?{}:{'content-type':'application/json','idempotency-key':randomUUID()})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  }),env);

  async function pastExam(number,telegramId){
    const person=await provisionStudent(admin,'Tarixiy oquvchi',number,telegramId,{clerk});
    const gid=await group('Tarixiy guruh '+number);
    await teacher('addMember',{groupId:gid,univeracademy_id:number});
    const draft=await teacher('importTest',{title:'Fizika sinovi',duration_seconds:300,
      questions:[{text:'2+2',options:['1','2','3','4'],correctIndex:3}]});
    await teacher('publishTest',{testId:draft.id});
    const assignment=await teacher('assignTest',{groupId:gid,testId:draft.id},Date.now()-48*60*60*1000);
    const a=await one(admin,'SELECT record,demo_id FROM ua_private.assignments WHERE id=$1',[assignment.id]);
    const epochs=await one(admin,'SELECT m.epoch,g.grant_epoch FROM ua_private.memberships m JOIN ua_private.grants g ON g.person_id=m.person_id WHERE m.person_id=$1 AND g.assignment_id=$2',
      [person.id,assignment.id]);
    const started=startAttempt({access:{proofKind:'student_session',personId:person.id,enabled:true,assignmentIds:[assignment.id]},
      admission:{...a.record.admission,activeGroupId:gid,rostered:true,profileComplete:true,
        membershipEpoch:Number(epochs.epoch),grantEpoch:Number(epochs.grant_epoch)},published:decodePublished(a.record.published),
      existing:null,id:randomUUID(),confirmed:true,now:assignment.opensAt});
    const {published,questionOrder,answers,ordinary,...body}=started;
    assert.deepEqual(answers,[]);assert.equal(ordinary,null);
    // Durable initial state: real fixture engine and unchanged checked schema;
    // only the tested HTTP request materializes its expiry and ordinary result.
    await inTx(admin,person.id,false,async()=>{
      await admin.query('INSERT INTO ua_private.attempts(id,person_id,assignment_id,demo_id,generation,state_revision,body,frozen_test,question_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [started.id,person.id,assignment.id,a.demo_id,started.generation,started.stateRevision,
          JSON.stringify(body),JSON.stringify(a.record.published),JSON.stringify(questionOrder)]);
      await admin.query("INSERT INTO ua_private.exam_series(person_id,demo_id,id,current_attempt_id,generation,state_revision,normal_attempt_used,official_attempt_id,recovery_state,recovery_window) VALUES($1,$2,$3,$4,$5,$6,true,NULL,'none',NULL)",
        [person.id,a.demo_id,randomUUID(),started.id,started.generation,started.seriesStateRevision]);
    });
    assert.equal((await one(admin,'SELECT $1::numeric < extract(epoch FROM clock_timestamp())*1000 AS past',[started.deadlineAt])).past,true);
    return {person,gid,aid:assignment.id,id:started.id,deadline:started.deadlineAt,rev:await revision(gid)};
  }
  const history=f=>one(admin,"SELECT a.body, a.state_revision::text AS revision, s.official_attempt_id, (SELECT count(*)::int FROM ua_private.attempts siblings WHERE siblings.assignment_id=a.assignment_id AND siblings.person_id=a.person_id) AS attempts, (SELECT count(*)::int FROM ua_private.ordinary_results WHERE attempt_id=a.id) AS results, r.exact_result, (SELECT to_jsonb(x) FROM ua_private.assignments x WHERE x.id=a.assignment_id) AS assignment, (SELECT to_jsonb(m) FROM ua_private.memberships m WHERE m.person_id=a.person_id) AS membership FROM ua_private.attempts a JOIN ua_private.exam_series s ON s.current_attempt_id=a.id LEFT JOIN ua_private.ordinary_results r ON r.attempt_id=a.id WHERE a.id=$1",[f.id]);
  async function list(f){
    const r=await request(f.person,'/exams');
    assert.equal(r.status,200,await r.clone().text());
    const {data}=await r.json();
    assert.ok(data.some(row=>row.assignment_id===f.aid&&row.admission_status==='closed'));
  }
  async function terminal(f,before){
    const after=await history(f);
    assert.equal(after.body.status,'expired');
    assert.equal(after.body.completedAt,f.deadline);
    assert.equal(after.revision,String(Number(before.revision)+1));
    assert.equal(after.official_attempt_id,f.id);
    assert.equal(after.attempts,1);assert.equal(after.results,1);
    assert.ok(after.exact_result);
    assert.deepEqual(after.assignment,before.assignment);
    assert.deepEqual(after.membership,before.membership);
    await list(f);
    assert.deepEqual(await history(f),after);
  }
  const first=await pastExam('0100000151',711000151);
  const second=await pastExam('0100000152',711000152);

  await t.test('registration Worker denies generic attempt creation and submission before auth and DB',async()=>{
    const before=await history(first);
    for(const [path,body] of [['/exams/'+first.aid+'/attempts',{confirmed:true}],['/attempts/'+first.id+'/submit',undefined]]){
      const response=await request(first.person,path,'POST',body);
      assert.ok([404,503].includes(response.status));
      const payload=await response.json();
      assert.ok(payload.error&&!Object.hasOwn(payload,'data'));
    }
    assert.equal(clients,0);assert.equal(authFactory,0);
    assert.deepEqual(await history(first),before);
  });

  await t.test('legacy expiry update first: transfer commits while the actual GET has not committed',async()=>{
    const before=await history(first);
    const entered=Promise.withResolvers(),release=Promise.withResolvers();
    atExpiry=async(statement,result)=>{
      if(statement.values[2]===first.id){
        assert.equal(result.rowCount,1);entered.resolve();
        await bounded(release.promise,'legacy release');
      }
    };
    const listing=list(first);
    void listing.catch(()=>{});
    try{
      await bounded(Promise.race([entered.promise,listing.then(()=>assert.fail('GET did not write expiry'))]),'legacy writes expiry');
      assert.equal((await history(first)).body.status,'in_progress');
      const moved=await bounded(inTx(holder,owner.id,false,()=>transfer(first.gid,first.rev)),'owner while legacy holds attempt row');
      assert.equal(moved.groupId,first.gid);
      assert.equal(await currentOwner(first.gid),dest.id);
    }finally{release.resolve();atExpiry=undefined;await listing;}
    await terminal(first,before);
  });

  await t.test('transfer first: actual GET expires and commits without waiting on the group fence',async()=>{
    const before=await history(second);
    let listing;
    try{
      await begin(holder,owner.id);
      assert.equal((await transfer(second.gid,second.rev)).groupId,second.gid);
      assert.equal(await currentOwner(second.gid),source.id);
      listing=list(second);
      await bounded(listing,'legacy GET while transfer owns fence');
      assert.equal((await history(second)).body.status,'expired');
      await holder.query('COMMIT');
    }finally{await holder.query('ROLLBACK').catch(()=>{});if(listing)await Promise.allSettled([listing]);}
    assert.equal(await currentOwner(second.gid),dest.id);
    await terminal(second,before);
    assert.equal(expiryWrites,2);
  });

  const store=createStagingInviteDeliveryStore({pool:deliveryPool});
  const urls={cabinet:studentOrigin+'/',signIn:studentOrigin+'/sign-in'};
  const outbox=token=>one(admin,'SELECT to_jsonb(d) AS delivery, i.created_by, i.expires_at::text AS expiry, i.expires_at<=clock_timestamp() AS expired FROM ua_cabinet.invite_delivery d JOIN ua_cabinet.invites i ON i.digest=d.invite_digest WHERE d.invite_digest=$1',[digest(token)]);
  cabinetPool=new pg.Pool({connectionString:cabinetUrl,max:1,...limits});
  const cabinet=createCabinetApi({enabled:true,pool:cabinetPool,teacherOrigin:party,studentOrigin,apiOrigin,
    verifier:clerk.verifier,liveness:clerk.liveness,allowLegacyTelegram:false},never);
  const redeem=(f,key)=>routes(cabinet,'student',f.person.token).command('acceptInvite',{token:f.invite.token},key);
  const enrollment=f=>one(admin,"SELECT to_jsonb(m) AS membership,p.profile->>'active_group_id' AS profile_group FROM ua_private.memberships m JOIN ua_private.people p ON p.id=m.person_id WHERE m.person_id=$1",[f.person.id]);
  const redemptions=async f=>(await admin.query('SELECT invite_digest,student_id,command_key FROM ua_cabinet.redemptions WHERE invite_digest=$1 OR student_id=$2 ORDER BY invite_digest,student_id',
    [digest(f.invite.token),f.person.id])).rows;
  const audits=async f=>(await admin.query("SELECT a.actor_id,a.target_id,a.revision::text AS revision,r.response FROM ua_private.staff_audit a LEFT JOIN ua_private.staff_receipts r ON r.actor_id=a.actor_id AND r.key=a.command_key WHERE a.target_id=$1 AND a.action='transferGroup' ORDER BY a.revision",
    [f.gid])).rows;
  const nextRev=revision=>String(BigInt(revision)+1n);
  const audit=(f,from,to,old)=>({actor_id:owner.id,target_id:f.gid,revision:nextRev(old),
    response:{groupId:f.gid,sourceTeacherId:from,destinationTeacherId:to,previousRevision:old,revision:nextRev(old)}});
  async function queue(name,number,telegramId){
    const person=await provisionStudent(admin,name,number,telegramId,{clerk});
    const gid=await group(name+' guruhi');
    await store.recordPrivateStart({telegramUserId:telegramId});
    const invite=await teacher('sendInvite',{groupId:gid,univeracademy_id:number});
    assert.equal(invite.delivery,'queued');
    const f={person,gid,invite,rev:await revision(gid)};
    f.initialEnrollment=await enrollment(f);
    assert.equal(f.initialEnrollment.membership.active,false);
    assert.equal(f.initialEnrollment.membership.affinity_group_id,null);
    assert.equal(f.initialEnrollment.profile_group,null);
    assert.deepEqual(await redemptions(f),[]);
    return f;
  }
  const move=f=>inTx(holder,owner.id,false,()=>transfer(f.gid,f.rev));
  async function deny(f,status,code,snapshot){
    const response=await redeem(f,randomUUID());
    const body=await response.json();
    assert.equal(response.status,status,JSON.stringify(body));
    assert.equal(body.error?.code,code);
    assert.ok(!Object.hasOwn(body,'data'));
    assert.deepEqual(await redemptions(f),[]);
    assert.deepEqual(await enrollment(f),f.initialEnrollment);
    assert.deepEqual(await outbox(f.invite.token),snapshot);
  }
  async function unredeemable(f){
    const postMove=await outbox(f.invite.token);
    assert.equal(postMove.expired,true);
    assert.equal(await currentOwner(f.gid),dest.id);
    // The normal route checks the former teacher's group before checking time.
    await deny(f,404,'NOT_FOUND',postMove);
    const forward=audit(f,source.id,dest.id,f.rev);
    assert.deepEqual(await audits(f),[forward]);
    const movedBack=await inTx(holder,owner.id,false,()=>transfer(f.gid,forward.revision,dest.id,source.id));
    assert.equal(movedBack.groupId,f.gid);
    assert.equal(await currentOwner(f.gid),source.id);
    // Fixture-only transfer-back isolates the expiry check under matching authorship.
    await deny(f,410,'INVITE_EXPIRED',postMove);
    assert.deepEqual(await audits(f),[forward,audit(f,dest.id,source.id,forward.revision)]);
  }

  await t.test('transfer before outbox claim leaves the queue history and suppresses transport',async()=>{
    const f=await queue('Birinchi taklif','0100000153',711000153);
    const before=await outbox(f.invite.token);
    assert.equal(before.expired,false);
    await move(f);
    let sends=0;
    assert.equal(await dispatchStagingInvite(store,async()=>{sends++;return never();},urls),'empty');
    assert.equal(sends,0);
    const after=await outbox(f.invite.token);
    assert.equal(after.expired,true);
    assert.deepEqual(after.delivery,before.delivery);
    assert.equal(after.created_by,source.id);
    await unredeemable(f);
  });

  await t.test('durable claim before transfer allows one stale mock send, but does not restore redemption',async()=>{
    const f=await queue('Ikkinchi taklif','0100000154',711000154);
    const entered=Promise.withResolvers(),release=Promise.withResolvers();
    const observed=[];
    // Delegate to the actual restricted store. Pause only after its native
    // claim transaction commits, before the dispatcher can attempt transport.
    const gatedStore={async claimInviteDelivery(){
      const claim=await store.claimInviteDelivery();
      if(claim){entered.resolve(claim.id);await bounded(release.promise,'dispatch release');}
      return claim;
    },finishInviteDelivery:(...args)=>store.finishInviteDelivery(...args)};
    const sending=dispatchStagingInvite(gatedStore,async(method,payload)=>{
      observed.push({method,chat:payload.chat_id,
        invite:new URL(payload.reply_markup.inline_keyboard[0][0].web_app.url).searchParams.get('invite')});
      return {kind:'ok',result:{chat:{id:f.person.telegramId},message_id:41}};
    },urls);
    void sending.catch(()=>{});
    let claimed;
    try{
      const claimId=await bounded(Promise.race([entered.promise,sending.then(()=>assert.fail('outbox did not claim'))]),'durable claim');
      claimed=await outbox(f.invite.token);
      assert.equal(claimed.delivery.status,'claimed');
      assert.equal(claimed.delivery.claim_id,claimId);
      assert.equal(claimed.expired,false);
      await move(f);
      assert.equal(await currentOwner(f.gid),dest.id);
      assert.deepEqual(observed,[]);
      const afterTransfer=await outbox(f.invite.token);
      assert.notEqual(afterTransfer.expiry,claimed.expiry);
      assert.deepEqual(afterTransfer,{...claimed,expiry:afterTransfer.expiry,expired:true});
    }finally{release.resolve();await sending;}
    assert.equal(await sending,'sent');
    assert.deepEqual(observed,[{method:'sendMessage',chat:f.person.telegramId,invite:f.invite.token}]);
    const delivered=await outbox(f.invite.token);
    assert.equal(delivered.created_by,source.id);
    assert.equal(delivered.expired,true);
    assert.equal(delivered.delivery.status,'sent');
    assert.equal(delivered.delivery.id,claimed.delivery.id);
    assert.equal(delivered.delivery.claim_id,claimed.delivery.claim_id);
    assert.equal(delivered.delivery.claimed_at,claimed.delivery.claimed_at);
    await unredeemable(f);
  });

  await t.test('valid targeted invite uses the same student route, with one durable redemption across replay',async()=>{
    // Run last so this independent control never supplies a claim to either race.
    const f=await queue('Haqiqiy taklif','0100000155',711000155);
    const before=await outbox(f.invite.token);
    assert.equal(before.expired,false);
    const key=randomUUID();
    const first=await good(redeem(f,key));
    assert.equal(first.id,f.gid);
    const enrolled=await enrollment(f);
    assert.deepEqual(enrolled,{membership:{...f.initialEnrollment.membership,active:true,affinity_group_id:f.gid,
      revision:f.initialEnrollment.membership.revision+1,epoch:f.initialEnrollment.membership.epoch+1},profile_group:f.gid});
    assert.deepEqual(await good(redeem(f,key)),first);
    assert.deepEqual(await enrollment(f),enrolled);
    assert.deepEqual(await redemptions(f),[{invite_digest:digest(f.invite.token),student_id:f.person.id,command_key:key}]);
    assert.equal(await revision(f.gid),nextRev(f.rev));
    assert.deepEqual(await outbox(f.invite.token),before);
    assert.deepEqual(await audits(f),[]);
  });
});
