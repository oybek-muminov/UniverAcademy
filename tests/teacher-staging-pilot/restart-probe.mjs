// A separate Node process, database connection and router have no access to the first process's state.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createLocalJWKSet } from 'jose';
import { createTeacherStagingApi } from '../../runtime/teacher-staging-api.mjs';
import { issuer,party } from './credentials.mjs';
import { apiOrigin,good,routes,studentOrigin } from './requests.mjs';
const input=JSON.parse(readFileSync(0,'utf8'));
if(new URL(input.database).hostname!=='127.0.0.1') throw Error('Disposable local database required.');
const pool=new pg.Pool({connectionString:input.database,max:1});
try {
  const sessions=new Map(input.auth.sessions);
  const api=createTeacherStagingApi({
    enabled:true,pool,teacherOrigin:party,studentOrigin,apiOrigin,allowLegacyTelegram:true,
    verifier:{issuer,authorizedParties:[party],audience:{kind:'clerk_default_no_audience'},
      trustedKeys:createLocalJWKSet({keys:[input.auth.jwk]}),now:Date.now},
    liveness:async ({sessionId})=>sessions.get(sessionId)
  });
  const actor=routes(api,'student',input.token);
  const resumed=await good(actor.command('resumeAttempt',{attemptId:input.attempt}));
  process.stdout.write(JSON.stringify({id:resumed.id,answers:resumed.answers}));
} finally {await pool.end();}
