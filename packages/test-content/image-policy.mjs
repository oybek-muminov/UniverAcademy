import { SaxesParser } from 'saxes';

export const imageLimits = { 'image/png': 2 * 1024 * 1024, 'image/svg+xml': 256 * 1024 };
const SVG = 'http://www.w3.org/2000/svg';
export const maxSide = 2048;
const tags = new Set(['svg','g','path','rect','line','polyline','polygon','circle','ellipse','text','tspan','title','desc']);
const attributes = new Set(['xmlns','width','height','x','y','x1','x2','y1','y2','rx','ry','r','cx','cy','d','points','transform',
  'viewBox','preserveAspectRatio','fill','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray',
  'opacity','fill-opacity','stroke-opacity','font-size','font-weight','font-family','text-anchor','dominant-baseline','dx','dy','version']);
export function rejectImage(detail) {
  throw Object.assign(new Error(detail), { status:422, code:'INVALID_IMAGE', detail });
}
function escapeXml(value) {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
}

// Rebuild a static SVG from an allowlist before it reaches any image decoder.
function staticSvg(bytes) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch { rejectImage('SVG fayli UTF-8 kodlashda bo‘lishi kerak.'); }
  const parser = new SaxesParser({ xmlns:true });
  const clean = [];
  let depth = 0, elements = 0, layers = 0, maxLayers = 0;
  const composites = [];
  parser.on('error', () => rejectImage('SVG tuzilishi noto‘g‘ri.'));
  for (const event of ['doctype','processinginstruction','cdata']) {
    parser.on(event, () => rejectImage('SVG ichida faqat statik chizma va yozuvlar qabul qilinadi.'));
  }
  parser.on('opentag', tag => {
    if (++elements > 3000 || ++depth > 32) rejectImage('Chizma murakkabligi pilot chegarasidan yuqori.');
    if (tag.uri !== SVG || tag.prefix || !tags.has(tag.name) || (depth === 1 && tag.name !== 'svg') || (depth > 1 && tag.name === 'svg')) {
      rejectImage('SVG ichida qo‘llanmaydigan element bor. Oddiy statik shakllar yoki PNG yuboring.');
    }
    // A composited group may allocate a full transparent canvas per nested
    // opacity. Remember the peak so the Worker can budget the resolved viewport.
    const opacity = tag.attributes.opacity?.value;
    const composite = opacity !== undefined && Number(opacity) !== 1;
    composites.push(composite);
    if (composite) maxLayers = Math.max(maxLayers, ++layers);
    clean.push('<' + tag.name);
    for (const [name, attr] of Object.entries(tag.attributes)) {
      const value = attr.value;
      if (!attributes.has(name) || attr.prefix || (name === 'xmlns' && (depth !== 1 || value !== SVG))) {
        rejectImage('SVG atributi qo‘llanmaydi. Statik shakllar yoki PNG yuboring.');
      }
      if (name !== 'xmlns' && /url\s*\(|[&#]x[0-9a-f]+;|[<>\\]|(?:https?|data|file|javascript):/iu.test(value)) {
        rejectImage('SVG ichida havola yoki tashqi manba ishlatmang.');
      }
      if ((name === 'fill' || name === 'stroke') && !/^(?:#[a-f\d]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s]+\))$/iu.test(value)) {
        rejectImage('SVG chizig‘i va ranglari oddiy rang qiymati bo‘lishi kerak.');
      }
      if (depth === 1 && (name === 'width' || name === 'height')) {
        if (!/^\d+(?:\.\d+)?(?:px)?$/.test(value) || parseFloat(value) <= 0 || parseFloat(value) > maxSide) {
          rejectImage('SVG eni va bo‘yi 1–2048 piksel oralig‘ida bo‘lishi kerak.');
        }
      }
      clean.push(' ' + name + '="' + escapeXml(value) + '"');
    }
    clean.push('>');
  });
  parser.on('text', value => { clean.push(escapeXml(value)); });
  parser.on('closetag', tag => { clean.push('</' + tag.name + '>'); depth--; if (composites.pop()) layers--; });
  parser.write(source).close();
  if (elements === 0) rejectImage('SVG chizmasi topilmadi.');
  return {input:Buffer.from(clean.join('')),maxLayers};
}


export function prepareImage(bytes, contentType) {
  if (!Object.hasOwn(imageLimits,contentType)) throw Object.assign(new Error(), { status:415, code:'IMAGE_TYPE_REQUIRED' });
  if (bytes.length > imageLimits[contentType]) throw Object.assign(new Error(), {status:413,code:'FILE_TOO_LARGE'});
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (contentType === 'image/svg+xml') return staticSvg(input);
  if (!input.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) rejectImage('PNG faylining turi yoki tarkibi mos kelmadi.');
  return {input,maxLayers:0};
}
