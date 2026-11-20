import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import compiler from '../../packages/contract-validation/ajv-config.cjs';
import builder from '../../packages/contract-validation/view-builder.cjs';
import { validate } from '../../packages/contract-validation/teacher-cabinet.mjs';
import { validatePilotFormulas } from '../../packages/test-content/validate-formula.mjs';
import { richDocument } from '../teacher-staging-pilot/requests.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pagesTooling = createRequire(new URL('../../apps/teacher-web/ustoz-pages/package.json', import.meta.url));
const id = '00000000-0000-7000-8000-000000000001';
const question = { ...richDocument(id).questions[0], expected_revision: 0 };
const version = { id, demo_id: id, version_no: 1, duration_seconds: 60, instructions_blocks: question.prompt_blocks,
  status: 'draft', revision: 0, grading_config: { individual_enabled: false } };
const rows = [];
function add(name, label, value, ok) { rows.push({ name, label, value, ok }); }
for (const [name, base] of [['QuestionWrite', question], ['Version', version]]) {
  add(name, 'complete', base, true);
  add(name, 'extra field', { ...base, extra: true }, false);
  for (const key of Object.keys(base)) {
    const copy = { ...base }; delete copy[key];
    add(name, 'missing ' + key, copy, false);
  }
  for (const suffix of ['\n','\r','\u2028','\u2029',' ']) add(name, 'incorrect UUID suffix', { ...base, id: id + suffix }, false);
  add(name, 'valid UUID URN', { ...base, id: 'urn:uuid:' + id }, true);
}
for (const [points, ok] of [[null,true],['0.001',true],['30.000',true],['30.001',false],['0',false],['01',false],[2,false]]) {
  add('QuestionWrite', 'points ' + points, { ...question, individual_points: points }, ok);
}
for (const [patch, ok] of [
  [{ position: '1' },false], [{ expected_revision: -1 },false], [{ options: question.options.slice(1) },false],
  [{ prompt_blocks: [] },false], [{ prompt_blocks: [{type:'unsupported'}] },false],
  [{ prompt_blocks: [{type:'formula',latex:'x',display:'left'}] },false],
  [{ prompt_blocks: [{type:'image',asset_id:id,alt:'🌱'.repeat(1000)}] },true],
  [{ prompt_blocks: [{type:'image',asset_id:id,alt:'🌱'.repeat(1001)}] },false],
  [{ prompt_blocks: [{type:'text',markdown:'a'.repeat(20001)}] },false],
  [{ explanation_blocks: [{type:'formula',latex:'a'.repeat(10001),display:'block'}] },false],
]) add('QuestionWrite', 'question constraints', { ...question, ...patch }, ok);
for (const [patch, ok] of [
  [{ duration_seconds:'60' },false], [{ duration_seconds:0 },false], [{ status:'archived' },false],
  [{ instructions_blocks:[] },false], [{ grading_config:{} },false], [{ grading_config:{individual_enabled:'true'} },false],
  [{ status:'published',grading_config:{individual_enabled:true} },true],
]) add('Version', 'version constraints', { ...version, ...patch }, ok);
add('UnknownSchema', 'out of scope', question, false);

const formulas = [String.raw`\frac{3}{4}`, String.raw`\sqrt{x^2+y^2}`, String.raw`\UnknownCommand`, String.raw`\href{https://example.org}{x}`];
function formulaResult(latex) {
  try { validatePilotFormulas([{prompt_blocks:[{type:'formula',display:'block',latex}]}]); return 'ok'; }
  catch (error) { return error.code; }
}

test('checked-in Worker validators match the strict release compiler, without changing submitted data', () => {
  execFileSync(process.execPath, ['tools/generate-teacher-cabinet-validator.mjs', '--check'], { cwd: root });
  const source = readFileSync(new URL('../../contracts/telegram-return.openapi.json', import.meta.url));
  const { validators } = compiler.compileView(builder.buildView(source).view);
  for (const { name, label, value, ok } of rows) {
    const before = structuredClone(value);
    assert.equal(validators.get(name)?.(value) === true, ok, name + ' / Node / ' + label);
    assert.equal(validate(name,value), ok, name + ' / generated / ' + label);
    assert.deepEqual(value, before);
  }
});

test('workerd runs both rich-content schemas and the same KaTeX guard without Node compatibility or dynamic compilation', async () => {
  const { build } = pagesTooling('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = pagesTooling('miniflare');
  const bundle = await build({ stdin: { resolveDir:root, contents:`
    import {validate} from './packages/contract-validation/teacher-cabinet.mjs';
    import {validatePilotFormulas} from './packages/test-content/validate-formula.mjs';
    export default {async fetch(request) {
      const {rows,formulas}=await request.json();
      return Response.json({schemas:rows.map(row=>validate(row.name,row.value)),formulas:formulas.map(latex=>{
        try { validatePilotFormulas([{prompt_blocks:[{type:'formula',display:'block',latex}]}]); return 'ok'; }
        catch (error) { return error.code; }
      })});
    }};
  ` }, bundle:true, write:false, platform:'browser', format:'esm', metafile:true });
  const ajvFiles = Object.keys(bundle.metafile.inputs).filter(path => path.includes('/ajv/'));
  assert.deepEqual(ajvFiles.map(path => path.slice(path.indexOf('/ajv/') + 5)), ['dist/runtime/ucs2length.js']);
  assert.doesNotMatch(bundle.outputFiles[0].text, /(?:\beval\s*\(|\bnew Function\s*\(|node:fs)/);
  const mf = new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'cabinet-validator', modules:true, script:bundle.outputFiles[0].text, compatibilityDate:'2026-11-11'
  }]}));
  try {
    const response = await mf.dispatchFetch('https://validator.example/check', { method:'POST', body:JSON.stringify({rows,formulas}) });
    assert.equal(response.status, 200);
    const expectedFormulas = formulas.map(formulaResult);
    assert.deepEqual(expectedFormulas, ['ok','ok','INVALID_FORMULA','INVALID_FORMULA']);
    assert.deepEqual(await response.json(), {schemas:rows.map(row=>row.ok),formulas:expectedFormulas});
  } finally { await mf.dispose(); }
});
