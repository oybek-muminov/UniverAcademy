import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { party } from './credentials.mjs';

export const studentOrigin='https://mini.stage-classroom.example.com';
export const apiOrigin='https://api.stage-classroom.example.com';
export function routes(api,role,token) {
  const origin=role==='student'?studentOrigin:party;
  function call(tail,method='GET',body,headers={}) {
    const destination=role==='student'?apiOrigin:origin;
    return api.fetch(new Request(destination+'/api/v1/'+role+'/pilot/'+tail,{
      method, headers:{origin,authorization:'Bearer '+token,...headers},body
    }));
  }
  return {
    dashboard:()=>call('dashboard'),
    command:(action,input,key=randomUUID())=>call('commands/'+action,'POST',JSON.stringify(input),{
      'content-type':'application/json','idempotency-key':key
    }),
    upload:(input,type)=>call('media','POST',input,{'content-type':type,'idempotency-key':randomUUID()}),
    image:id=>call('media/'+id),call
  };
}
export async function good(reply) {
  const r=await reply;
  const payload=await r.json();
  assert.ok(r.ok,'HTTP '+r.status+': '+JSON.stringify(payload));
  assert.ok(Object.hasOwn(payload,'data'),'Expected a success data envelope.');
  return payload.data;
}
export async function rejected(reply,status) {
  const r=await reply;
  const body=await r.json();
  if(status) assert.equal(r.status,status,JSON.stringify(body));
  else assert.ok(r.status>=400&&r.status<500,'HTTP '+r.status+': '+JSON.stringify(body));
  assert.ok(!Object.hasOwn(body,'data'));
}

export function richDocument(assetId) {
  const opts=['2 m/s','5 m/s','10 m/s','15 m/s'].map(markdown=>({id:randomUUID(),blocks:[{type:'text',markdown}]}));
  opts[1].blocks.push({type:'formula',latex:String.raw`\frac{20}{4}`,display:'inline'});
  const question={
    id:randomUUID(),position:1,expected_revision:0,
    prompt_blocks:[
      {type:'text',markdown:'20 metr masofani 4 soniyada bosib o‘tdi. Tezlik qaysi?'},
      {type:'formula',latex:String.raw`\frac{s}{t}`,display:'block'},
      {type:'image',asset_id:assetId,alt:'Masofa va vaqt grafigi'}
    ],
    options:opts,correct_option_id:opts[1].id,
    explanation_blocks:[{type:'text',markdown:'Maxsus o‘qituvchi izohi'}]
  };
  return {title:'Tekis harakat',duration_seconds:300,questions:[question]};
}
export const graphSvg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="50"><path d="M8 42L85 8" stroke="green" fill="none"/></svg>');
