import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from '../account-deletion/tooling/node_modules/embedded-postgres/dist/index.js';
import { nativeFixture } from '../telegram-entry/native-fixture.mjs';
import { expand } from '../../supabase/migrations/cabinet-id/migrate.mjs';

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// The tests supply no external URL. Each run initializes a brand-new native cluster.
export async function createCluster() {
  const host = '127.0.0.1', port = await availablePort();
  const root = await mkdtemp(join(tmpdir(), 'ua-teacher-stage-'));
  const password = randomBytes(32).toString('hex');
  const adminUrl = 'postgresql://postgres:' + password + '@' + host + ':' + port + '/postgres';
  const logNativeError = line => {
    if (process.env.UA_STAGING_TEST_DB_ERRORS === '1' && /ERROR:|FATAL:/.test(line)) {
      console.error(String(line).split('\n').find(value=>/ERROR:|FATAL:/.test(value)));
    }
  };
  const server = new EmbeddedPostgres({
    databaseDir:join(root, 'pg'), user:'postgres', password, port, persistent:false,
    postgresFlags:['-c','unix_socket_directories=', '-c','listen_addresses=127.0.0.1','-c','log_error_verbosity=verbose'],
    onLog:logNativeError, onError:logNativeError
  });
  let started = false, capture;
  async function close() {
    try { await capture?.close(); }
    finally {
      try { if (started) await server.stop(); }
      finally { await rm(root, {recursive:true,force:true}); }
    }
  }
  try {
    await server.initialise();
    await server.start();
    started = true;
    capture = await nativeFixture({ url:adminUrl });
    await expand(capture.admin);
    return { admin:capture.admin, adminUrl, installDeletion:capture.installDeletion, close };
  } catch (error) { await close(); throw error; }
}

export async function addProfile(admin, {name,role,cabinetId=null,telegramId=null}) {
  const id = randomUUID();
  const profile={person_id:id,first_name:name,last_name:'Sinov',roles:[role],registration_complete:true,
    active_group_id:null,univeracademy_id:cabinetId};
  await admin.query('BEGIN');
  try {
    await admin.query(`INSERT INTO ua_private.people_registration(id,telegram_id,univeracademy_id,enabled,roles,profile)
      VALUES ($1,$2,$3,true,$4,$5)`,[id,telegramId,cabinetId,[role],profile]);
    await admin.query(`INSERT INTO ua_private.memberships(person_id,active,revision,epoch)
      VALUES ($1,false,0,0)`,[id]);
    await admin.query('COMMIT');
  } catch (error) {await admin.query('ROLLBACK'); throw error;}
  return id;
}

export async function createServiceLogin(cluster, role, grants) {
  const password = randomBytes(32).toString('hex');
  const ddl = await cluster.admin.query(
    "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER PASSWORD %L',$1::text,$2::text) AS command",
    [role,password]
  );
  await cluster.admin.query(ddl.rows[0].command);
  for (const grant of grants) {
    const row = await cluster.admin.query("SELECT format('GRANT %I TO %I WITH INHERIT %s, SET %s', $1::text, $2::text,$3::text,$4::text) command",
      [grant.role,role,grant.inherit?'TRUE':'FALSE',grant.set?'TRUE':'FALSE']);
    await cluster.admin.query(row.rows[0].command);
  }
  const url = new URL(cluster.adminUrl);
  url.username = role;
  url.password = password;
  return url.href;
}
