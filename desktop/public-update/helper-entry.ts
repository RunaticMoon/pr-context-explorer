import {
  runHelper,
  reportHelperFailure,
  sendHelperMessage,
} from "./helper.ts";
// This is a standalone bundled-Node entry, not an Electron process.
// Never imports provider authentication, environment credentials or app settings.
const plan = process.argv.length === 3 ? process.argv[2] : "";
let announced = false;
runHelper(plan, (nonce) => {
  if (!process.send) throw Error("IPC_REQUIRED");
  sendHelperMessage({ type: "ready", nonce });
  announced = true;
}).catch(async (error) => {
  const code = await reportHelperFailure(plan, error);
  // The parent may already have disconnected; the file receipt is authoritative.
  if (announced) sendHelperMessage({ type: "failed", code });
  process.exitCode = 1;
});
