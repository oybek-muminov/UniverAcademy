import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
const sheet=css.slice(css.indexOf('/* Phone learning map'));
test('phone sheet is bottom anchored, bounded, scroll-safe and undimmed',()=>{
 for(const value of ['@media(max-width:700px)','inset:auto 0 0','height:fit-content','100dvh - max(64px,env(safe-area-inset-top))','env(safe-area-inset-bottom)','background:transparent;backdrop-filter:none','grid-template-columns:34px minmax(0,1fr)','prefers-reduced-motion:reduce'])assert.ok(sheet.includes(value),value);
});
