import {useEffect,useState} from 'react';
import {createRecoveryIndex,RECOVERY_INDEX_CHANGED} from './recovery.ts';

type IndexStorage = Parameters<typeof createRecoveryIndex>[0];
/** Only a local visibility decision. Never checks a server or grants account access. */
export function hasUnresolvedRecovery(storage: () => IndexStorage): boolean {
  try { return createRecoveryIndex(storage()).readPending().length > 0; }
  catch { return false; }
}

/** Public recovery remains directly accessible even if storage is unavailable. */
export function SavedDeletionRecoveryLink() {
  const [visible,setVisible]=useState(false);
  useEffect(()=>{
    const read=()=>setVisible(hasUnresolvedRecovery(()=>localStorage));
    read();
    window.addEventListener('storage',read);
    window.addEventListener('pageshow',read);
    window.addEventListener('focus',read);
    window.addEventListener(RECOVERY_INDEX_CHANGED,read);
    return()=>{
      window.removeEventListener('storage',read);
      window.removeEventListener('pageshow',read);
      window.removeEventListener('focus',read);
      window.removeEventListener(RECOVERY_INDEX_CHANGED,read);
    };
  },[]);
  return visible ? <a href="/account-deletion-status">Saqlangan o‘chirish natijasini tekshirish</a> : null;
}
