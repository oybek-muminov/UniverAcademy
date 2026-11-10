import {useEffect,useRef,useState} from 'react';
import {useReducedMotion} from 'framer-motion';
const roadD='M100 486C340 476 350 380 205 360S60 290 210 250 350 190 235 140 120 92 235 36';
/** Animation copied from owner attachment F0CCJLHHU22; only labels adapted. */
export function Road(){
 const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width:700px)').matches);
 useEffect(()=>{const media=window.matchMedia('(max-width:700px)');const update=()=>setMobile(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update)},[]);
 const path=useRef<SVGPathElement>(null),nodes=useRef<SVGGElement>(null);
 const reduced=useReducedMotion();
 useEffect(()=>{
  if(mobile||!path.current||!nodes.current)return;
  const road=path.current,g=nodes.current;
  const labels=road.closest('.map')!.querySelector<HTMLElement>('.road-labels')!;labels.replaceChildren();
  g.replaceChildren();road.style.strokeDasharray="1 3000";
  const timers:ReturnType<typeof setTimeout>[]=[];let frame=0;
  const cleanup=()=>{timers.forEach(clearTimeout);cancelAnimationFrame(frame);g.replaceChildren();labels.replaceChildren()};
  var L=road.getTotalLength();
  var N:[number,string,string][]=[[.0,"Birinchi qadamni tashlang","d"],[.25,"Intizom eng muhim konikmadir","d"],[.5,"mashlar sizni yanada kuchli qiladi!","c"],[.75,"bilimlarni tekshirish","l"],[1,"siz eng zoriga loyiqsin","s"]];
  const ns="http://www.w3.org/2000/svg";
  N.forEach(function(n,i){
    var p=road.getPointAtLength(L*n[0]),el=document.createElementNS(ns,"g");el.setAttribute("class","node node-"+n[2]);
    var t=n[2],fill=t==="l"?"#fff":(t==="s"?"#F0A22E":(t==="c"?"#A8203A":"#17787F")),st=t==="l"?"#EBD9BC":"#fff";
    var h="";
    if(t==="c")h+='<circle class="practice-halo" cx="'+p.x+'" cy="'+p.y+'" r="31" fill="#A8203A"/>';
    if(t==="c")h+='<circle class="pulse" cx="'+p.x+'" cy="'+p.y+'" r="24" fill="#A8203A"/>';
    if(t==="s")h+='<circle class="result-halo" cx="'+p.x+'" cy="'+p.y+'" r="33" fill="#F0A22E"/>';
    h+='<circle class="node-core" cx="'+p.x+'" cy="'+p.y+'" r="24" fill="'+fill+'" stroke="'+st+'" stroke-width="5"/>';
    if(t==="d")h+='<path d="M'+(p.x-9)+' '+p.y+'l6 6 12-12" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>';
    if(t==="c")h+='<path d="M'+(p.x-5)+' '+(p.y-9)+'l13 9-13 9z" fill="#fff"/>';
    if(t==="l")h+='<g class="assessment-gate" transform="translate('+p.x+' '+p.y+')"><circle class="gate-track" r="32" fill="none" stroke="#EBD9BC" stroke-width="3"/><circle class="gate-progress" r="32" fill="none" stroke="#F0A22E" stroke-width="3.5" stroke-linecap="round" transform="rotate(-90)"/><path class="gate-body" d="M-7-2h14v10h-14z" fill="none" stroke="#B9A78C" stroke-width="2.4" stroke-linejoin="round"/><path class="gate-shackle" d="M-4-2v-4a4 4 0 018 0v4" fill="none" stroke="#B9A78C" stroke-width="2.4" stroke-linecap="round"/></g>';
    if(t==="s")h+='<path d="M'+p.x+' '+(p.y-11)+'l3.2 6.8 7.4 1-5.4 5.2 1.3 7.3-6.5-3.6-6.5 3.6 1.3-7.3-5.4-5.2 7.4-1z" fill="#5C1127"/>';
    const label=document.createElement('span');label.className='road-label label-'+i;label.textContent=n[1];labels.append(label);
    el.innerHTML=h;g.appendChild(el);
    el.style.animationDelay=(0.3+n[0]*2.1)+"s";
    timers.push(setTimeout(function(){el.classList.add("on")},(0.3+n[0]*2.1)*1000));
  });
  var reduce=matchMedia("(prefers-reduced-motion:reduce)").matches;
  if(reduce){road.style.strokeDasharray="none";g.querySelectorAll<SVGGElement>(".node").forEach(function(e){e.classList.add("on")});return cleanup}
  var s:number|null=null;
  function f(ts:number){if(!s)s=ts;var k=Math.min((ts-s)/2400,1),e=1-Math.pow(1-k,3);road.style.strokeDasharray=(L*e)+" 3000";if(k<1)frame=requestAnimationFrame(f)}
  frame=requestAnimationFrame(f);

  return cleanup;
 },[reduced,mobile]);
 if(mobile)return null;
 return <div className="map" aria-label="Barcha fanlar uchun o‘quv yo‘li namunasi"><svg viewBox="0 0 420 520" role="img" aria-label="Qadamlar yo‘li — tasviriy namuna. Tekshiruvdan o‘tish keyingi mavzuga yo‘l ochishini ko‘rsatuvchi animatsiya; haqiqiy test natijasi emas."><path id="roadb" d={roadD}/><path id="road" ref={path} d={roadD}/><g id="nodes" ref={nodes}/></svg><div className="road-labels" aria-hidden="true"/><div className="chip" style={{left:0,top:'8%'}}>✦ Barcha fanlar</div><div className="chip" style={{right:0,top:'46%'}}>✦ O‘z sur’atingizda</div><div className="chip start-chip" style={{left:'2%',bottom:'12%'}}>Har kim boshlashi mumkin</div></div>;
}
