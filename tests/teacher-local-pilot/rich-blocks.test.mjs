import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBlocks } from '../../apps/mini-app/src/rich-blocks.mjs';

function container() {
  const doc = {
    baseURI: 'https://classroom.example/exams/1',
    createElement(tag) {
      return {
        tag, ownerDocument: doc, children: [], handlers: {}, attrs: {},
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        setAttribute(name, value) { this.attrs[name] = value; },
        removeAttribute(name) { delete this.attrs[name]; },
        addEventListener(name, handler) { this.handlers[name] = handler; },
      };
    },
  };
  return doc.createElement('div');
}

const picture = {type: 'image', asset: {asset_id: 'diagram'}, alt: 'Chizma', caption: '1-rasm'};

test('canonical rich blocks preserve order, literal text and accessible math without depending on a pilot route', async () => {
  const view = container(), renders = [];
  const loadKatex = async () => ({ render(latex, host, options) { renders.push({latex, host, options}); } });
  const imageUrl = 'https://assets.example/signed/diagram?ticket=once';
  renderBlocks(view, [
    {type: 'text', markdown: '<b>Matn</b>'},
    {type: 'formula', latex: 'x^2', display: 'block'},
    picture,
    {type: 'formula', latex: 'y', display: 'inline'},
  ], {loadKatex, resolveAssetUrl: block => block === picture ? imageUrl : null});
  assert.equal(view.children[1].textContent, undefined);
  assert.equal(view.children[1].attrs['aria-busy'], 'true');
  await Promise.resolve();
  assert.equal(view.children[0].textContent, '<b>Matn</b>');
  assert.deepEqual(renders.map(r => [r.latex, r.options.displayMode]), [['x^2', true], ['y', false]]);
  assert.equal(renders[0].host, view.children[1]);
  assert.equal(renders[0].options.output, 'mathml');
  const {trust, ...options} = renders[0].options;
  assert.deepEqual(options, {displayMode: true, output: 'mathml', strict: 'error',
    throwOnError: true, maxExpand: 1000, maxSize: 20});
  assert.throws(() => trust());
  const holder = view.children[2];
  const [image, caption] = holder.children;
  assert.deepEqual([image.tag, image.src, image.alt, caption.textContent], ['img', imageUrl, 'Chizma', '1-rasm']);
  image.handlers.error();
  assert.equal(holder.children[0].textContent, 'Rasm ochilmadi: Chizma');
});

test('an unresolved asset, a non-web scheme or a credentialed URL is never used as an image source', () => {
  for (const resolveAssetUrl of [undefined, () => null, () => 'data:image/png;base64,AA',
    () => 'http://plain.example/image', () => 'https://user@private.example/image']) {
    const view = container();
    renderBlocks(view, [picture], {resolveAssetUrl});
    assert.equal(view.children[0].children[0].className, 'pilot-media-error');
  }
});

test('formula errors leave only a readable message without showing the source', async () => {
  const view = container();
  renderBlocks(view, [{type: 'formula', latex: 'a+b', display: 'inline'}], {
    loadKatex: async () => { throw Error('unavailable'); },
  });
  await Promise.resolve();
  assert.equal(view.children[0].textContent, 'Formulani ko‘rsatib bo‘lmadi.');
  assert.equal(view.children[0].attrs['aria-busy'], undefined);
});

test('draft writer and preview accept the same formulas and reject the same unsupported command', async () => {
  const {validatePilotFormulas} = await import('../../runtime/teacher-local-ui/validate-formula.mjs');
  const {default: katex} = await import('../../runtime/teacher-local-ui/node_modules/katex/dist/katex.mjs');
  const loadKatex = async () => ({ render(latex, host, opts) { host.textContent = katex.renderToString(latex, opts); } });
  const blocks = [{type: 'formula', latex: String.raw`v=\frac{\Delta s}{\Delta t}`, display: 'block'}];
  const questions = [{prompt_blocks: blocks}];
  assert.doesNotThrow(() => validatePilotFormulas(questions));
  const allowed = container();
  renderBlocks(allowed, blocks, {loadKatex});
  await Promise.resolve();
  assert.match(allowed.children[0].textContent, /<mfrac>/);
  blocks[0].latex = String.raw`\href{article}{y}`;
  assert.throws(() => validatePilotFormulas(questions), {code: 'INVALID_FORMULA'});
  const refused = container();
  renderBlocks(refused, blocks, {loadKatex});
  await Promise.resolve();
  assert.equal(refused.children[0].textContent, 'Formulani ko‘rsatib bo‘lmadi.');
});
