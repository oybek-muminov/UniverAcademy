import { pathToFileURL } from "node:url";
import { startLocalServer } from "./local-server.mjs";
import { createUngroupedLab } from "./ungrouped-lab.mjs";

export async function startUngroupedServer({ port = 0, lab = createUngroupedLab() } = {}) {
  const local = await startLocalServer({ port, lab });
  return { ...local, run: { ...lab.run, baseUrl: local.baseUrl } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const local = await startUngroupedServer({ port: Number(process.argv[2] ?? 8791) });
  console.log(JSON.stringify(local.run)); // no session, initData or staff proof in run metadata
  const stop = async () => { await local.close(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
