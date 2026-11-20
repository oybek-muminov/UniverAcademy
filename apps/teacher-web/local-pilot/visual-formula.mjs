// The teacher authors the agreed LaTeX source; the preview uses the receiver's shared student renderer.
export function mountVisualFormula(root, { value = '', display = 'block', onChange, onDisplayChange, renderBlocks }) {
  const doc = root.ownerDocument;
  const label = doc.createElement('label'), source = doc.createElement('textarea');
  label.textContent = 'LaTeX kodi';
  source.dataset.formulaInput = '';
  source.setAttribute('aria-label','LaTeX kodi');
  source.maxLength = 10000;
  source.spellcheck = false;
  source.placeholder = '\\frac{s}{t}';
  source.value = value;
  label.append(source);
  const formatLabel = doc.createElement('label'), format = doc.createElement('select');
  formatLabel.textContent = 'Formula joylashuvi';
  for (const [id,name] of [['inline','Matn qatorida'],['block','Alohida qatorda']]) {
    const option = doc.createElement('option'); option.value = id; option.textContent = name; format.append(option);
  }
  format.value = display;
  formatLabel.append(format);
  const preview = doc.createElement('div');
  preview.className = 'formula-live-preview';
  preview.setAttribute('aria-label','Formulaning jonli ko‘rinishi');
  let timer;
  function update() {
    clearTimeout(timer);
    preview.replaceChildren();
    if (source.value.trim()) renderBlocks(preview,[{type:'formula',latex:source.value,display:format.value}]);
  }
  source.addEventListener('input',() => {
    onChange(source.value);
    clearTimeout(timer);
    if (!source.value.trim()) { update(); return; }
    timer = setTimeout(() => { if (root.isConnected) update(); }, 80);
  });
  format.addEventListener('change',() => { onDisplayChange?.(format.value); update(); });
  root.replaceChildren(label,formatLabel,preview);
  update();
  return { getValue() { return source.value; }, setValue(next) { source.value = next; onChange(next); update(); } };
}
