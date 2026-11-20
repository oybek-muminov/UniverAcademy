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
export function renderBlocks(container, blocks, { resolveAssetUrl, loadAsset, signal, loadKatex, mathOutput = 'mathml' } = {}) {
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
    function attach(src) {
      const image = doc.createElement('img');
      image.alt = alt;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', fallback, { once: true });
      image.src = src;
      holder.append(image);
      if (block.caption) holder.append(span('pilot-caption', block.caption));
    }
    if (loadAsset) {
      // Only a locally created URL from an authenticated PNG response enters the DOM.
      if (!signal || signal.aborted) { fallback(); return holder; }
      void Promise.resolve().then(() => loadAsset(block, signal)).then(blob => {
        if (signal.aborted) return;
        if (!(blob instanceof Blob) || blob.type !== 'image/png') throw new Error();
        const src = URL.createObjectURL(blob);
        signal.addEventListener('abort', () => URL.revokeObjectURL(src), {once:true});
        attach(src);
      }).catch(() => { if (!signal.aborted) fallback(); });
      return holder;
    }
    try {
      const resolved = resolveAssetUrl?.(block);
      if (!resolved) throw new Error();
      const url = new URL(resolved, doc.baseURI);
      const origin = new URL(doc.baseURI).origin;
      const httpLocal = url.protocol === 'http:' && url.origin === origin;
      if ((url.protocol !== 'https:' && !httpLocal) || url.username || url.password) throw new Error();
      attach(url.href);
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
