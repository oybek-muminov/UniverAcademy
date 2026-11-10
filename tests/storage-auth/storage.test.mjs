import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PostgresTransactions, StorageUnavailable } from "../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts";
import { AttemptRows, encodePublished } from "../../supabase/functions/univeracademy-api/storage/attempt-rows.ts";
import { SessionRows } from "../../supabase/functions/univeracademy-api/storage/session-rows.ts";
import { startAttempt, saveAnswer, submitAttempt } from "../../supabase/functions/univeracademy-api/attempts.ts";
import { proofHash } from "../../supabase/functions/univeracademy-api/student-state.ts";
import { ratio } from "../../supabase/functions/univeracademy-api/ordinary.ts";
import { DiskExecutor, durableWrite } from "./disk-executor.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const P=id(1),Q=id(100),A=id(10),D=id(20),V=id(30),F=id(50),G=id(40);
const hash = (n) => n.toString(16).padStart(64,"0");
const access = { proofKind:"student_session",personId:P,enabled:true,assignmentIds:[A] };
async function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),"ua-storage-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,"rows.json");
  const record=startAttempt({ access,id:A,confirmed:true,now:10000,existing:null,
    admission:{ assignmentId:A,groupId:G,activeGroupId:G,rostered:true,profileComplete:true,membershipEpoch:1,grantEpoch:1,opensAt:9000,closesAt:20000 },
    published:{ demoId:D,versionId:V,durationMs:60000,individualEnabled:true,
      questions:[{id:Q,optionIds:[id(200),id(201),id(202),id(203)],correctOptionId:id(200),individualPoints:ratio(1n,8n)}] } });
  const {published,questionOrder,answers,ordinary,...body}=record;
  durableWrite(path,{ people:{[P]:{telegram_id:4000000001,enabled:true,roles:["student"]}},
    attempts:{[A]:{body,frozen_test:encodePublished(published),question_order:questionOrder}}, answers:{},results:{},
    series:{[P+"/"+D]:{currentAttemptId:A,generation:1,stateRevision:1,officialAttemptId:null}},
    families:{[F]:{person_id:P,expires_at_ms:100000,revoked_at_ms:null,logout_retain_until_ms:null,auth_provider:"telegram"}},
    access:{[hash(1)]:{family_id:F,expires_at_ms:90000,superseded:false}},refresh:{[hash(2)]:{family_id:F,consumed:false}},replays:{} });
  const pool=new DiskExecutor(path),runner=new PostgresTransactions(pool),repo=new AttemptRows(),sessions=new SessionRows();
  async function command(action, digest=hash(1)) {
    return runner.run([P],async(tx)=>{await sessions.authorize(tx,P,digest);const before=await repo.load(tx,P,A);
      const transition=action(before,tx.now);await repo.persist(tx,before,transition.record);return transition.response;});
  }
  return {path,pool,runner,repo,sessions,command,record};
}
const current={id:A,generation:1};
const save=(revision,selected=id(200))=>(r,now)=>saveAnswer(access,r,current,Q,{selected_option_id:selected,expected_revision:revision},now);
const login=(n)=>({personId:P,telegramUserId:4000000001,initDataDigest:hash(100+n),familyId:id(60+n),expiresAt:110000,accessExpiresAt:95000,
  accessDigest:hash(200+n),refreshDigest:hash(300+n),logoutRetainUntil:150000});

