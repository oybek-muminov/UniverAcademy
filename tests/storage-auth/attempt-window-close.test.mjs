import {test} from "node:test";
import assert from "node:assert/strict";
import {startAttempt,studentView,saveAnswer} from "../../supabase/functions/univeracademy-api/attempts.ts";

// Oyna tugashi: test "boshlanishdan 90 daqiqa" va "oyna tugashi"dan qaysi biri oldin kelsa, shu payt yopiladi.
const id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const P=id(1),J=id(10),D=id(20),G=id(40),Q=id(100),O=id(200);
const MIN=60000,DURATION=90*MIN,OPEN=Date.UTC(2026,10,5,12);
const published={demoId:D,versionId:id(30),durationMs:DURATION,individualEnabled:false,
  questions:[{id:Q,optionIds:[O,id(201),id(202),id(203)],correctOptionId:O,individualPoints:{numerator:1n,denominator:1n}}]};
const access={proofKind:"student_session",personId:P,enabled:true,assignmentIds:[J]};
const begin=(now,closesAt)=>startAttempt({access,published,existing:null,id:id(900),confirmed:true,now,
  admission:{assignmentId:J,groupId:G,activeGroupId:G,rostered:true,profileComplete:true,membershipEpoch:1,grantEpoch:1,opensAt:OPEN,closesAt}});

test("oyna yetarlicha keng: tugash vaqti = boshlash + 90 daqiqa",()=>{
  const record=begin(OPEN,OPEN+10*DURATION);assert.equal(record.deadlineAt,OPEN+DURATION);
});
test("oyna 10 daqiqadan keyin tugaydi: test oyna oxirida yopiladi, 90 daqiqa berilmaydi",()=>{
  const closes=OPEN+100*MIN,record=begin(OPEN+90*MIN,closes);assert.equal(record.deadlineAt,closes);
});
test("oyna aynan 90 daqiqada tugasa: ikkala qoida bir xil",()=>{
  assert.equal(begin(OPEN,OPEN+DURATION).deadlineAt,OPEN+DURATION);
});
test("oyna tugashiga 1 soniya qolganda boshlash mumkin, tugash vaqti kelajakda",()=>{
  const closes=OPEN+MIN,record=begin(closes-1000,closes);assert.equal(record.deadlineAt,closes);assert.ok(record.deadlineAt>closes-1000);
});
test("oyna yopilgan paytda boshlash oldingidek rad etiladi",()=>{
  assert.throws(()=>begin(OPEN+MIN,OPEN+MIN),e=>e.code==="ADMISSION_CLOSED");
  assert.throws(()=>begin(OPEN+2*MIN,OPEN+MIN),e=>e.code==="ADMISSION_CLOSED");
});
test("oyna tugagach javob saqlash qabul qilinmaydi va test o'zi yopiladi",()=>{
  const closes=OPEN+100*MIN,record=begin(OPEN+90*MIN,closes);
  const current={id:record.id,generation:1};
  const before=saveAnswer(access,record,current,Q,{selected_option_id:O,expected_revision:0},closes-1);
  assert.equal(before.response.ok,true);
  const after=saveAnswer(access,before.record,current,Q,{selected_option_id:null,expected_revision:1},closes);
  assert.equal(after.response.ok,false);assert.equal(after.response.error.code,"ATTEMPT_EXPIRED");
  assert.equal(after.record.status,"expired");assert.equal(after.record.completedAt,closes);
  assert.equal(studentView(access,after.record,current,closes+1).response.value.status,"expired");
});
