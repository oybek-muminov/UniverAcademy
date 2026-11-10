import {createServer} from "node:http";
import {pathToFileURL} from "node:url";
import {createConfiguredHttpHandler} from "../supabase/functions/univeracademy-api/configured-http.ts";
import {withLocalCors} from "./local-cors.mjs";
import {nodeRequestAbort} from "./node-request-abort.mjs";

export async function startConfiguredServer({config,port=0,allowedOrigins=[]}={}){
  if(!Number.isInteger(port)||port<0||port>65535)throw Error("INVALID_LOCAL_PORT");
  const handler=withLocalCors(createConfiguredHttpHandler(config),allowedOrigins);
  const server=createServer(async(input,output)=>{
    const cancellation=nodeRequestAbort(input,output);
    let dispatched=false;
    try{
      const origin=`http://127.0.0.1:${server.address().port}`,url=new URL(input.url??"/",origin);
      if(url.origin!==origin)throw Error("MALFORMED_REQUEST");
      const chunks=[];let size=0;
      for await(const chunk of input){size+=chunk.length;if(size>65536)throw Error("MALFORMED_REQUEST");chunks.push(chunk);}
      const headers=new Headers();for(let i=0;i<input.rawHeaders.length;i+=2)headers.append(input.rawHeaders[i],input.rawHeaders[i+1]);
      const request=new Request(url,{method:input.method,headers,body:size?Buffer.concat(chunks):undefined,signal:cancellation.signal});
      dispatched=true;const response=await handler(request);
      if(output.destroyed)return;
      const bytes=Buffer.from(await response.arrayBuffer());if(output.destroyed)return;
      output.writeHead(response.status,Object.fromEntries(response.headers));output.end(bytes);
    }catch{
      if(output.destroyed||output.writableEnded)return;
      const code=dispatched?"INTERNAL_ERROR":"MALFORMED_REQUEST",status=dispatched?500:400;
      output.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
      output.end(JSON.stringify({error:{code,message:code,request_id:crypto.randomUUID()}}));
    }finally{if(output.destroyed||output.writableFinished)cancellation.cleanup();}
  });
  server.requestTimeout=10000;
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port},()=>{server.off("error",reject);resolve();});});
  return {server,baseUrl:`http://127.0.0.1:${server.address().port}/api/v1`,close:()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  // No environment sniffing or fixture fallback. Server-supplied production
  // configuration is intentionally absent in this no-provider local candidate.
  const local=await startConfiguredServer({config:{mode:"production"},port:Number(process.argv[2]??8793)});
  console.log(JSON.stringify({baseUrl:local.baseUrl,readiness:"CONFIG_REQUIRED",unconfigured_status:503}));
  const stop=async()=>{await local.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);
}
