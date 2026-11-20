// Compile with the deployment tool and exercise the resulting modules in real workerd.
// Run npm ci at root and in apps/teacher-web/ustoz-pages before running this suite.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {crc32} from 'node:zlib';
import test from 'node:test';
import sharp from 'sharp';

const root=fileURLToPath(new URL('../../',import.meta.url));
const toolkit=createRequire(new URL('../../apps/teacher-web/ustoz-pages/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=toolkit('miniflare');
async function renderer(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'ua-worker-image-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const config=path.join(dir,'wrangler.json'), out=path.join(dir,'out');
  await writeFile(config,JSON.stringify({name:'ua-test-media',main:path.join(root,'tests/cloudflare/fixtures/private-image-worker.mjs'),
    compatibility_date:'2026-11-11',compatibility_flags:['nodejs_compat']}));
  await promisify(execFile)(process.execPath,[path.join(root,'apps/teacher-web/ustoz-pages/node_modules/wrangler/bin/wrangler.js'),
    'deploy','--dry-run','--config',config,'--outdir',out],{cwd:dir,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  const files=await readdir(out),entry='private-image-worker.js';
  const types={'.js':'ESModule','.bin':'Data','.wasm':'CompiledWasm'};
  const modules=await Promise.all([entry,...files.filter(name=>name!==entry&&types[path.extname(name)])].map(async name=>{
    const file=path.join(out,name);
    return {type:types[path.extname(name)],path:file,contents:await readFile(file)};
  }));
  const host=new Miniflare(convertV4MiniflareOptions({workers:[{name:'codec',modules,modulesRoot:out,
    compatibilityFlags:['nodejs_compat'],compatibilityDate:'2026-11-11',outboundService:()=>{throw Error('Unexpected network during image conversion');}}]}));
  t.after(()=>host.dispose());
  return async function render(bytes,type) {
    const response=await host.dispatchFetch('https://media.example.test/',{method:'POST',headers:{'content-type':type},body:bytes});
    return response.ok?Buffer.from(await response.arrayBuffer()):{status:response.status,...await response.json()};
  };
}

const svg=(body,width=32,height=16)=>Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'">'+body+'</svg>');
const raw=bytes=>sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
function chunk(name,data) {
  const c=Buffer.alloc(data.length+12);c.writeUInt32BE(data.length);c.write(name,4,'ascii');data.copy(c,8);
  c.writeUInt32BE(crc32(c.subarray(4,-4)),c.length-4);return c;
}

test('workerd converts private PNG and static SVG into bounded pixels offline',async t=>{
  const render=await renderer(t);
  const rgba=Buffer.from([11,29,33,0,22,66,11,255,194,19,46,110,11,149,211,225]);
  const plain=await sharp(rgba,{raw:{width:2,height:2,channels:4}}).png().toBuffer();
  const metadata=chunk('tEXt',Buffer.from('caption\0PRIVATE-CAPTION')); const insertion=33;
  const imageWith=extra=>Buffer.concat([plain.subarray(0,insertion),extra,plain.subarray(insertion)]);

  await t.test('PNG preserves all four channels and removes metadata',async()=>{
    const sanitized=await render(imageWith(metadata),'image/png');
    const decoded=await raw(sanitized);
    assert.deepEqual(decoded.data,rgba);assert.equal(decoded.info.width,2);assert.equal(decoded.info.height,2);
    assert(!sanitized.includes(Buffer.from('PRIVATE-CAPTION')));assert(!sanitized.includes(Buffer.from('tEXt')));
  });
  await t.test('a static diagram preserves geometry, painted and transparent pixels',async()=>{
    const sanitized=await render(svg('<rect x="1" y="2" width="6" height="4" fill="#1641ff"/>'),'image/svg+xml');
    const decoded=await raw(sanitized);
    assert.equal(decoded.info.width,32);assert.equal(decoded.info.height,16);
    const at=(x,y)=>[...decoded.data.subarray((y*32+x)*4,(y*32+x)*4+4)];
    assert.deepEqual(at(2,3),[22,65,255,255]);assert.deepEqual(at(15,8),[0,0,0,0]);
  });
  await t.test('Uzbek, Cyrillic and math labels produce distinct visible glyphs',async()=>{
    const texts=['O‘q','Ўқ','β≈'];const renders=[];
    for(const label of texts) {
      const image=await raw(await render(svg('<text x="2" y="22" font-size="20">'+label+'</text>',80,32),'image/svg+xml'));
      assert(image.data.some((v,i)=>i%4===3&&v>100),label+' has visible pixels');renders.push(image.data);
    }
    assert(!renders[0].equals(renders[1]));assert(!renders[1].equals(renders[2]));
  });
  await t.test('rejects malformed and animated PNG, active XML and excessive bounds',async()=>{
    const badCrc=Buffer.from(plain);badCrc[badCrc.length-2]^=1;
    const badSize=Buffer.from(plain);badSize.writeUInt32BE(2049,16);
    const active=Buffer.concat([Buffer.from('<!DOCTYPE svg>'),svg('<rect/>')]);
    for(const buffer of [badCrc,badSize,plain.subarray(0,plain.length-1),imageWith(chunk('acTL',Buffer.alloc(8))),Buffer.from('PNG')])
      assert.deepEqual(await render(buffer,'image/png'),{status:422,code:'INVALID_IMAGE'});
    const nested=svg('<g opacity="0.4"><rect width="2048" height="2048"/><g opacity="0.4"><rect width="2048" height="2048"/></g></g>',2048,2048);
    for(const buffer of [active,nested,svg('<image href="https://static.example/resource"/>'),svg('<rect onclick="action()"/>'),svg('<circle/>',2049,1),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100000"><rect width="1" height="1"/></svg>')])
      assert.deepEqual(await render(buffer,'image/svg+xml'),{status:422,code:'INVALID_IMAGE'});
    assert.deepEqual(await render(Buffer.alloc(256*1024+1),'image/svg+xml'),{status:413,code:'FILE_TOO_LARGE'});
    assert.deepEqual(await render(Buffer.alloc(2*1024*1024+1),'image/png'),{status:413,code:'FILE_TOO_LARGE'});
    assert.deepEqual(await render(plain,'image/jpeg'),{status:415,code:'IMAGE_TYPE_REQUIRED'});
  });
  await t.test('retains the 2048-pixel upper bound for PNG and SVG including concurrent uploads',async t=>{
    for(const size of [512,2048]) {
      const input=await sharp({create:{width:size,height:size,channels:4,background:{r:11,g:23,b:44,alpha:.5}}}).png().toBuffer();
      const drawing=svg('<rect width="40" height="50" fill="#faceaf"/>',size,size);
      for(const [type,source] of [['image/png',input],['image/svg+xml',drawing]]) {
        const before=performance.now(),output=await render(source,type);
        const ms=Math.round(performance.now()-before),info=await sharp(output).metadata();
        assert.equal(info.width,size);assert.equal(info.height,size);
        t.diagnostic(size+'px '+type+' local roundtrip '+ms+' ms');
      }
      if(size===2048) {
        const begin=performance.now(),pair=await Promise.all([render(input,'image/png'),render(drawing,'image/svg+xml')]);
        assert(pair.every(x=>Buffer.isBuffer(x)&&x.readUInt32BE(16)===2048));
        t.diagnostic('Two concurrent 2048px conversions, local roundtrip '+Math.round(performance.now()-begin)+' ms');
      }
    }
  });
});
