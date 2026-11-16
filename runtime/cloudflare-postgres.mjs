import {isHyperdriveConnectionString} from "./hyperdrive-connection-string.mjs";
import {StorageUnavailable} from "../supabase/functions/univeracademy-api/storage/postgres-transaction.ts";
import {transactionPoolPort} from "../supabase/functions/univeracademy-api/storage/transaction-pool-port.ts";

export const POSTGRES_DRIVER_MINIMUM="8.16.3";
const unavailable=()=>new StorageUnavailable("not_committed");
// Server-only, bounded diagnostics. Never emit messages, SQL, connection data or
// arbitrary error properties. A broken log sink cannot change failure behavior.
function diagnostic(phase,error){
  try{
    const code=error&&Object.getOwnPropertyDescriptor(error,"code");
    const value=code&&Object.hasOwn(code,"value")?code.value:undefined;
    const known={ECONNRESET:"CONNECTION_RESET",ECONNREFUSED:"CONNECTION_REFUSED",ETIMEDOUT:"TIMEOUT",
      "53300":"CONNECTION_LIMIT","57P01":"ADMIN_SHUTDOWN","08006":"CONNECTION_FAILURE","08001":"CONNECTION_FAILED"};
    const reason=typeof value==="string"&&Object.hasOwn(known,value)?known[value]:"OTHER";
    console.warn("UA_DATABASE_FAILURE",phase,reason);
  }catch{} // No raw exception and no diagnostic failure escapes.
}

// Prepared Hyperdrive binding data only. No environment/secret loading or direct
// origin TLS policy is selected here. Hyperdrive caching OFF and verified origin
// TLS, the actual pg version and Workers packaging are separate deployment gates.
function privateOptions(options){
  if(!options||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw unavailable();
  const keys=Reflect.ownKeys(options),d=Object.getOwnPropertyDescriptor(options,"connectionString");
  if(keys.length!==1||keys[0]!=="connectionString"||!d||!Object.hasOwn(d,"value")||typeof d.value!=="string")throw unavailable();
  if(!isHyperdriveConnectionString(d.value))throw unavailable();
  return Object.freeze({connectionString:d.value,connectionTimeoutMillis:5000});
}
function noAmbientPg(){
  // Names only, immediately before the sole constructor boundary. No PG value
  // is inspected or cleared. Workers without a process environment have none.
  const environment=globalThis.process?.env;
  if(environment&&Reflect.ownKeys(environment).some(k=>typeof k==="string"&&k.startsWith("PG")))throw unavailable();
}

/** Create INSIDE one request. One owned, lazy Client; sequential leases only.
 * No Pool/global client, cross-request reuse, replacement client or SQL retry.
 * The owner awaits close before acknowledging. A pending/failed end is not a
 * successful close. Fake constructors cannot prove pg/Hyperdrive/TLS behavior.
 */
export function createCloudflarePostgres(Client,options,{signal}={}){
  if(typeof Client!=="function"||(signal!==undefined&&!(signal instanceof AbortSignal)))throw unavailable();
  const config=privateOptions(options);
  let driver,connected=false,pending=false,leased=false,closed=false,closePromise;
  const blocked=()=>closed||signal?.aborted;
  function close(){
    closed=true;signal?.removeEventListener("abort",abort);
    return closePromise??=Promise.resolve().then(()=>{
      if(!driver)return;
      const ending=driver.end();
      if(!(ending instanceof Promise))throw unavailable();
      return ending;
    }).then(()=>undefined,error=>{diagnostic("CLOSE",error);throw unavailable();});
  }
  const abort=()=>{void close().catch(()=>{});};
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  async function cancellable(work){
    let stop;
    try{
      if(blocked())throw unavailable();
      const cancelled=new Promise((_,reject)=>{stop=()=>reject(unavailable());signal?.addEventListener("abort",stop,{once:true});});
      return await Promise.race([Promise.resolve().then(()=>{if(blocked())throw unavailable();return work();}),cancelled]);
    }finally{signal?.removeEventListener("abort",stop);}
  }
  const port=transactionPoolPort({async connect(){
    if(blocked()||pending||leased)throw unavailable();pending=true;
    try{
      if(!driver){
        noAmbientPg(); // No await or queued path between this guard and new Client.
        driver=new Client(config);
        if(typeof driver?.connect!=="function"||typeof driver.query!=="function"||typeof driver.end!=="function"||typeof driver.on!=="function")throw unavailable();
        driver.on("error",error=>{diagnostic("DRIVER_ERROR",error);void close().catch(()=>{});}); // Retained through close.
      }
      if(!connected){try{await cancellable(()=>driver.connect());}catch(error){diagnostic("CONNECT",error);throw error;}connected=true;}
      if(blocked())throw unavailable();leased=true;let released=false;
      return {async query(statement){
        if(released||blocked())throw unavailable();
        try{return await cancellable(()=>driver.query(statement));}catch(error){diagnostic("QUERY",error);throw unavailable();}
      },release(discard=false){
        if(released)return;released=true;leased=false;
        if(discard)void close().catch(()=>{});
      }};
    }catch{void close().catch(()=>{});throw unavailable();}
    finally{pending=false;}
  }});
  return Object.freeze({pool:port,close});
}
