import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {runInNewContext} from 'node:vm';
const jsx=(tag,props)=>({tag,props});
function nodes(node){if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
async function load(file,context){
 const source=await readFile(new URL('../src/account-deletion-candidate/'+file,import.meta.url),'utf8');
 const {code}=await transformWithOxc(source,file,{jsx:{runtime:'automatic'}});
 runInNewContext(code.replace(/^import .*;\s*$/gm,'').replace(/^export /gm,''),context);
 return source;
}
test('unavailable message only mounts on action and clears across repeated Dashboard/Testlar navigation',async()=>{
 let notice='',actions;
 const context={useState:()=>[notice,v=>notice=v],DeletionUnavailableDialog:'Dialog',SavedDeletionRecoveryLink:'RecoveryLink',_Fragment:'fragment',_jsx:jsx,_jsxs:jsx};
 await load('host.tsx',context);
 const render=enabled=>context.UnavailableHost({enabled,children:value=>{actions=value;return jsx('cabinet',{});}});
 for(let n=0;n<3;n++){
  let view=render(false);
  assert.equal(nodes(view).some(x=>x.tag==='Dialog'),false);
  assert.equal(nodes(view).some(x=>x.props?.role==='status'),false);
  actions.onDeleteAccount();
  view=render(false);
  const dialog=nodes(view).find(x=>x.tag==='Dialog');
  assert.equal(dialog.props.message,'Hisobni o‘chirish hali yoqilmagan.');
  dialog.props.onClose();
  for(const screen of ['Testlar','Dashboard','Testlar']) {
   view=render(false);
   assert.equal(nodes(view).some(x=>x.tag==='Dialog'),false,screen);
  }
 }
 let view=render(true);actions.onDeleteAccount();view=render(true);
 assert.match(nodes(view).find(x=>x.tag==='Dialog').props.message,/Clerk hisobingizga qayta kirishingiz/);
});
test('native dialog labels, focus target, Escape and cleanup are accessible and non-destructive',async()=>{
 let effect,closed=0,shows=0,closes=0,prevented=0;
 const dialog={open:false,showModal(){shows++;this.open=true},close(){closes++;this.open=false}};
 const context={useRef:()=>({current:dialog}),useEffect:fn=>effect=fn,_jsx:jsx,_jsxs:jsx};
 await load('unavailable-dialog.tsx',context);
 const tree=context.DeletionUnavailableDialog({message:'disabled',onClose:()=>closed++});
 assert.equal(tree.tag,'dialog');
 assert.equal(tree.props['aria-labelledby'],'deletion-unavailable-title');
 assert.equal(tree.props['aria-describedby'],'deletion-unavailable-message');
 const button=nodes(tree).find(x=>x.tag==='button');assert.equal(button.props.autoFocus,true);
 const cleanup=effect();assert.equal(shows,1);
 button.props.onClick();assert.equal(closed,1);
 tree.props.onCancel({preventDefault(){prevented++}});assert.equal(closed,2);assert.equal(prevented,1);
 tree.props.onClose();assert.equal(closed,3);
 cleanup();assert.equal(closes,1);
});
test('enabled host remains routed to original ReadyHost; unavailable state cannot survive branch replacement',async()=>{
 const context={useSession:()=>({session:{status:'active',id:'session',user:{id:'user'}}}),useMemo:f=>f(),_jsx:jsx,_jsxs:jsx};
 await load('host.tsx',context);
 const binding={personId:'person'};
 const ready=context.AccountDeletionHost({binding,enabled:true,children(){}});
 assert.equal(ready.tag.name,'ReadyHost');
 const disabled=context.AccountDeletionHost({binding,enabled:false,children(){}});
 assert.equal(disabled.tag.name,'UnavailableHost');
 assert.notEqual(ready.tag,disabled.tag);
});
