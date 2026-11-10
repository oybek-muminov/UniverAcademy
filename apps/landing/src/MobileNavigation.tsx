import {useLayoutEffect,useRef,useState} from 'react';
import {Menu,X,Home,BookOpen,ClipboardCheck,Info,LogIn} from 'lucide-react';
const links=[['top','Bosh sahifa',Home],['fanlar','Fanlar',BookOpen],['test','Bilimni baholash',ClipboardCheck],['haqida','Platforma haqida',Info]] as const;
export function MobileNavigation({active,onNavigate,onLogin,onRestored}:{active:string;onNavigate:(id:string)=>void;onLogin:()=>void;onRestored:()=>void}){
 const [open,setOpen]=useState(false),drawer=useRef<HTMLDialogElement>(null),afterClose=useRef<(()=>void)|null>(null);
 useLayoutEffect(()=>{
  if(!open)return;
  const node=drawer.current!,body=document.body,root=document.documentElement,opener=document.activeElement as HTMLElement|null;
  const y=window.scrollY,width=body.getBoundingClientRect().width;
  const saved={position:body.style.position,top:body.style.top,width:body.style.width,overflow:root.style.overflow};
  root.style.overflow='hidden';body.style.position='fixed';body.style.top=`-${y}px`;body.style.width=`${width}px`;
  node.showModal();
  const desktop=window.matchMedia('(min-width:701px)');
  const leaveMobile=()=>{if(desktop.matches)node.close()};
  desktop.addEventListener('change',leaveMobile);
  const followHistory=()=>{afterClose.current=()=>onNavigate(decodeURIComponent(location.hash.slice(1)||'top'));node.close()};
  window.addEventListener('popstate',followHistory);window.addEventListener('hashchange',followHistory);
  return()=>{
   desktop.removeEventListener('change',leaveMobile);window.removeEventListener('popstate',followHistory);window.removeEventListener('hashchange',followHistory);node.close();
   body.style.position=saved.position;body.style.top=saved.top;body.style.width=saved.width;root.style.overflow=saved.overflow;
   window.scrollTo({top:y,behavior:'instant'});opener?.focus({preventScroll:true});onRestored();
   const action=afterClose.current;afterClose.current=null;if(action)requestAnimationFrame(action);
  };
 },[open]);
 const close=()=>drawer.current?.close();
 const choose=(action:()=>void)=>{if(afterClose.current)return;afterClose.current=action;close()};
 return <><button className="mobile-menu-toggle" aria-label="Menyuni ochish" aria-expanded={open} aria-controls="mobile-menu" onClick={()=>{onRestored();setOpen(true)}}><Menu aria-hidden="true"/></button>
 <dialog id="mobile-menu" ref={drawer} className="mobile-drawer" aria-labelledby="mobile-menu-title" onClose={()=>setOpen(false)} onClick={e=>{if(e.target!==e.currentTarget)return;const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()}} onKeyDown={e=>{
  if(e.key!=='Tab')return;const items=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button,a[href]'));const first=items[0],last=items[items.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
 }}>
  <div className="drawer-brand"><span className="logo"><img className="brand-mark" src="/brand/favicon-512.png" alt=""/>UniverAcademy</span><button autoFocus className="drawer-close" aria-label="Menyuni yopish" onClick={close}><X aria-hidden="true"/></button></div>
  <h2 id="mobile-menu-title">Menyu</h2><nav aria-label="Mobil bo‘limlar">{links.map(([id,label,Icon])=><a key={id} href={`#${id}`} aria-current={active===id?'location':undefined} onClick={e=>{e.preventDefault();e.stopPropagation();choose(()=>onNavigate(id))}}><Icon aria-hidden="true"/>{label}</a>)}</nav>
  <button className="btn btn-p drawer-login" onClick={()=>choose(onLogin)}>Kirish <LogIn aria-hidden="true"/></button>
  <img className="drawer-art" src="/brand/mobile-learning.svg" alt=""/>
 </dialog></>;
}
