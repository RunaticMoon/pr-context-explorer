import { createApp } from "../src/server/http.ts";
import { validToken } from "../src/server/session.ts";
process.umask(0o077);
let server: Awaited<ReturnType<typeof createApp>> | undefined;
let starting = false,
  stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server?.cancelDesktopJobs();
  const forced = setTimeout(() => process.exit(0), 5000);
  forced.unref();
  if (server) {
    const deadline = Date.now() + 4000;
    while (server.desktopStatus().active && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    server.closeIdleConnections();
    server.close(() => process.exit(0));
  } else process.exit(0);
}
process.on("message", async (message: any) => {
  if (
    message?.type === "start" &&
    !starting &&
    validToken(message.key) &&
    typeof message.dist === "string"
  ) {
    starting = true;
    try {
      server = await createApp(0, {
        dist: message.dist,
        desktopKey: message.key,
      });
      if (message.admissionClosed === true && !server.lockDesktopAdmission())
        throw Error("Startup admission unavailable");
      server.listen(0, "127.0.0.1", () => {
        const address = server!.address();
        if (!address || typeof address === "string") return void shutdown();
        process.send?.({
          type: "ready",
          origin: `http://127.0.0.1:${address.port}`,
        });
      });
      server.on("error", () => {
        process.send?.({ type: "failed" });
        void shutdown();
      });
    } catch {
      process.send?.({ type: "failed" });
      void shutdown();
    }
  } else if (message?.type === "status" && Number.isSafeInteger(message.id))
    process.send?.({
      type: "status",
      id: message.id,
      active: server?.desktopStatus().active ?? true,
    });
  else if (
    message?.type === "admission" &&
    Number.isSafeInteger(message.id) &&
    typeof message.locked === "boolean"
  ) {
    const ok =
      !!server &&
      (message.locked
        ? server.lockDesktopAdmission()
        : (server.unlockDesktopAdmission(), true));
    process.send?.({ type: "admission", id: message.id, ok });
  } else if (message?.type === "cancel") server?.cancelDesktopJobs();
  else if (message?.type === "shutdown") void shutdown();
});
process.on("disconnect", () => void shutdown());
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void shutdown());
