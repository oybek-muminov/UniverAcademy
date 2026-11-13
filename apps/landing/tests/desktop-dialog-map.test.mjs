import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
const map=css.slice(css.indexOf('/* Desktop learning map:'),css.indexOf('/* Desktop hold lives'));
test('compact learning map is desktop-only with transparent unblurred backdrop and scroll-safe height',()=>{
 for(const value of ['@media(min-width:701px)','width:min(1440px,calc(100% - 48px))','height:min(674px,calc(100dvh - 48px))','max-height:calc(100dvh - 48px)','background:transparent;backdrop-filter:none','grid-template-columns:repeat(5,minmax(0,1fr))','.subject-modal-art{display:none}'])assert.ok(map.includes(value),value);
 assert.ok(!map.includes('@media(max-width'));
});
