// Build and execute a production-only installation and a separate Vercel-style file trace.
// This check never deploys. Run with Node 24, npm and Git in a checkout of the project.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, glob, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'univeracademy-node-proof-'));
const source = path.join(temp, 'source');
const bundle = path.join(temp, 'function');
const smoke = path.join(checkout, 'tests/teacher-staging-pilot/production-smoke.mjs');
async function copyFileTreeFile(from, to, name) {
  await mkdir(path.dirname(path.join(to, name)), {recursive:true});
  await cp(path.join(from, name), path.join(to, name));
}
function run(program, args, cwd) {
  execFileSync(program, args, {cwd, stdio:'inherit', env:{...process.env,npm_config_audit:'false',npm_config_fund:'false'}});
}
try {
  await mkdir(source);
  const listing = execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], {cwd:checkout,encoding:'utf8'});
  for (const file of new Set(listing.split('\0').filter(Boolean))) {
    if (file.split('/').some(part => ['node_modules','dist','dist-teacher-entrance','.wrangler','.test-staging-build','__pycache__'].includes(part))) continue;
    const stat = await lstat(path.join(checkout,file)).catch(error => {if(error.code !== 'ENOENT') throw error;});
    if (stat?.isFile()) await copyFileTreeFile(checkout, source, file);
  }
  // The older accepted QA files are byte-pinned by other clients. Keep the production
  // schema projection and vocabulary identical while resolving dependencies from the root.
  for (const file of ['view-builder.cjs', 'ajv-config.cjs']) {
    const active = await readFile(path.join(source,'packages/contract-validation',file));
    const accepted = await readFile(path.join(source,'tests/backend/validator',file));
    assert.deepEqual(active,accepted,file);
  }
  run('npm', ['ci','--omit=dev'], source);
  assert.equal(await lstat(path.join(source,'node_modules/typescript')).catch(() => null), null);
  run(process.execPath, [smoke,source], source);
  run('npm', ['exec','--yes','--package=@vercel/nft@1.11.10','--','nft','build','api/index.mjs'], source);
  // The copy is outside the source tree, so Node cannot find missing packages in its parent.
  await rename(path.join(source,'dist'),bundle);
  const config = JSON.parse(await readFile(path.join(source,'vercel.json'),'utf8'));
  const extra = config.functions['api/index.mjs'].includeFiles;
  let included = 0;
  for await (const file of glob(extra,{cwd:source})) {
    if (!(await lstat(path.join(source,file))).isFile()) continue;
    await copyFileTreeFile(source,bundle,file); included++;
  }
  assert(included > 0);
  for(const unwanted of ['tests','runtime/teacher-local-ui','node_modules/typescript']) {
    assert.equal(await lstat(path.join(bundle,unwanted)).catch(() => null), null, unwanted);
  }
  run(process.execPath, [smoke,bundle], temp);
  console.log('Isolated API bundle passed with ' + included + ' explicitly included deployment files.');
} finally {
  await rm(temp,{recursive:true,force:true});
}
