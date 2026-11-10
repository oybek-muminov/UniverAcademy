// IncomingMessage.close also fires for a normally completed request body.
// Abort only an incomplete input or a response connection closed before finish.
export function nodeRequestAbort(input,output){
  const controller=new AbortController();
  const abort=()=>controller.abort();
  const closed=()=>{if(!output.writableFinished)abort();cleanup();};
  const cleanup=()=>{input.off("aborted",abort);output.off("close",closed);output.off("finish",cleanup);};
  input.once("aborted",abort);output.once("close",closed);output.once("finish",cleanup);
  if(input.aborted||output.destroyed)abort();
  return {signal:controller.signal,cleanup};
}
