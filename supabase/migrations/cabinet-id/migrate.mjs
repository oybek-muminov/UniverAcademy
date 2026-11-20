import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const previous = 'qadam_id';
const current = 'univeracademy_id';
const people = 'ua_private.people';
const profileShape = 'people_profile_shape';
const policies = ['registration_people_insert', 'registration_profile_update'];

async function transaction(client, work) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL row_security = on; SET LOCAL search_path = pg_catalog");
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function databaseState(client) {
  const { rows } = await client.query(`
    SELECT attname FROM pg_attribute WHERE attrelid = 'ua_private.people'::regclass
    AND attname IN ($1,$2) AND NOT attisdropped AND atttypid = 'text'::regtype
  `, [previous, current]);
  if (rows.length !== 1) throw Error('Expected exactly one text cabinet ID column');
  return rows[0].attname;
}

async function checkBridge(client, expected) {
  const { rows } = await client.query(`
    SELECT pg_get_triggerdef(t.oid) AS definition,
      'security_invoker=true' = ANY(v.reloptions) AS invoker,
      pg_catalog.has_column_privilege('ua_runtime',v.oid,'univeracademy_id','INSERT') AS can_insert
    FROM pg_trigger t CROSS JOIN pg_class v
    WHERE t.tgrelid='ua_private.people'::regclass AND t.tgname='normalize_cabinet_profile'
      AND t.tgenabled='O' AND v.oid=to_regclass('ua_private.people_registration') AND v.relkind='v'
  `);
  const source = expected === current ? previous : current;
  if (rows.length !== 1 || !rows[0].invoker || !rows[0].can_insert ||
      !rows[0].definition.includes(`('${expected}', '${source}')`)) {
    throw Error('Cabinet ID bridge or phase differs from the expected schema');
  }
}

export async function expand(client) {
  const sql = await readFile(new URL('./expand.sql', import.meta.url), 'utf8');
  await transaction(client, async () => {
    await client.query(`LOCK TABLE ${people} IN SHARE ROW EXCLUSIVE MODE`);
    const installed = (await client.query("SELECT to_regclass('ua_private.people_registration') AS name")).rows[0].name;
    const phase = await databaseState(client);
    if (!installed) {
      if (phase !== previous) throw Error('Expected original cabinet ID before expand');
      await client.query(sql);
    }
    await checkBridge(client, phase);
  });
}

function changeProfileKey(expression, source, destination) {
  // PostgreSQL has already rewritten physical column references. Only the JSON
  // literal changes; all authorization predicates and shape checks are retained.
  const literal = "'" + source + "'";
  if (!expression?.includes(literal)) throw Error('Unrecognized profile predicate');
  return expression.replaceAll(literal, "'" + destination + "'");
}

export async function switchPhase(client, direction) {
  if (!['forward','rollback'].includes(direction)) throw Error('Unknown direction');
  const [source,destination] = direction === 'forward' ? [previous,current] : [current,previous];
  await transaction(client, async () => {
    await client.query(`LOCK TABLE ${people} IN ACCESS EXCLUSIVE MODE`);
    const phase = await databaseState(client);
    await checkBridge(client, phase);
    if (phase === destination) return;
    await client.query(`ALTER TABLE ${people} RENAME COLUMN ${source} TO ${destination}`);
    for (const suffix of ['key','check']) {
      await client.query(`ALTER TABLE ${people} RENAME CONSTRAINT people_${source}_${suffix} TO people_${destination}_${suffix}`);
    }
    // ADD NOT VALID avoids scanning or rewriting the table under the DDL lock.
    const { rows: checks } = await client.query(`SELECT pg_get_expr(conbin,conrelid) AS expr FROM pg_constraint
      WHERE conrelid='ua_private.people'::regclass AND conname=$1 AND contype='c'`, [profileShape]);
    const shape = changeProfileKey(checks[0]?.expr, source, destination);
    await client.query(`ALTER TABLE ${people} DROP CONSTRAINT ${profileShape},
      ADD CONSTRAINT ${profileShape} CHECK (${shape}) NOT VALID`);
    for (const name of policies) {
      const { rows } = await client.query(`SELECT pg_get_expr(polwithcheck,polrelid) AS expr FROM pg_policy
        WHERE polrelid='ua_private.people'::regclass AND polname=$1`, [name]);
      const predicate = changeProfileKey(rows[0]?.expr, source, destination);
      await client.query(`ALTER POLICY ${name} ON ${people} WITH CHECK (${predicate})`);
    }
    await client.query(`CREATE OR REPLACE TRIGGER normalize_cabinet_profile BEFORE INSERT OR UPDATE ON ${people}
      FOR EACH ROW EXECUTE FUNCTION ua_private.normalize_cabinet_profile('${destination}', '${source}')`);
    await checkBridge(client, destination);
  });
}

export async function backfill(client, batchSize = 500) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw Error('Batch size must be 1–5000');
  if ((await client.query("SELECT pg_catalog.row_security_active('ua_private.people'::regclass) AS filtered")).rows[0].filtered) {
    throw Error('Backfill requires a maintenance connection with full visibility of people');
  }
  const destination = await databaseState(client);
  const source = destination === current ? previous : current;
  let cursor = null;
  let updated = 0;
  for (;;) {
    const batch = await transaction(client, async () => {
      // Blocks a phase switch only for this batch, never an entire table scan.
      await client.query(`LOCK TABLE ${people} IN ROW EXCLUSIVE MODE`);
      if (await databaseState(client) !== destination) throw Error('Phase changed during backfill');
      await checkBridge(client, destination);
      const result = await client.query(`
        WITH page AS MATERIALIZED (
          SELECT id FROM ua_private.people WHERE ($1::uuid IS NULL OR id > $1)
          ORDER BY id LIMIT $2
        ), changed AS (
          UPDATE ua_private.people p SET profile=p.profile FROM page
          WHERE p.id=page.id AND p.profile ? $3::text RETURNING p.id
        ) SELECT (SELECT id FROM page ORDER BY id DESC LIMIT 1) AS last, (SELECT count(*)::int FROM changed) AS changed
      `, [cursor, batchSize, source]);
      return result.rows[0];
    });
    updated += batch.changed;
    if (!batch.last) break;
    cursor = batch.last;
  }
  await transaction(client, async () => {
    await client.query(`LOCK TABLE ${people} IN SHARE UPDATE EXCLUSIVE MODE`);
    if (await databaseState(client) !== destination) throw Error('Phase changed before validation');
    await checkBridge(client, destination);
    await client.query(`ALTER TABLE ${people} VALIDATE CONSTRAINT ${profileShape}`);
    const remaining = await client.query(`SELECT 1 FROM ${people} WHERE profile ? $1::text LIMIT 1`, [source]);
    if (remaining.rowCount) throw Error('Legacy profile keys remain after validation');
  });
  return updated;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv[2];
  if (!['expand','forward','rollback','backfill'].includes(action)) {
    throw Error('Usage: node migrate.mjs expand|forward|rollback|backfill');
  }
  const client = new pg.Client();
  await client.connect();
  try {
    if (action === 'expand') await expand(client);
    else if (action === 'backfill') console.log('Profiles converted:', await backfill(client));
    else await switchPhase(client, action);
  } finally {
    await client.end();
  }
}
