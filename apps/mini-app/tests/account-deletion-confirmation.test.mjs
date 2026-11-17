import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';
import {runInNewContext} from 'node:vm';
import {matchesCabinetConfirmation} from '../src/account-deletion-candidate/confirmation.ts';
const displayId='0123456789';
test('confirmation accepts only exact ten ASCII digits, preserves leading zero and rejects missing ID',()=>{
 assert.equal(matchesCabinetConfirmation(displayId,displayId),true);
 for(const entered of ['', '123456789', '0123456788',' 0123456789','0123456789 ','０１２３４５６７８９','01234567890'])
  assert.equal(matchesCabinetConfirmation(displayId,entered),false);
 for(const id of [undefined,'','123','ua-0123456789']) assert.equal(matchesCabinetConfirmation(id,id??''),false);
});
function nodes(node){if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
async function panelHarness(){
 const source=await readFile(new URL('../src/account-deletion-candidate/panel.tsx',import.meta.url),'utf8');
 const out=await transformWithOxc(source,'panel.tsx',{jsx:{runtime:'automatic'}});
 let entered='';const calls=[];
 const context={_Fragment:'fragment',matchesCabinetConfirmation,useState:()=>[entered,value=>entered=value],useSyncExternalStore:(_subscribe,snapshot)=>snapshot(),
  _jsx:(tag,props)=>({tag,props}),_jsxs:(tag,props)=>({tag,props})};
 runInNewContext(out.code.replace(/^import .*;\s*$/gm,'').replace(/^export /gm,''),context);
 const controller={confirm:value=>calls.push(value),cancel:()=>calls.push('cancel')};
 const render=id=>context.ConfirmDeletion({controller,cabinetDisplayId:id});
 return {render,calls,reset:()=>{entered=''}};
}
test('actual confirmation form blocks empty/wrong ID even programmatic submit; exact ID invokes existing confirmation then Clerk controller',async()=>{
 const h=await panelHarness();
 for(const entered of ['', '0123456788',displayId]){
  let form=h.render(displayId);
  nodes(form).find(n=>n.tag==='input').props.onChange({target:{value:entered}});
  form=h.render(displayId);
  const submit=nodes(form).find(n=>n.props?.type==='submit');
  assert.equal(submit.props.disabled,entered!==displayId);
  form.props.onSubmit({preventDefault(){}});
 }
 assert.deepEqual(h.calls,['delete-account-v1']);
 const form=h.render(undefined);
 assert.equal(nodes(form).some(n=>n.tag==='input'),false);
 assert.equal(nodes(form).find(n=>n.props?.type==='submit').props.disabled,true);
 form.props.onSubmit({preventDefault(){}});
 assert.deepEqual(h.calls,['delete-account-v1']);
});
test('cancel is non-destructive and remounted confirmation starts empty',async()=>{
 const h=await panelHarness();let form=h.render(displayId);
 nodes(form).find(n=>n.tag==='input').props.onChange({target:{value:displayId}});
 nodes(form).find(n=>n.props?.type==='button').props.onClick();
 assert.deepEqual(h.calls,['cancel']);
 h.reset();form=h.render(displayId);
 assert.equal(nodes(form).find(n=>n.props?.type==='submit').props.disabled,true);
});
test('UI ID confirmation does not replace fresh Clerk proof or enter request body',async()=>{
 const host=await readFile(new URL('../src/account-deletion-candidate/host.tsx',import.meta.url),'utf8');
 assert.match(host,/useReverification\(async/);assert.match(host,/getToken\(\{skipCache:true\}\)/);
 assert.match(host,/afterMinutes:4/);assert.match(host,/cabinetDisplayId=\{cabinetDisplayId\}/);
 assert.match(host,/<SavedDeletionRecoveryLink\/>/);
 const port=await readFile(new URL('../src/account-deletion-candidate/http-port.ts',import.meta.url),'utf8');
 assert.doesNotMatch(port,/cabinetDisplayId|entered/);
});
