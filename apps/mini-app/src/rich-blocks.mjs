// Returning false alone makes KaTeX typeset rejected command names as red text.
// Abort that conversion so preview, the writer and Student all reject the formula.
function rejectInteractiveCommand() {
  throw new Error('Unsupported interactive formula command');
}

export function formulaRenderOptions(display, mathOutput = 'mathml') {
  return {
    displayMode: display === 'block',
    output: mathOutput === 'htmlAndMathml' ? 'htmlAndMathml' : 'mathml',
    trust: rejectInteractiveCommand, strict: 'error', throwOnError: true,
    maxExpand: 1000, maxSize: 20,
  };
}

// Renders canonical question/option blocks. Callers supply their KaTeX loader and
// an asset resolver that permits URLs for the current actor and view.
export function renderBlocks(container, blocks, { resolveAssetUrl, loadKatex, mathOutput = 'mathml' } = {}) {
  const doc = container.ownerDocument;
  function span(className, text) {
    const node = doc.createElement('span');
    node.className = className;
    if (typeof text === 'string') node.textContent = text;
    return node;
  }
  async function renderFormula(host, block) {
    host.setAttribute('aria-busy', 'true');
    try {
      const library = await loadKatex();
      const katex = library.default ?? library;
      katex.render(block.latex, host, formulaRenderOptions(block.display, mathOutput));
    } catch {
      host.textContent = 'Formulani ko‘rsatib bo‘lmadi.';
    } finally {
      host.removeAttribute('aria-busy');
    }
  }
  function imageView(block) {
    const holder = span('pilot-media');
    const alt = block.alt || 'Savol tasviri';
    const fallback = () => holder.replaceChildren(span('pilot-media-error', 'Rasm ochilmadi: ' + alt));
    try {
      const resolved = resolveAssetUrl?.(block);
      if (!resolved) throw new Error();
      const url = new URL(resolved, doc.baseURI);
      const origin = new URL(doc.baseURI).origin;
      const httpLocal = url.protocol === 'http:' && url.origin === origin;
      if ((url.protocol !== 'https:' && !httpLocal) || url.username || url.password) throw new Error();
      const image = doc.createElement('img');
      image.alt = alt;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', fallback, { once: true });
      image.src = url.href;
      holder.append(image);
      if (block.caption) holder.append(span('pilot-caption', block.caption));
    } catch {
      fallback();
    }
    return holder;
  }
  for (const block of blocks) {
    if (block.type === 'text') container.append(span('pilot-text', block.markdown));
    if (block.type === 'formula') {
      const host = span(block.display === 'block' ? 'pilot-formula-block' : 'pilot-formula');
      container.append(host);
      void renderFormula(host, block);
    }
    if (block.type === 'image') container.append(imageView(block));
  }
  return container;
}
