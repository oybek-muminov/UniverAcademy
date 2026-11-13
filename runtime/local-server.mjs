import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createSyntheticPhysicsLab } from "./local-lab.mjs";
import { ApiFault } from "../supabase/functions/univeracademy-api/fault.ts";
import {nodeRequestAbort} from "./node-request-abort.mjs";

// Local transport candidate only, not an approved production body/rate/CORS policy.
const BODY_BYTES = 64 * 1024;
function errorReply(response, status, code) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: { code, message: code, request_id: crypto.randomUUID() } }));
}

export async function startLocalServer({ port = 0, lab = createSyntheticPhysicsLab() } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("INVALID_LOCAL_PORT");
  const server = createServer(async (incoming, outgoing) => {
    const cancellation=nodeRequestAbort(incoming,outgoing);
    let dispatched = false;
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(incoming.url ?? "/", origin);
      if (url.origin !== origin) return errorReply(outgoing, 400, "MALFORMED_REQUEST");
      const chunks = [];
      let bytes = 0;
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes <= BODY_BYTES) chunks.push(chunk);
        else chunks.length = 0;
      }
      if (bytes > BODY_BYTES) return errorReply(outgoing, 400, "MALFORMED_REQUEST");
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      }
      const request = new Request(url, { method: incoming.method, headers,
        body: bytes ? Buffer.concat(chunks) : undefined,signal:cancellation.signal });
      dispatched = true;
      const reply = await lab.handler(request);
      if (outgoing.destroyed) return;
      outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
      outgoing.end(Buffer.from(await reply.arrayBuffer()));
    } catch (error) {
      // Never log incoming proofs/body or reflect exception text.
      if (error instanceof ApiFault) errorReply(outgoing, error.status, error.code);
      else errorReply(outgoing, dispatched ? 500 : 400, dispatched ? "INTERNAL_ERROR" : "MALFORMED_REQUEST");
    }finally{if(outgoing.destroyed||outgoing.writableFinished)cancellation.cleanup();}
  });
  server.requestTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", reject); resolve();
    });
  });
  return { server, lab, baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance = await startLocalServer({ port: Number(process.argv[2] ?? 8789) });
  console.log(JSON.stringify({ status: "LOCAL_RAM_SYNTHETIC_CANDIDATE", baseUrl: instance.baseUrl,
    policiesApproved: false, realTelegram: false, durableDB: false }));
  const stop = async () => { await instance.close(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
