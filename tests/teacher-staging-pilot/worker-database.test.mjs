import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import {createWorkerCabinetHandler} from '../../runtime/cloudflare-cabinet.mjs';
import {createTeacherStagingApi} from '../../runtime/teacher-staging-api.mjs';
import {createCluster,createServiceLogin} from './cluster.mjs';
import {issuer,party,provisionStaff,provisionStudent,testClerk} from './credentials.mjs';
import {apiOrigin,good,rejected,routes,studentOrigin} from './requests.mjs';

test('Worker request adapter verifies signed staff, live bound student and least-privileged real PostgreSQL login', {timeout:90000},async()=>{
  const c=await createCluster();
  try {
    await c.admin.query(await readFile(new URL('../../supabase/migrations/teacher-staging/up.sql',import.meta.url),'utf8'));
    const authGrant={role:'ua_api_login',inherit:true,set:false};
    const dburl=await createServiceLogin(c,'qa_cabinet_worker',[authGrant,{role:'ua_cabinet_stage',inherit:false,set:true}]);
    const registrationUrl=await createServiceLogin(c,'qa_wrong_cabinet_worker',[authGrant]);
    const clerk=await testClerk(),teacher=await provisionStaff(c.admin,'Teacher','teacher');
    const student=await provisionStudent(c.admin,'Student','0100000031',777101,{clerk});
    const token=await clerk.sign(teacher.subject),otherParty=await clerk.sign(teacher.subject,{azp:studentOrigin});
    const {jwk,sessions}=clerk.publicConfiguration(),models=new Map(sessions),inactive=new Set(),observed=[];
    const settings=JSON.stringify({issuer,authorizedParties:[studentOrigin],audience:{kind:'clerk_default_no_audience'},
      jwksCacheMs:300000,jwksCooldownMs:0,timeoutMs:2000,maxJwksBytes:65536});
    const env={UA_CABINET_RUNTIME:'worker',UA_CABINET_STAGING_ENABLED:'true',UA_API_ORIGIN:apiOrigin,
      UA_CABINET_TEACHER_ORIGIN:party,UA_CABINET_STUDENT_ORIGIN:studentOrigin,UA_CLERK_PROVIDER_SETTINGS:settings,
      UA_CLERK_SECRET_KEY:'loopback-worker-clerk-fixture',CABINET_HYPERDRIVE:{connectionString:dburl}};
    let opened=0,closed=0,watchPersonLock;
    class Client extends pg.Client {
      async connect(){await super.connect();opened++;}
      async end(){await super.end();closed++;}
      query(statement,...args){
        const result=super.query(statement,...args);
        if(statement?.text?.includes('ua_private.lock_people('))watchPersonLock?.();
        return result;
      }
    }
    async function transport(request){
      const url=new URL(request.url);
      observed.push(url.pathname);
      if(url.origin===issuer) {
        assert.equal(url.pathname,'/.well-known/jwks.json');assert.ok(!request.headers.has('authorization'));
        return Response.json({keys:[jwk]});
      }
      assert.equal(url.origin,'https://api.clerk.com');
      assert.equal(request.headers.get('authorization'),'Bearer '+env.UA_CLERK_SECRET_KEY);
      const [,version,kind,id]=url.pathname.split('/');assert.equal(version,'v1');
      if(kind==='sessions'){
        const s=models.get(id);assert.ok(s);
        return Response.json({id,user_id:s.userId,status:inactive.has(id)?'revoked':s.status,expire_at:s.expiresAt,abandon_at:s.expiresAt,actor:null});
      }
      assert.equal(kind,'users');assert.ok([...models.values()].some(s=>s.userId===id));
      return Response.json({id,banned:false,locked:false,deprovisioned:false});
    }
    const handler=createWorkerCabinetHandler({loadClient:async()=>Client,transport,createApi:createTeacherStagingApi});
    const api=(binding=env)=>({fetch:req=>handler.fetch(req,binding)});
    const t=routes(api(),'teacher',token), s=routes(api(),'student',student.token);
    assert.equal((await good(t.dashboard())).person_id,teacher.id);
    const group=await good(t.command('createGroup',{name:'Worker physics',subjectId:'physics'}));
    assert.equal(group.status,'pending');
    assert.equal((await good(s.dashboard())).person_id,student.id);
    await rejected(routes(api(),'teacher',otherParty).dashboard(),401);
    await rejected(routes(api(),'admin',token).dashboard());
    inactive.add(student.sessionId);
    await rejected(s.dashboard(),401);
    for(const connectionString of [registrationUrl,c.adminUrl]){
      const wrong=routes(api({...env,CABINET_HYPERDRIVE:{connectionString}}),'teacher',token);
      await rejected(wrong.command('createGroup',{name:'Denied',subjectId:'physics'}),503);
    }
    // Disconnect while the authorized staff transaction is waiting for its actor's
    // row. It must close the physical client and never acknowledge the mutation.
    const disconnect=new AbortController(), waiting=Promise.withResolvers();
    await c.admin.query('BEGIN');
    try{
      await c.admin.query('SELECT id FROM ua_private.people WHERE id=$1 FOR UPDATE',[teacher.id]);
      watchPersonLock=waiting.resolve;
      const reply=handler.fetch(new Request(party+'/api/v1/teacher/pilot/commands/createGroup',{
        method:'POST',headers:{origin:party,authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'cancelled-write'},
        body:JSON.stringify({name:'Interrupted',subjectId:'physics'}),signal:disconnect.signal
      }),env);
      await waiting.promise;
      disconnect.abort();
      await rejected(reply,503);
    }finally{
      watchPersonLock=undefined;
      await c.admin.query('ROLLBACK');
    }
    assert.equal((await c.admin.query('SELECT count(*)::int AS n FROM ua_cabinet.group_requests')).rows[0].n,1);
    assert.equal(env.UA_CLERK_PROVIDER_SETTINGS,settings);
    assert.ok(observed.includes('/.well-known/jwks.json'));
    assert.ok(observed.includes('/v1/sessions/'+student.sessionId));
    assert.ok(opened>=7);assert.equal(opened,closed);
  }finally{await c.close();}
});
