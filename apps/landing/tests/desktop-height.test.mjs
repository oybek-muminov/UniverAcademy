import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
const hook=readFileSync(new URL('../src/useStackedSections.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');
test('desktop ten-percent hold is outside visible panel and disabled on phones/reduced motion',()=>{
 assert.equal((app.match(/className="section-runway"/g)||[]).length,5);
 for(const value of ['.section-runway{display:contents}','margin-bottom:calc((100dvh - var(--nav-height))*.1)','prefers-reduced-motion:reduce){.section-runway>.stack-panel{margin-bottom:0}}'])assert.ok(css.includes(value));
 assert.ok(!css.includes('--desktop-panel-height'));
});
test('navigation measures stable outer starts while tall panels remain bottom-aware',()=>{
 for(const value of ['start+=height+parseFloat(getComputedStyle(panel).marginBottom)','Math.min(headerHeight,window.innerHeight-height)',"document.body.style.position==='fixed'"])assert.ok(hook.includes(value));
 assert.ok(!hook.includes("addEventListener('wheel'"));
});

test('panels share the main sticky boundary instead of releasing at each wrapper end',()=>{assert.ok(!css.includes('.section-runway{display:block'));assert.ok(hook.includes("panel.style.setProperty('--panel-layer'"));});
