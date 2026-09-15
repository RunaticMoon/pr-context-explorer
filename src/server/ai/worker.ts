import { fileURLToPath } from "node:url";
import { startEgressProxy } from "./egress.ts";
import {
  buildBwrapArgs,
  cleanEnvironment,
  resolveBwrap,
  sandboxRuntime,
  type ReadOnlyMount,
  type SandboxConfig,
} from "./sandbox.ts";
import { runBoundedProcess, type ProcessRequest } from "./runner.ts";
import type { PreparedAuth } from "./auth.ts";
import type { ProviderId } from "./events.ts";
/** No injectable shell, runner or mount list in the public config. */
export async function runIsolatedCommand(input: {
  provider: ProviderId;
  executablePath: string;
  args: string[];
  scratch: string;
  auth: PreparedAuth;
  sandbox?: SandboxConfig;
  schemaFile?: string;
  process: Pick<
    ProcessRequest,
    | "stdin"
    | "signal"
    | "deadlineMs"
    | "inactivityMs"
    | "maxStdoutBytes"
    | "maxStderrBytes"
    | "onStdout"
  >;
}) {
  const runtime = await sandboxRuntime(
      input.executablePath,
      input.process.signal,
    ),
    executable = await resolveBwrap(input.sandbox);
  const socket = `${input.scratch}/egress.sock`,
    proxy = await startEgressProxy(input.provider, socket);
  try {
    const files: ReadOnlyMount[] = [
      ...input.auth.files,
      {
        source: fileURLToPath(new URL("./launcher.cjs", import.meta.url)),
        target: "/runtime/launcher.cjs",
      },
      { source: socket, target: "/runtime/egress.sock" },
      ...(input.schemaFile
        ? [{ source: input.schemaFile, target: "/runtime/schema.json" }]
        : []),
    ];
    return await runBoundedProcess({
      ...input.process,
      executable,
      args: buildBwrapArgs({
        ...runtime,
        files,
        command: [
          "/runtime/node",
          "/runtime/launcher.cjs",
          "/runtime/egress.sock",
          "/runtime/engine",
          ...input.args,
        ],
      }),
      cwd: input.scratch,
      env: { ...cleanEnvironment(), ...input.auth.env },
    });
  } finally {
    await proxy.close();
  }
}
