import { renderBlocks as renderRichBlocks } from '/pilot/rich-blocks.mjs';

let katex;
function loadKatex() {
  katex ??= import('/pilot/vendor/katex.mjs');
  return katex;
}
function resolveAssetUrl(block) {
  const role = location.pathname.split('/')[1];
  if (role !== 'teacher' && role !== 'student') return null;
  // In the editor only, a new input block has an asset ID before it has a projection.
  const id = block.asset ? block.asset.asset_id : role === 'teacher' ? block.asset_id : null;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return null;
  const expected = new URL('/local-pilot/' + role + '/media/' + id, location.origin);
  if (block.asset && (!block.asset.url || new URL(block.asset.url, location.origin).href !== expected.href)) return null;
  return expected;
}
export function renderBlocks(container, blocks) {
  return renderRichBlocks(container, blocks, { resolveAssetUrl, loadKatex });
}
