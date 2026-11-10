import {StorageUnavailable} from "./postgres-transaction.ts";
import type {PgPool,Rows} from "./postgres-transaction.ts";

// node-postgres shape only. No pg dependency/constructor, URL or network access.
type DriverPool={connect():Promise<{
  query(statement:{text:string;values:unknown[]}):Promise<Rows>;
  release(discard?:boolean):void;
}>};
export function transactionPoolPort(driver:DriverPool):PgPool {
  if(typeof driver?.connect!=="function")throw new StorageUnavailable("not_committed");
  return {async connect(){
    const client=await driver.connect();
    if(typeof client?.query!=="function"||typeof client.release!=="function"){
      if(typeof client?.release==="function")client.release(true);
      throw new StorageUnavailable("not_committed");
    }
    return {
      // Statement.name is an internal repository label. Sending it to pg would
      // enable named prepared statements, unsupported by shared transaction pooling.
      query:statement=>client.query({text:statement.text,values:[...statement.values]}),
      release:discard=>client.release(discard),
    };
  }};
}
