import sharp from 'sharp';
import { SaxesParser } from 'saxes';

export const imageLimits = { 'image/png': 2 * 1024 * 1024, 'image/svg+xml': 256 * 1024 };
const SVG = 'http://www.w3.org/2000/svg';
const maxSide = 2048;
const tags = new Set(['svg','g','path','rect','line','polyline','polygon','circle','ellipse','text','tspan','title','desc']);
const attributes = new Set(['xmlns','width','height','x','y','x1','x2','y1','y2','rx','ry','r','cx','cy','d','points','transform',
  'viewBox','preserveAspectRatio','fill','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray',
  'opacity','fill-opacity','stroke-opacity','font-size','font-weight','font-family','text-anchor','dominant-baseline','dx','dy','version']);
function reject(detail) {
  throw Object.assign(new Error(detail), { status:422, code:'INVALID_IMAGE', detail });
}
function escapeXml(value) {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
}

// Rebuild a static SVG from an allowlist before it reaches any image decoder.
function staticSvg(bytes) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch { reject('SVG fayli UTF-8 kodlashda bo‘lishi kerak.'); }
  const parser = new SaxesParser({ xmlns:true });
  const clean = [];
  let depth = 0, elements = 0;
  parser.on('error', () => reject('SVG tuzilishi noto‘g‘ri.'));
  for (const event of ['doctype','processinginstruction','cdata']) {
    parser.on(event, () => reject('SVG ichida faqat statik chizma va yozuvlar qabul qilinadi.'));
  }
  parser.on('opentag', tag => {
    if (++elements > 3000 || ++depth > 32) reject('Chizma murakkabligi pilot chegarasidan yuqori.');
    if (tag.uri !== SVG || tag.prefix || !tags.has(tag.name) || (depth === 1 && tag.name !== 'svg') || (depth > 1 && tag.name === 'svg')) {
      reject('SVG ichida qo‘llanmaydigan element bor. Oddiy statik shakllar yoki PNG yuboring.');
    }
    clean.push('<' + tag.name);
    for (const [name, attr] of Object.entries(tag.attributes)) {
      const value = attr.value;
      if (!attributes.has(name) || attr.prefix || (name === 'xmlns' && (depth !== 1 || value !== SVG))) {
        reject('SVG atributi qo‘llanmaydi. Statik shakllar yoki PNG yuboring.');
      }
      if (name !== 'xmlns' && /url\s*\(|[&#]x[0-9a-f]+;|[<>\\]|(?:https?|data|file|javascript):/iu.test(value)) {
        reject('SVG ichida havola yoki tashqi manba ishlatmang.');
      }
      if ((name === 'fill' || name === 'stroke') && !/^(?:#[a-f\d]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s]+\))$/iu.test(value)) {
        reject('SVG chizig‘i va ranglari oddiy rang qiymati bo‘lishi kerak.');
      }
      if (depth === 1 && (name === 'width' || name === 'height')) {
        if (!/^\d+(?:\.\d+)?(?:px)?$/.test(value) || parseFloat(value) <= 0 || parseFloat(value) > maxSide) {
          reject('SVG eni va bo‘yi 1–2048 piksel oralig‘ida bo‘lishi kerak.');
        }
      }
      clean.push(' ' + name + '="' + escapeXml(value) + '"');
    }
    clean.push('>');
  });
  parser.on('text', value => { clean.push(escapeXml(value)); });
  parser.on('closetag', tag => { clean.push('</' + tag.name + '>'); depth--; });
  parser.write(source).close();
  if (elements === 0) reject('SVG chizmasi topilmadi.');
  return Buffer.from(clean.join(''));
}

export async function privatePng(bytes, contentType) {
  if (!Object.hasOwn(imageLimits,contentType)) throw Object.assign(new Error(), { status:415, code:'IMAGE_TYPE_REQUIRED' });
  if (bytes.length > imageLimits[contentType]) throw Object.assign(new Error(), {status:413,code:'FILE_TOO_LARGE'});
  let input = bytes;
  if (contentType === 'image/svg+xml') input = staticSvg(bytes);
  else if (!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) reject('PNG faylining turi yoki tarkibi mos kelmadi.');
  try {
    const image = sharp(input,{ limitInputPixels:maxSide * maxSide,failOn:'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== (contentType === 'image/png' ? 'png' : 'svg') ||
        !metadata.width || !metadata.height || Math.max(metadata.width,metadata.height) > maxSide || (metadata.pages ?? 1) > 1) {
      reject('Statik rasmning eng katta tomoni 2048 piksel bo‘lishi kerak.');
    }
    const png = await image.timeout({ seconds:4 }).png().toBuffer();
    return png;
  } catch (error) {
    if (error.code === 'INVALID_IMAGE') throw error;
    reject('Rasm o‘qilmadi. PNG yoki statik SVG chizmasini tekshiring.');
  }
}
