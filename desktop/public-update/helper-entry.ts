import { runHelper } from "./helper.ts";
// This is a standalone bundled-Node entry, not an Electron process.
// Never imports provider authentication, environment credentials or app settings.
const plan = process.argv.length === 3 ? process.argv[2] : "";
runHelper(plan, (nonce) => {
  if (!process.send) throw Error("IPC_REQUIRED");
  process.send({ type: "ready", nonce });
}).catch(() => {
  process.exitCode = 1;
});
