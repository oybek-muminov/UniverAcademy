/** Local disposable native PostgreSQL only. Never accepts a remote database URL. */
import EmbeddedPostgres from '../account-deletion/tooling/node_modules/embedded-postgres/dist/index.js';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
for(const test of ['native-atomic.test.mjs']){
const root=await mkdtemp(join(tmpdir(),'ua-delete-native-'));
const password=randomBytes(24).toString('hex');
const port=55435;
const server=new EmbeddedPostgres({databaseDir:join(root,'data'),user:'postgres',password,port,persistent:false,
  postgresFlags:['-c','unix_socket_directories=','-c','listen_addresses=127.0.0.1'],onLog:()=>{},onError:()=>{}});
let started=false;
try{
  await server.initialise();await server.start();started=true;
  const child=spawn(process.execPath,['--test','tests/telegram-entry/'+test],{stdio:'inherit',env:{...process.env,UA_SCHEMA_NATIVE_URL:`postgresql://postgres:${password}@127.0.0.1:${port}/postgres`}});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  process.exitCode=typeof code==='number'?code:1;
}finally{if(started)await server.stop();}

if(process.exitCode)break;
}
