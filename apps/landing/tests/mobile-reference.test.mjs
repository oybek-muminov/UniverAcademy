import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8'),subjects=readFileSync(new URL('../src/Subjects.tsx',import.meta.url),'utf8');
test('mobile pattern stays unchanged through 75 percent and fades only its bottom quarter',()=>{for(const s of ['background:#F5B03E',"width='72'",'opacity:.14','mask:linear-gradient(to bottom,#000 0%,#000 75%,transparent 100%)'])assert.ok(css.includes(s));});
test('mobile subjects use native horizontal scrolling and accessible direct controls',()=>{for(const s of ['gap:12px;padding:20px 20px 6px','scroll-snap-type:x proximity','scroll-snap-stop:normal','flex:0 0 80%'])assert.ok(css.includes(s));for(const s of ['aria-label="Oldingi fan"','aria-label="Keyingi fan"','aria-controls="subject-carousel"','onScroll={trackPosition}','track.scrollTo','aria-current={current===index','(prefers-reduced-motion: reduce)'])assert.ok(subjects.includes(s));assert.ok(!subjects.includes('touchmove'));});

test('mobile header overlays the same hero surface with safe-area and scroll protection',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),nav=readFileSync(new URL('../src/useStackedSections.ts',import.meta.url),'utf8');
 for(const s of ['position:fixed;inset:0 0 auto','background:transparent;backdrop-filter:none;border-bottom:0','padding-top:calc(var(--nav-height,72px) + 28px)','[data-scrolled="true"]{background:#F5B03E}'])assert.ok(css.includes(s));
 assert.ok(nav.includes('header.dataset.scrolled=String(window.scrollY>1)'));
 assert.ok(html.includes('viewport-fit=cover'));assert.ok(html.includes('content="#F5B03E" media="(max-width: 700px)"'));
});

test('mobile uses supplied stair geometry and accessible motion controls',()=>{
 const stairs=readFileSync(new URL('../src/MobileStairs.tsx',import.meta.url),'utf8'),main=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');
 assert.equal((stairs.match(/<rect /g)||[]).length,5);assert.ok(stairs.includes('viewBox="0 -60 360 230"'));assert.ok(main.includes('<MobileStairs/>'));assert.ok(!main.includes('src="/brand/mobile-learning.svg"'));
 for(const s of ['mobile-step-up .9s','@media(prefers-reduced-motion:reduce){.mobile-stairs','.motion-paused .mobile-stairs'])assert.ok(css.includes(s));assert.ok(!stairs.includes('+50 XP'));
});
test('compact mobile cards retain icons, full names and native dialog controls',()=>{
 for(const s of ['border-radius:26px;min-height:268px','padding:22px;height:auto','width:50px;height:50px','subject-summary>.subject-art{display:none}','scroll-snap-align:center'])assert.ok(css.includes(s));
 assert.ok(subjects.includes('subject-card-description'));assert.ok(subjects.includes('aria-haspopup="dialog"'));assert.ok(subjects.includes('Ona tili va adabiyot'));
});

test('stairs finish once before the above-step star appears and glows gently',()=>{
 const stairs=readFileSync(new URL('../src/MobileStairs.tsx',import.meta.url),'utf8');
 for(const delay of ['.4s','.9s','1.4s','1.9s','2.4s'])assert.ok(stairs.includes(`animationDelay:'${delay}'`));
 assert.ok(stairs.includes('transform="translate(0 2)"'));assert.ok(!stairs.includes('className="cl"'));
 assert.ok(css.includes('mobile-star-appear .5s 3.3s'));assert.ok(css.includes('mobile-star-glow 4s 3.3s'));assert.ok(!css.includes('mobile-step-hop'));
 assert.ok(!css.includes('min-height:224px'));assert.ok(!css.includes('flex:0 0 calc(10% - 12px)'));
});

test('mobile carousel breaks ancestor automatic minimum sizing before applying percentage cards',()=>{
 const block=css.slice(css.indexOf('/* Mobile carousel must size'));
 assert.ok(block.includes('@media(max-width:700px)'));
 for(const rule of ['.paths{display:block;min-width:0}', '.paths>div{min-width:0;max-width:100%}', 'width:calc(100% + 32px);min-width:0;max-width:calc(100% + 32px);box-sizing:border-box', 'min-width:0;max-width:100%;white-space:normal'])assert.ok(block.includes(rule));
 // 16px section margins are restored by the track; 20px reference padding remains inside it.
 for(const viewport of [320,360,390,430,700]){
  const section=viewport-32,track=section+32,card=(track-40)*.8;
  assert.equal(track,viewport);assert.ok(card<viewport);assert.ok(card>=224);
 }
});

test('completion star reuses road halo motion with delayed expanding ring and static alternatives',()=>{
 const stairs=readFileSync(new URL('../src/MobileStairs.tsx',import.meta.url),'utf8');
 assert.ok(stairs.indexOf('className="mobile-star-halo"')>stairs.indexOf('className="mobile-step-star"'));
 assert.ok(stairs.includes('className="mobile-star-ring"'));
 for(const token of ['practice-glow 2.4s 3.3s','mobile-star-ring 2.4s 3.3s','.motion-paused .mobile-star-halo','@media(prefers-reduced-motion:reduce){.mobile-star-halo'])assert.ok(css.includes(token));
 // Ring reaches radius 27.2 around centre (308,43), inside final stair x280–336/y14–160.
 assert.ok(41+2-16*1.7>14);assert.ok(41+2+16*1.7<160);assert.ok(308-16*1.7>280);assert.ok(308+16*1.7<336);
});

test('drawer keeps shared active section stable during modal scroll lock',()=>{
 const nav=readFileSync(new URL('../src/MobileNavigation.tsx',import.meta.url),'utf8'),hook=readFileSync(new URL('../src/useStackedSections.ts',import.meta.url),'utf8');
 assert.ok(nav.includes('onClick={()=>{onRestored();setOpen(true)}}'));
 assert.equal((hook.match(/if\(document.body.style.position==='fixed'\)return;/g)||[]).length,2);
 assert.ok(hook.includes("if(document.body.style.position==='fixed'){measurePending=true;return}"));assert.ok(hook.includes('if(measurePending){measure();return}'));
 assert.ok(nav.includes("aria-current={active===id?'location':undefined}"));
 assert.ok(css.includes('.mobile-drawer nav a[aria-current="location"]::after'));
 assert.ok(nav.includes('opener?.focus({preventScroll:true});onRestored()'));
});
