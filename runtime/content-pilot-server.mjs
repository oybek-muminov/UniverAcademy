import { pathToFileURL } from "node:url";
import { startUngroupedServer } from "./ungrouped-server.mjs";
import { createContentPilotLab } from "./content-pilot-lab.mjs";

export const startContentPilotServer = ({ port = 0, lab = createContentPilotLab() } = {}) =>
  startUngroupedServer({ port, lab });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const local = await startContentPilotServer({ port: Number(process.argv[2] ?? 8792) });
  console.log(JSON.stringify(local.run));
  const stop = async () => { await local.close(); process.exit(0); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