test("answer save/clear/CAS and exact snapshots survive a separate process; deadline/revision are unchanged by restart",async(t)=>{
  const f=await setup(t);assert.equal((await f.command(save(0))).value.revision,1);
  assert.equal((await f.command(save(1,null))).value.revision,2);
  await assert.rejects(f.command(save(1)),e=>e.code==="REVISION_CONFLICT");
  const module=pathToFileURL(join(process.cwd(),"supabase/functions/univeracademy-api/storage/attempt-rows.ts")).href;
  const runner=pathToFileURL(join(process.cwd(),"supabase/functions/univeracademy-api/storage/postgres-transaction.ts")).href;
  const executor=pathToFileURL(join(process.cwd(),"tests/storage-auth/disk-executor.mjs")).href;
  const script=`import{AttemptRows}from ${JSON.stringify(module)};import{PostgresTransactions}from ${JSON.stringify(runner)};import{DiskExecutor}from ${JSON.stringify(executor)};const p=new DiskExecutor(${JSON.stringify(f.path)});const a=await new PostgresTransactions(p).run([${JSON.stringify(P)}],tx=>new AttemptRows().load(tx,${JSON.stringify(P)},${JSON.stringify(A)}));console.log(JSON.stringify({revision:a.answers[0].revision,selected:a.answers[0].selectedOptionId,deadline:a.deadlineAt,denominator:String(a.published.questions[0].individualPoints.denominator)}));`;
  const restored=JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",script],{encoding:"utf8"}));
  assert.deepEqual(restored,{revision:2,selected:null,deadline:70000,denominator:"8"});
});
test("lock-before-clock, deadline equality expiry and ordinary result commit before a409 outcome",async(t)=>{
  const f=await setup(t);await f.command(save(0));f.pool.beforeLock=async()=>{f.pool.now=70000;};
  const response=await f.command(save(1));assert.equal(response.ok,false);assert.equal(response.error.code,"ATTEMPT_EXPIRED");
  const disk=f.pool.read();assert.equal(disk.attempts[A].body.status,"expired");assert.equal(disk.attempts[A].body.completedAt,70000);
  assert.deepEqual(disk.results[A].earned,{numerator:"1",denominator:"8"});
  assert.equal(disk.series[P+"/"+D].officialAttemptId,A);
  assert.ok(f.pool.events.indexOf("ua_people_lock")<f.pool.events.indexOf("ua_clock"));
});
test("work/write failure rolls back every row and concurrent stale answer CAS has a single winner",async(t)=>{
  const f=await setup(t),before=readFileSync(f.path,"utf8");f.pool.failStatement="ua_series_update";
  await assert.rejects(f.command(save(0)));assert.equal(readFileSync(f.path,"utf8"),before);
  const both=await Promise.allSettled([f.command(save(0)),f.command(save(0))]);
  assert.equal(both.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(f.pool.read().answers[A][Q].revision,1);
});
test("COMMIT loss returns no ACK, never automatically retries, and reconciliation distinguishes committed/not committed",async(t)=>{
  for(const failure of ["before","after"]){const f=await setup(t);f.pool.failCommit=failure;
    await assert.rejects(f.command(save(0)),e=>e instanceof StorageUnavailable&&e.outcome==="commit_unknown"&&e.status===503);
    assert.equal(f.pool.releasedDiscard,true);assert.equal(f.pool.events.filter(e=>e==="ua_commit").length,1);
    assert.equal(!!f.pool.read().answers[A]?.[Q],failure==="after");}
});
test("terminal submit is idempotent and does not overwrite exact ordinary result or deadline",async(t)=>{
  const f=await setup(t);await f.command(save(0));const first=await f.command((r,now)=>submitAttempt(access,r,current,now));
  const disk=f.pool.read();assert.equal(first.ok,true);
  assert.deepEqual(await f.command((r,now)=>submitAttempt(access,r,current,now)),first);assert.deepEqual(f.pool.read(),disk);
});
test("successful login replaces one active family while failed identity/replay/write leaves answers and active family intact",async(t)=>{
  const f=await setup(t);await f.command(save(0));const original=f.pool.read().attempts[A];
  await assert.rejects(f.runner.run([P],tx=>f.sessions.loginExisting(tx,{...login(1),telegramUserId:4000000099})));
  assert.equal(f.pool.read().families[F].revoked_at_ms,null);
  const initial=readFileSync(f.path,"utf8");f.pool.failStatement="ua_access_insert";
  await assert.rejects(f.runner.run([P],tx=>f.sessions.loginExisting(tx,login(1))));
  assert.equal(readFileSync(f.path,"utf8"),initial);
  await f.runner.run([P],tx=>f.sessions.loginExisting(tx,login(1)));
  await assert.rejects(f.command(save(1)),e=>e.code==="SESSION_REVOKED");
  assert.equal((await f.command(save(1),login(1).accessDigest)).ok,true);
  const before=readFileSync(f.path,"utf8");await assert.rejects(f.runner.run([P],tx=>f.sessions.loginExisting(tx,login(1))),e=>e.code==="INIT_DATA_REPLAY");
  assert.equal(readFileSync(f.path,"utf8"),before);
  assert.equal(f.pool.read().attempts[A].body.deadlineAt,original.body.deadlineAt);
  const active=Object.values(f.pool.read().families).filter(x=>x.revoked_at_ms===null);assert.equal(active.length,1);
  const raw="synthetic-raw-proof-not-to-persist";const hashed=await proofHash(raw);assert.equal(hashed.length,64);assert.ok(!readFileSync(f.path,"utf8").includes(raw));
});
test("login/refresh/save order preserves saved work; revoked old refresh cannot touch a newer family",async(t)=>{
  const f=await setup(t);await f.command(save(0));
  const refreshed=await f.runner.run([P],tx=>f.sessions.refresh(tx,P,hash(2),{accessDigest:hash(10),refreshDigest:hash(11),accessExpiresAt:90000,logoutRetainUntil:150000}));assert.equal(refreshed.ok,true);
  await f.runner.run([P],tx=>f.sessions.loginExisting(tx,login(2)));
  const before=readFileSync(f.path,"utf8");
  await assert.rejects(f.runner.run([P],tx=>f.sessions.refresh(tx,P,hash(2),{accessDigest:hash(12),refreshDigest:hash(13),accessExpiresAt:90000,logoutRetainUntil:150000})),e=>e.code==="SESSION_REVOKED");
  assert.equal(readFileSync(f.path,"utf8"),before);
  const race=await Promise.allSettled([f.runner.run([P],tx=>f.sessions.loginExisting(tx,login(3))),f.command(save(1),login(2).accessDigest)]);
  assert.equal(race[0].status,"fulfilled");assert.equal(race[1].status,"rejected");assert.equal(f.pool.read().answers[A][Q].revision,1);
});
test("refresh replay commits revocation only for its family and no raw proof or fractional revision is accepted",async(t)=>{
  const f=await setup(t);const next={accessDigest:hash(10),refreshDigest:hash(11),accessExpiresAt:90000,logoutRetainUntil:150000};
  await f.runner.run([P],tx=>f.sessions.refresh(tx,P,hash(2),next));
  const reused=await f.runner.run([P],tx=>f.sessions.refresh(tx,P,hash(2),{...next,accessDigest:hash(12),refreshDigest:hash(13)}));
  assert.deepEqual(reused,{ok:false,code:"REFRESH_REUSED"});assert.equal(f.pool.read().families[F].revoked_at_ms,10000);
  await assert.rejects(f.runner.run([P],tx=>f.sessions.authorize(tx,P,"raw-token")),e=>e.code==="SESSION_REVOKED");
  const g=await setup(t);await assert.rejects(g.command(save(0.1)),e=>e.code==="VALIDATION_ERROR");
});
test("foreign scope and mutated frozen deadline/generation are denied before any persistent change",async(t)=>{
  const f=await setup(t),disk=readFileSync(f.path,"utf8");
  await assert.rejects(f.runner.run([P],tx=>f.repo.load(tx,id(999),A)),e=>e.code==="NOT_FOUND");
  for(const mutate of [r=>({...r,deadlineAt:r.deadlineAt+1}),r=>({...r,generation:r.generation+1}),
    r=>({...r,stateRevision:Number.MAX_SAFE_INTEGER+1})])
    await assert.rejects(f.runner.run([P],async tx=>{const before=await f.repo.load(tx,P,A);const next=save(0)(before,tx.now).record;
      await f.repo.persist(tx,before,mutate(next));}),e=>e.code==="RESPONSE_INVARIANT_FAILED");
  assert.equal(readFileSync(f.path,"utf8"),disk);
});
test("changed current series rolls back attempted answer/result writes and cannot restore an old generation",async(t)=>{
  const f=await setup(t);const changed=f.pool.read();changed.series[P+"/"+D].currentAttemptId=id(999);durableWrite(f.path,changed);
  const before=readFileSync(f.path,"utf8");await assert.rejects(f.command(save(0)),e=>e.code==="ATTEMPT_SUPERSEDED");
  assert.equal(readFileSync(f.path,"utf8"),before);
});
test("person locks are unique/sorted and DB integer text is rejected instead of silently rounded",async(t)=>{
  const f=await setup(t),disk=f.pool.read();disk.people[id(2)]={telegram_id:4000000002,enabled:true,roles:["student"]};durableWrite(f.path,disk);
  await f.runner.run([id(2),P,id(2)],async tx=>assert.deepEqual(tx.personIds,[P,id(2)]));
  await f.command(save(0));const changed=f.pool.read();changed.answers[A][Q].revision="9007199254740993";durableWrite(f.path,changed);
  await assert.rejects(f.runner.run([P],tx=>f.repo.load(tx,P,A)),e=>e.code==="RESPONSE_INVARIANT_FAILED");
});
test("known invalid storage configuration is native503, while unexpected work errors retain their identity",async(t)=>{
  for(const pool of [undefined,{}, {connect:1},{connect:async()=>({query:1,release(){}})}])
    await assert.rejects(new PostgresTransactions(pool).run([P],async()=>assert.fail("must not execute")),e=>e.code==="SERVICE_UNAVAILABLE"&&e.status===503);
  const f=await setup(t),unexpected=Error("synthetic handler failure");
  await assert.rejects(f.runner.run([P],async()=>{throw unexpected;}),e=>e===unexpected);
});
