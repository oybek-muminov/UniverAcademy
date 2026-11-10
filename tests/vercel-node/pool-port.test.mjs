import {test} from "node:test";
import assert from "node:assert/strict";
import {transactionPoolPort} from "../../supabase/functions/univeracademy-api/storage/transaction-pool-port.ts";
import {PostgresTransactions} from "../../supabase/functions/univeracademy-api/storage/postgres-transaction.ts";

const person="00000000-0000-4000-8000-000000000001";
test("transaction pool port strips every Statement.name, preserves parameterization and uses one checked-out driver client through COMMIT",async()=>{
  const calls=[],releases=[];let connections=0;
  const driver={connect:async()=>{
    connections++;return{query:async q=>{
      assert.deepEqual(Object.keys(q).sort(),["text","values"]);calls.push(q);
      if(q.text.includes("ORDER BY id FOR UPDATE"))return{rows:[{id:person}],rowCount:1};
      if(q.text.includes("clock_timestamp()"))return{rows:[{now_ms:"10000"}],rowCount:1};
      return{rows:[],rowCount:0};
    },release:discard=>releases.push(discard)};
  }};
  const runner=new PostgresTransactions(transactionPoolPort(driver));
  const payload="synthetic '; DROP TABLE x; --";
  const value=await runner.run([person],async tx=>{await tx.client.query({name:"never_prepare_this_name",text:"SELECT $1::text",values:[payload]});return"committed";});
  assert.equal(value,"committed");assert.equal(connections,1);assert.equal(calls[0].text,"BEGIN");assert.equal(calls.at(-1).text,"COMMIT");
  assert.equal(calls.find(q=>q.text==="SELECT $1::text").values[0],payload);
  assert.ok(calls.every(q=>!q.text.includes(payload)));assert.deepEqual(releases,[false]);
});

test("pool bridge forwards transaction advisory locks and unknown COMMIT discard without retry or a false ACK",async()=>{
  let connections=0,commits=0;const releases=[],texts=[];
  const driver={connect:async()=>{connections++;return{
    query:async q=>{
      assert.ok(!Object.hasOwn(q,"name"));texts.push(q.text);
      if(q.text==="COMMIT"){commits++;throw Error("synthetic outcome unknown");}
      if(q.text.includes("clock_timestamp()"))return{rows:[{now_ms:"10000"}],rowCount:1};
      if(q.text.includes("ORDER BY id FOR UPDATE"))return{rows:[{id:person}],rowCount:1};
      return{rows:[],rowCount:0};
    },release:discard=>releases.push(discard),
  };}};
  const runner=new PostgresTransactions(transactionPoolPort(driver));
  await assert.rejects(runner.runIdentity(4000000402,async gate=>{assert.equal(gate.telegramId,4000000402);return person;},async()=>"must not ACK"),
    e=>e.status===503&&e.outcome==="commit_unknown");
  assert.equal(connections,1);assert.equal(commits,1);assert.deepEqual(releases,[true]);
  assert.ok(texts.includes("SELECT pg_advisory_xact_lock($1::bigint)"));assert.ok(!texts.some(s=>/pg_advisory_lock\(/.test(s)));
});

test("pool bridge retains callback exception identity and rollback/release, and rejects a malformed driver without fallback",async()=>{
  const calls=[],releases=[],fault=Error("synthetic callback failure");
  const driver={connect:async()=>({query:async q=>{calls.push(q.text);return q.text.includes("FOR UPDATE")?{rows:[{id:person}],rowCount:1}:q.text.includes("clock_timestamp")?{rows:[{now_ms:"10000"}],rowCount:1}:{rows:[],rowCount:0};},release:d=>releases.push(d)})};
  await assert.rejects(new PostgresTransactions(transactionPoolPort(driver)).run([person],async()=>{throw fault;}),e=>e===fault);
  assert.equal(calls.at(-1),"ROLLBACK");assert.ok(!calls.includes("COMMIT"));assert.deepEqual(releases,[false]);
  assert.throws(()=>transactionPoolPort({}),e=>e.status===503);
  let discard=false;await assert.rejects(transactionPoolPort({connect:async()=>({release:d=>{discard=d;}})}).connect(),e=>e.status===503);assert.equal(discard,true);
});
