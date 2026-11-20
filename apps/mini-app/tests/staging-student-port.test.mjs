import test from 'node:test';
import assert from 'node:assert/strict';
import {createStagingStudentPort} from '../src/staging-student-port.ts';
import {nextScheduleDelay,openingLabel} from '../src/group-test-schedule.mjs';
import {StudentFailure} from '../src/transport.ts';
const api = 'https://api.example.org/api/v1';
function harness(fetcher) {
  let person = 'student-one';
  const requests=[];
  const port = createStagingStudentPort({baseUrl:api,person,current:()=>person,access:async fn=>fn('opaque-test'),
    fetcher:async request=>{requests.push(request);return fetcher(request);}});
  return {port,requests,change(){person='student-two'}};
}
test('the staged dashboard and commands use the original student proof and carry no chosen actor',async()=>{
  const h=harness(async req => {
    assert.equal(req.headers.get('Authorization'),'Bearer opaque-test');
    assert.equal(req.credentials,'omit'); assert.equal(req.redirect,'error');
    if(req.method==='GET')return Response.json({data:{role:'student',person_id:'student-one',group:null,assignments:[],results:[]}});
    assert.equal(req.headers.get('Idempotency-Key'),'the-same-retry-key');
    assert.deepEqual(await req.json(),{token:'grp_token'});
    return Response.json({data:{id:'g',name:'Fizika'}});
  });
  await h.port.dashboard();
  assert.deepEqual(await h.port.command('acceptInvite',{token:'grp_token'},'the-same-retry-key'),{id:'g',name:'Fizika'});
  assert.deepEqual(h.requests.map(r=>r.url),[api+'/student/pilot/dashboard',api+'/student/pilot/commands/acceptInvite']);
  h.change(); await assert.rejects(h.port.dashboard(),{code:'ACCESS_SUPERSEDED'});assert.equal(h.requests.length,2);
});
test('cross-account dashboards, unknown routes and media outside the active scoped resource are rejected',async()=>{
  const h=harness(async()=>Response.json({data:{role:'student',person_id:'student-two',assignments:[],results:[]}}));
  await assert.rejects(h.port.dashboard(),{code:'RESPONSE_INVARIANT_FAILED'});
  assert.throws(()=>h.port.command('../admin',{},'key'),StudentFailure);
  for(const url of ['https://elsewhere.example/diagram','/api/v1/teacher/pilot/media/img','/api/v1/student/pilot/media/img?secret=x']) {
    await assert.rejects(h.port.media({asset:{asset_id:'img',url}},new AbortController().signal));
  }
  assert.equal(h.requests.length,1);
  const media=harness(async req=>{
    assert.equal(req.headers.get('authorization'),'Bearer opaque-test');
    return new Response(new Uint8Array([1,2]),{headers:{'content-type':'image/png'}});
  });
  const blob=await media.port.media({asset:{asset_id:'img',url:'/api/v1/student/pilot/media/img'}},new AbortController().signal);
  assert.equal(blob.type,'image/png');assert.equal(blob.size,2);
});


test('scheduled group tests use the server clock and show the opening time in Tashkent',async()=>{
  const opensAt=Date.UTC(2026,10,21,19,30), closesAt=opensAt+86_400_000, serverNow=opensAt-30000;
  const entry={id:'exam',title:'Fizika',status:'scheduled',attemptId:null,opensAt,closesAt};
  const response=row=>Response.json({data:{role:'student',person_id:'student-one',group:null,serverNow,assignments:[row],results:[]}});
  const dashboard=await harness(()=>response(entry)).port.dashboard();
  assert.match(openingLabel(opensAt),/00:30/);
  assert.equal(nextScheduleDelay(dashboard,10000),20050);
  assert.equal(nextScheduleDelay({...dashboard,assignments:[{...entry,status:'closed'}]},0),null);
  await assert.rejects(harness(()=>response({...entry,opensAt:null})).port.dashboard(),{code:'RESPONSE_INVARIANT_FAILED'});
  await assert.rejects(harness(()=>response({...entry,closesAt:opensAt-1})).port.dashboard(),{code:'RESPONSE_INVARIANT_FAILED'});
  assert.equal((await harness(()=>response({id:'old',title:'Avvalgi test',status:'available',attemptId:null})).port.dashboard()).assignments.length,1);
});
