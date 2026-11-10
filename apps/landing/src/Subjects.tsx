import type {CSSProperties} from 'react';
import {useLayoutEffect,useRef,useState} from 'react';
import {Calculator,Atom,BookOpen,FlaskConical,Leaf,Landmark,ArrowUpRight,ArrowLeft,X,CirclePlay,PencilLine,ClipboardCheck,ChevronsRight,Video,FileText} from 'lucide-react';
import {SubjectArt} from './SubjectArt';
export const subjects=[
 {name:'Matematika',Icon:Calculator}, {name:'Fizika',Icon:Atom},
 {name:'Ona tili va adabiyot',Icon:BookOpen}, {name:'Kimyo',Icon:FlaskConical},
 {name:'Biologiya',Icon:Leaf}, {name:'Tarix',Icon:Landmark}
];
const stepIcons=[BookOpen,CirclePlay,PencilLine,ClipboardCheck,ChevronsRight];
const steps=[
 ['Boshlanish nuqtasi','Noldan boshlash yoki ixtiyoriy bilimni baholash orqali boshlanish nuqtasini tanlash.'],
 ['Videodars','Tanlangan mavzuni tushuntirish va misollar orqali o‘rganish.'],
 ['Mashq','O‘rganilgan bilimni mustahkamlash uchun mashqlar bajarish.'],
 ['Bilimni tekshirish','Mavzu bo‘yicha test: 70% dan yuqori natija — keyingi mavzu; 70% yoki undan past natija — takrorlash va qayta urinish.'],
 ['Keyingi mavzu','Oldingi mavzuni o‘zlashtirgach, yo‘lni navbatdagi mavzu bilan davom ettirish.']
];
export function Subjects(){
 const [backdropBlur,setBackdropBlur]=useState(4);
 const [selected,setSelected]=useState<number|null>(null);
 const dialog=useRef<HTMLDialogElement>(null);
 const carousel=useRef<HTMLDivElement>(null);
 const [current,setCurrent]=useState(0);
 const moveTo=(index:number)=>{
  const track=carousel.current,card=track?.children[index] as HTMLElement|undefined;if(!track||!card)return;
  const left=card.getBoundingClientRect().left-track.getBoundingClientRect().left+track.scrollLeft-(track.clientWidth-card.getBoundingClientRect().width)/2;
  track.scrollTo({left,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
 };
 const trackPosition=()=>{
  const track=carousel.current;if(!track)return;
  const center=track.getBoundingClientRect().left+track.clientWidth/2;
  let nearest=0,distance=Infinity;
  Array.from(track.children).forEach((card,index)=>{const rect=card.getBoundingClientRect(),d=Math.abs(rect.left+rect.width/2-center);if(d<distance){distance=d;nearest=index}});
  setCurrent(nearest);
 };
 const [closing,setClosing]=useState(false);
 const closeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const requestClose=()=>{
  if(!dialog.current?.open || closeTimer.current!==null)return;
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){dialog.current.close();return}
  setClosing(true);
  // Always release modality even if animation events are interrupted or unavailable.
  closeTimer.current=setTimeout(()=>dialog.current?.close(),160);
 };
 useLayoutEffect(()=>{
  if(selected===null)return;
  const card=dialog.current!,root=document.documentElement,body=document.body;
  const scrollY=window.scrollY,opener=document.activeElement as HTMLElement|null;
  const bodyWidth=body.getBoundingClientRect().width;
  const saved={overflow:root.style.overflow,position:body.style.position,top:body.style.top,width:body.style.width};
  root.style.overflow='hidden';body.style.position='fixed';body.style.top=`-${scrollY}px`;body.style.width=`${bodyWidth}px`;
  card.showModal();
  return()=>{
   if(closeTimer.current!==null){clearTimeout(closeTimer.current);closeTimer.current=null}setClosing(false);
   card.close();root.style.overflow=saved.overflow;body.style.position=saved.position;body.style.top=saved.top;body.style.width=saved.width;
   window.scrollTo({top:scrollY,behavior:'instant'});opener?.focus({preventScroll:true});
  };
 },[selected]);
 const subject=selected===null?null:subjects[selected];
 return <><p id="subject-swipe-help" className="subject-swipe-help">Yon tomonga suring va fanni tanlang.</p><div ref={carousel} id="subject-carousel" className="subject-grid" onScroll={trackPosition}>{subjects.map(({name,Icon},index)=><article className="subject-card" key={name}>
  <button className="subject-summary" type="button" aria-label={`${name}: o‘rganish yo‘lini ko‘rish`} aria-haspopup="dialog" onClick={()=>setSelected(index)}><SubjectArt index={index}/><span className="subject-card-copy"><span className="ico"><Icon aria-hidden="true"/></span><span className="subject-name">{name}</span><span className="subject-card-description">Boshlanish, videodars, mashq va bilimni tekshirish — o‘rganish yo‘li bilan tanishing.</span><span className="subject-link">Yo‘lni ko‘rish <ArrowUpRight aria-hidden="true"/></span></span></button>
 </article>)}</div>
 <div className="subject-carousel-controls" role="group" aria-label="Fanlar kartochkalari bo‘yicha yurish"><button type="button" aria-label="Oldingi fan" aria-controls="subject-carousel" disabled={current===0} onClick={()=>moveTo(current-1)}>←</button><div className="subject-carousel-dots">{subjects.map(({name},index)=><button key={name} type="button" aria-label={`${name} kartochkasiga o‘tish`} aria-current={current===index?'true':undefined} aria-controls="subject-carousel" onClick={()=>moveTo(index)}><span/></button>)}</div><button type="button" aria-label="Keyingi fan" aria-controls="subject-carousel" disabled={current===subjects.length-1} onClick={()=>moveTo(current+1)}>→</button></div>
 <dialog ref={dialog} style={{'--subject-backdrop-blur':`${backdropBlur}px`} as CSSProperties} className={`subject-modal${closing?' is-closing':''}`} onCancel={e=>{e.preventDefault();requestClose()}} onClick={e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)requestClose()}} aria-labelledby="subject-modal-title" aria-describedby="subject-modal-description" onClose={()=>setSelected(null)} onKeyDown={e=>{
  if(e.key!=='Tab')return;
  const items=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')).filter(item=>item.getClientRects().length>0);
  const first=items[0],last=items[items.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
 }}>
  {subject&&<><header className="subject-modal-header"><h2 id="subject-modal-title">{subject.name} — o‘rganish yo‘li</h2><label className="subject-blur-control">Fon xiraligi <input type="range" min="0" max="16" step="1" value={backdropBlur} onChange={e=>setBackdropBlur(Number(e.target.value))} aria-valuetext={`${backdropBlur} piksel`}/><output>{backdropBlur} px</output></label><button type="button" className="subject-modal-close" aria-label="Fan kartochkasini yopish" autoFocus onClick={requestClose}><X aria-hidden="true"/></button></header>
   <div className="subject-modal-scroll" tabIndex={0}><div className="subject-modal-art"><SubjectArt index={selected!}/><div className="subject-introduction"><div className="subject-video-placeholder"><Video aria-hidden="true"/><h3>Kirish videosi</h3><p>Hali mavjud emas</p></div><h3>Fan haqida</h3><p>{subject.name} fanini videodarslar, mashqlar va bilimni tekshirish bosqichlari orqali o‘rganish yo‘li.</p><div className="subject-module-note"><FileText aria-hidden="true"/><div><h4>Darslar va modullar</h4><p>Darslar va testlarni boshlash, natijalarni saqlash hali ulanmagan.</p></div></div></div></div><div className="subject-modal-path"><p id="subject-modal-description" className="subject-description">Bu fan uchun taklif etilayotgan o‘rganish tartibi. Darslar va testlarni boshlash, natijalarni saqlash hali ulanmagan.</p><div className="subject-map-title">O‘rganish tartibi</div><ol className="learning-path">{steps.map(([title,text],i)=>{const StepIcon=stepIcons[i];return <li key={title}><span className="step-number" aria-hidden="true"><StepIcon focusable="false"/></span><div><h4>{title}</h4><p>{text}</p></div></li>})}</ol><div className="subject-actions"><button type="button" className="btn btn-p" onClick={()=>window.alert(`${subject.name}: darslarni boshlash hali ulanmagan. Bu o‘rganish yo‘lining ko‘rinishi.`)}>Boshlash</button><button type="button" className="btn btn-g" onClick={requestClose}><ArrowLeft aria-hidden="true" size={18}/> Fanlarga qaytish</button></div></div></div>
  </>}
 </dialog></>;
}
