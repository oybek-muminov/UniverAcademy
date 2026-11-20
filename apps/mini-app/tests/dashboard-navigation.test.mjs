import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {runInNewContext} from 'node:vm';
function nodes(node) {
 if (!node || typeof node !== 'object') return [];
 if (typeof node.tag === 'function') return nodes(node.tag(node.props));
 return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}
test('dashboard top-right becomes Testlar and returns to tests, not a second back control',async()=>{
 const source=await readFile(new URL('../src/student-app.tsx',import.meta.url),'utf8');
 const out=await transformWithOxc(source,'student-app.tsx',{jsx:{runtime:'automatic'}});
 let hook=0,dashboard='p1',reads=0;
 const flow={state:{student:{person:'p1',firstName:'A',lastName:'B'},screen:'exams',exams:[]},showExams:async()=>{reads++}};
 const context={lazy:()=>null,useMemo:fn=>fn(),useState:v=>hook++===0?[dashboard,value=>dashboard=value]:[v,()=>{}],useSyncExternalStore:()=>flow.state,useEffect(){},useRef:()=>({current:null}),AccountDashboard:'AccountDashboard',_jsx:(tag,props)=>({tag,props}),_jsxs:(tag,props)=>({tag,props}),_Fragment:'fragment'};
 runInNewContext(out.code.replace(/^import .*;\s*$/gm,'').replace(/^export /gm,''),context);
 let tree=context.StudentApp({studentFlow:flow,mode:'telegram'});
 const button=nodes(tree).find(n=>n.props?.className==='dashboard-button');
 assert.equal(button.props.children,'Testlar');button.props.onClick();assert.equal(dashboard,null);assert.equal(reads,1);
 hook=0;tree=context.StudentApp({studentFlow:flow,mode:'telegram'});
 assert.equal(nodes(tree).find(n=>n.props?.className==='dashboard-button').props.children,'Dashboard');
 assert.doesNotMatch(source,/Kabinetga qaytish/);
});
