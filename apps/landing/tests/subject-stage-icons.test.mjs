import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/Subjects.tsx',import.meta.url),'utf8');
test('five semantic decorative icons replace digits without removing stage labels',()=>{
 assert.ok(source.includes('const stepIcons=[BookOpen,CirclePlay,PencilLine,ClipboardCheck,ChevronsRight]'));
 assert.ok(source.includes('aria-hidden="true"><StepIcon focusable="false"/>'));
 assert.ok(!source.includes('{i+1}'));
 for(const label of ['Boshlanish nuqtasi','Videodars','Mashq','Bilimni tekshirish','Keyingi mavzu'])assert.ok(source.includes(label));
});
