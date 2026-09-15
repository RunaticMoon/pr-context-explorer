import { createApp } from "./http.ts";
process.umask(0o077);
const port = Number(process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("invalid port");
const app = await createApp(port);
app.listen(port, "127.0.0.1", () =>
  console.log(`PR Context Explorer (Demo + Live): http://127.0.0.1:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => app.close(() => process.exit(0)));
