// Render offline; this entry point does not connect to a database.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const pins={
  up:'4b7a5a0a50f980cbe8fec0c470a5d2453eb074d806dea96ea6bc0f2548c12fe9',
  down:'d4d77f5a75c8e41b13b76c82b91f952cb81032b84a27595d90b0dedfecd60f86'
};
function insertBefore(text,anchor,addition){
  if(text.split(anchor).length!==2)throw Error('Unexpected installation boundary');
  return text.replace(anchor,()=>addition+'\n'+anchor);
}
export async function renderManagedCabinet(operation){
  if(!['up','restore','down'].includes(operation))throw Error('Expected up, down, or restore');
  const source=operation==='down'?'down':'up';
  const read=name=>readFile(new URL(name,import.meta.url),'utf8');
  const [sql,before,after]=await Promise.all([read(source+'.sql'),read('managed-before.sql.in'),read('managed-after.sql.in')]);
  if(createHash('sha256').update(sql).digest('hex')!==pins[source])throw Error('Review managed role windows against the changed base migration');
  const begin="BEGIN;\n";
  const operationSql="SET LOCAL ua.cabinet_operation='"+operation+"';\n";
  let rendered=sql.replace(begin,()=>begin+operationSql+before+(operation==='up'?'':'SET LOCAL ROLE ua_owner;\n'));
  if(operation==='up'){
    rendered=insertBefore(rendered,'COMMENT ON SCHEMA ua_cabinet',
      'ALTER SCHEMA ua_cabinet OWNER TO ua_owner;\nSET LOCAL ROLE ua_owner;');
  }
  rendered=insertBefore(rendered,"DO $$ BEGIN\n IF to_regprocedure('ua_private.assert_deletion_writable(text,jsonb)')",
    'SET LOCAL ROLE ua_deletion_executor;');
  if(operation==='down')rendered=insertBefore(rendered,'REVOKE EXECUTE ON FUNCTION ua_private.ratio_shape','SET LOCAL ROLE ua_owner;');
  return insertBefore(rendered,'COMMIT;',after);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.stdout.write(await renderManagedCabinet(process.argv[2]));
}
