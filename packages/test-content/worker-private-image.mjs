// Wrangler imports precompiled WASM modules. All codecs, glyphs and image bytes
// stay inside the Worker, including diagrams with visible text labels.
import {crc32} from 'node:zlib';
import {initSync,decode,encode} from '@jsquash/png/codec/pkg/squoosh_png.js';
import pngModule from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import {initWasm,Resvg} from '@resvg/resvg-wasm';
import svgModule from '@resvg/resvg-wasm/index_bg.wasm';
import font from './fonts/diagram-sans.bin';
import {prepareImage,maxSide,rejectImage} from './image-policy.mjs';
export {imageLimits} from './image-policy.mjs';

const rasterChunks = new Set(['IHDR','PLTE','tRNS','IDAT','IEND']);
const animated = new Set(['acTL','fcTL','fdAT']);
let svgReady;
function dimensions(width,height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || Math.min(width,height) < 1 || Math.max(width,height) > maxSide)
    rejectImage('Statik rasmning eng katta tomoni 2048 piksel bo‘lishi kerak.');
}
function invalidPng() { rejectImage('PNG faylining turi yoki tarkibi mos kelmadi.'); }

// Drop ancillary data before the decoder can inflate profiles or text. Verify
// framing and CRCs, and reject animations before allocating a pixel buffer.
function pngPixelsOnly(input) {
  if (input.length < 45 || input.readUInt32BE(8) !== 13 || input.toString('ascii',12,16) !== 'IHDR') invalidPng();
  dimensions(input.readUInt32BE(16),input.readUInt32BE(20));
  const parts=[input.subarray(0,8)];
  let pixels=false,ended=false;
  for (let offset=8,count=0; offset < input.length;) {
    if (++count>8192 || offset+12>input.length) invalidPng();
    const length=input.readUInt32BE(offset), next=offset+length+12;
    if (next>input.length) invalidPng();
    const type=input.toString('latin1',offset+4,offset+8);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || animated.has(type) ||
        (type==='IHDR' && offset!==8) || crc32(input.subarray(offset+4,next-4))!==input.readUInt32BE(next-4)) invalidPng();
    if (type==='IDAT') pixels=true;
    if (type==='IEND') { if (length!==0 || next!==input.length || !pixels) invalidPng(); ended=true; }
    if (rasterChunks.has(type)) parts.push(input.subarray(offset,next));
    else if (type[0]===type[0].toUpperCase()) invalidPng();
    offset=next;
  }
  if (!ended) invalidPng();
  return Buffer.concat(parts);
}

export async function privatePng(bytes,contentType) {
  const {input,maxLayers}=prepareImage(bytes,contentType);
  try {
    if (contentType==='image/png') {
      const data=pngPixelsOnly(input);
      initSync(pngModule);
      const image=decode(data);
      if (!image || image.width!==data.readUInt32BE(16) || image.height!==data.readUInt32BE(20) ||
          image.data.byteLength!==image.width*image.height*4) invalidPng();
      return Buffer.from(encode(image.data,image.width,image.height,8).buffer);
    }
    await (svgReady ??= initWasm(svgModule));
    const family='DejaVu Sans';
    const svg=new Resvg(input,{font:{fontBuffers:[new Uint8Array(font)],defaultFontFamily:family,
      sansSerifFamily:family,serifFamily:family,monospaceFamily:family,cursiveFamily:family,fantasyFamily:family}});
    try {
      dimensions(svg.width,svg.height);
      // Allow up to 48 MiB of simultaneous RGBA paint surfaces. At 2048²
      // the renderer and PNG encoding need two surfaces before opacity layers.
      if (svg.width*svg.height*(2+maxLayers)>3*maxSide*maxSide)
        rejectImage('SVG shaffof qatlamlari rasm o‘lchamiga nisbatan juda ko‘p. Qatlamlarni soddalashtiring yoki PNG yuboring.');
      const rendered=svg.render();
      try {return Buffer.from(rendered.asPng().buffer);}
      finally {rendered.free();}
    } finally {svg.free();}
  } catch(error) {
    if (error?.code==='INVALID_IMAGE') throw error;
    rejectImage('Rasm o‘qilmadi. PNG yoki statik SVG chizmasini tekshiring.');
  }
}
