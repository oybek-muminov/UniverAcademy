import {useEffect, useRef, useState} from 'react';

/** Native document scrolling: no wheel/touch interception or scroll lock. */
export function useStackedSections() {
  const headerRef=useRef<HTMLElement>(null);
  const mainRef=useRef<HTMLElement>(null);
  const [active,setActive]=useState('top');
  const navigateRef=useRef<(id:string)=>void>(()=>{});
  const refreshRef=useRef<()=>void>(()=>{});
  useEffect(()=>{
    const header=headerRef.current, main=mainRef.current;
    if(!header || !main) return;
    const panels=Array.from(main.querySelectorAll<HTMLElement>('[data-stack-panel]'));
    const previousRestoration=history.scrollRestoration;
    history.scrollRestoration='manual';
    const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    let starts:number[]=[], headerHeight=68, frame=0, measureFrame=0, measurePending=false;
    const update=()=>{
      frame=0;
      // Modal scroll lock temporarily makes scrollY zero; keep the real section.
      if(document.body.style.position==='fixed')return;
      if(measurePending){measure();return}
      header.dataset.scrolled=String(window.scrollY>1);
      // The incoming board becomes current once it covers half the usable screen.
      const line=window.scrollY+headerHeight+(window.innerHeight-headerHeight)/2;
      let current=0;
      for(let i=0;i<starts.length;i++) if(starts[i]<=line) current=i;
      setActive(panels[current]?.dataset.nav || 'top');
    };
    const measure=()=>{
      if(document.body.style.position==='fixed'){measurePending=true;return}
      measurePending=false;
      headerHeight=header.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--nav-height',`${headerHeight}px`);
      let start=main.getBoundingClientRect().top+window.scrollY;
      starts=panels.map((panel,i)=>{
        const height=panel.getBoundingClientRect().height;

        // Tall content scrolls fully before its bottom-aware hold begins.
        panel.style.setProperty('--panel-top',`${Math.min(headerHeight,window.innerHeight-height)}px`);
        panel.style.setProperty('--panel-layer',String(i+1));
        // Sticky rects move; flow starts include the nonvisual delay margin.
        const value=start;
        start+=height+parseFloat(getComputedStyle(panel).marginBottom);
        return value;
      });
      update();
    };
    refreshRef.current=measure;
    const scheduleMeasure=()=>{
      cancelAnimationFrame(measureFrame);
      measureFrame=requestAnimationFrame(measure);
    };
    const scheduleUpdate=()=>{if(!frame) frame=requestAnimationFrame(update)};
    const navigate=(id:string,focus:boolean,smooth:boolean)=>{
      // Keep old shared anchors usable after the requested label/ID rename.
      const target=id==='yollar'?'fanlar':id;
      const i=panels.findIndex(panel=>panel.id===target);
      if(i<0) return false;
      measure();
      if(focus) panels[i].focus({preventScroll:true});
      window.scrollTo({top:Math.max(0,starts[i]-headerHeight),behavior:smooth&&!reduced.matches?'smooth':'instant'});
      return true;
    };
    navigateRef.current=(id)=>{if(location.hash!==`#${id}`)history.pushState(null,'',`#${id}`);navigate(id,true,false)};
    const click=(event:MouseEvent)=>{
      if(event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link=(event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
      if(!link || !link.hash) return;
      const id=decodeURIComponent(link.hash.slice(1));
      if(!panels.some(p=>p.id===id) && id!=='yollar') return;
      event.preventDefault();
      if(location.hash!==link.hash) history.pushState(null,'',link.hash);
      navigate(id,true,true);
    };
    const restore=()=>navigate(decodeURIComponent(location.hash.slice(1)||'top'),false,false);
    const focus=(event:FocusEvent)=>{
      if(document.body.style.position==='fixed')return;
      const target=event.target as HTMLElement;
      const panel=target.closest<HTMLElement>('[data-stack-panel]');
      if(!panel || target===panel) return;
      const i=panels.indexOf(panel);
      // Keyboard focus must never remain behind a later, covering board.
      const covered=i<panels.length-1 && window.scrollY+headerHeight>=starts[i+1];
      if(covered) navigate(panel.id,false,false);
      const visible=target.getBoundingClientRect();
      if(visible.bottom>window.innerHeight) window.scrollBy({top:visible.bottom-window.innerHeight+16,behavior:'instant'});
      else if(visible.top<headerHeight) window.scrollBy({top:visible.top-headerHeight-16,behavior:'instant'});
    };
    const observer=new ResizeObserver(scheduleMeasure);
    observer.observe(header);panels.forEach(panel=>observer.observe(panel));
    measure();
    requestAnimationFrame(restore);
    document.addEventListener('click',click);
    document.addEventListener('focusin',focus);
    window.addEventListener('scroll',scheduleUpdate,{passive:true});
    window.addEventListener('resize',scheduleMeasure);
    window.visualViewport?.addEventListener('resize',scheduleMeasure);
    window.addEventListener('popstate',restore);
    window.addEventListener('hashchange',restore);
    reduced.addEventListener('change',scheduleMeasure);
    return ()=>{
      history.scrollRestoration=previousRestoration;
      observer.disconnect();cancelAnimationFrame(frame);cancelAnimationFrame(measureFrame);
      document.removeEventListener('click',click);document.removeEventListener('focusin',focus);
      window.removeEventListener('scroll',scheduleUpdate);window.removeEventListener('resize',scheduleMeasure);
      window.visualViewport?.removeEventListener('resize',scheduleMeasure);
      navigateRef.current=()=>{};refreshRef.current=()=>{};
      window.removeEventListener('popstate',restore);window.removeEventListener('hashchange',restore);
      reduced.removeEventListener('change',scheduleMeasure);
    };
  },[]);
  return {active,headerRef,mainRef,navigateTo:(id:string)=>navigateRef.current(id),refreshLayout:()=>refreshRef.current()};
}
