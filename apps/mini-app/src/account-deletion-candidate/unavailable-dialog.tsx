import {useEffect,useRef} from 'react';

/** Informational only. Native modal traps focus and makes background controls inert. */
export function DeletionUnavailableDialog({message,onClose}:{message:string;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const dialog=ref.current;
    if(dialog&&!dialog.open)dialog.showModal();
    return()=>{if(dialog?.open)dialog.close()};
  },[]);
  return <dialog ref={ref} aria-labelledby="deletion-unavailable-title" aria-describedby="deletion-unavailable-message"
    onClose={onClose} onCancel={event=>{event.preventDefault();onClose()}}>
    <h2 id="deletion-unavailable-title">Hisobni o‘chirish</h2>
    <p id="deletion-unavailable-message">{message}</p>
    <button type="button" className="primary" autoFocus onClick={onClose}>Tushunarli</button>
  </dialog>;
}
