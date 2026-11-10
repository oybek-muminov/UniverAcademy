import {test} from "node:test";
import assert from "node:assert/strict";
import {clerkFixture,users,sids} from "./fixture.mjs";
import {staffIds,versionBody} from "../backend/staff-fixture.ts";

async function staffPair(role){
  const f=await clerkFixture(),userId=users[role],first=`sess_${role}ParallelFirstA1`,second=`sess_${role}ParallelSecondB2`;
  f.activate(userId,first);const a=await f.sign({userId,sessionId:first});
  const call=token=>f.call("PATCH",`/admin/versions/${staffIds.draft}`,versionBody(),token,{"idempotency-key":"parallel-"+role});
  assert.equal((await call(a)).status,200);
  f.activate(userId,second);const b=await f.sign({userId,sessionId:second});
  return{f,a,b,call,first,second,userId};
}

test("teacher/Admin/Owner can authenticate a second provider session without revoking the first or creating student fences",async()=>{
  for(const role of ["teacher","admin","owner"]){
    const {f,a,b,call,first,second}=await staffPair(role),before=f.snapshot();
    assert.equal((await call(b)).status,200);assert.equal((await call(a)).status,200);
    assert.deepEqual(f.store.state,before);assert.equal(f.live.get(first).status,"active");assert.equal(f.live.get(second).status,"active");
    assert.deepEqual(f.store.state.studentSessions,{});assert.deepEqual(f.store.state.domain.student.families,{});
    // The student exchange is not a staff login endpoint or an identity linker.
    assert.equal((await f.exchange(b)).status,403);assert.deepEqual(f.store.state,before);
  }
});

test("parallel staff authentication still checks each session's liveness and the current role/approval/capability/subject scope before receipt replay",async()=>{
  for(const role of ["teacher","admin","owner"]){
    const {f,a,b,call,first,userId}=await staffPair(role);
    f.live.get(first).status="revoked";const pinned=f.snapshot();
    assert.equal((await call(a)).status,401);assert.equal((await call(b)).status,200);assert.deepEqual(f.store.state,pinned);
    for(const change of [s=>{s.domain.staff[userId].approved=false;},s=>{s.domain.staff[userId].enabled=false;},
      s=>{s.domain.student.people[staffIds[role]].profile.roles=["student"];}]){
      const saved=f.snapshot();change(f.store.state);const denied=f.snapshot();
      assert.equal((await call(b)).status,403);assert.deepEqual(f.store.state,denied);f.store.state=saved;
    }
    if(role!=="owner"){
      const saved=f.snapshot();
      if(role==="admin")f.store.state.domain.staff[userId].scope.subject_ids=[];
      else f.store.state.domain.staff[userId].approvedSubjectIds=[];
      const denied=f.snapshot();assert.equal((await call(b)).status,404);assert.deepEqual(f.store.state,denied);f.store.state=saved;
      if(role==="admin"){
        f.store.state.domain.staff[userId].capabilities.manage_content=false;const deniedCapability=f.snapshot();
        assert.equal((await call(b)).status,404);assert.deepEqual(f.store.state,deniedCapability);
      }
    }
  }
});

test("only a new successful student login supersedes its old app family; staff sessions and attempt history remain independent",async()=>{
  const {f,a,b,call}=await staffPair("admin");f.activate(users.student,sids.first);
  const old=(await f.exchange(await f.sign())).json.data;
  f.activate(users.student,sids.second);const current=(await f.exchange(await f.sign({sessionId:sids.second}))).json.data;
  await assert.rejects(f.client.me(old.access_token),e=>e.status===401);
  assert.equal((await f.client.me(current.access_token)).data.person_id,old.profile.person_id);
  const before=f.snapshot();assert.equal((await call(a)).status,200);assert.equal((await call(b)).status,200);assert.deepEqual(f.store.state,before);
  assert.equal(Object.values(f.store.state.domain.student.families).filter(x=>x.revokedAt===null).length,1);
});
