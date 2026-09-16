import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createEngineSetupService } from "../src/server/engine-setup.ts";
import { probeProviders } from "../src/server/ai/index.ts";
import { probeCli } from "../src/server/ai/probes.ts";
test(
  "a native probe output-limit failure preserves installation and fails compatibility",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await realpath(await mkdtemp("/tmp/discovery-native-"));
    try {
      await writeFile(
        `${root}/fake.c`,
        "#include <stdio.h>\nint main(){for(int i=0;i<300000;i++)putchar(120);return 0;}",
      );
      execFileSync("/usr/bin/cc", [`${root}/fake.c`, "-o", `${root}/codex`]);
      await chmod(`${root}/codex`, 0o700);
      const result = await probeCli("codex", {
        executablePath: `${root}/codex`,
      });
      assert.equal(result.executablePath, `${root}/codex`);
      assert.equal(result.capabilities.supported, false);
      assert.deepEqual(result.capabilities.missing, ["output_limit"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "unknown native CLI runs only credential-free fixed probes and honours cancellation",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await realpath(await mkdtemp("/tmp/discovery-native-"));
    try {
      await writeFile(
        `${root}/fake.c`,
        '#include <stdio.h>\n#include <stdlib.h>\nint main(){if(getenv("GH_TOKEN")||getenv("ANTHROPIC_API_KEY")||getenv("OPENAI_API_KEY"))return 3;puts("codex-cli 999.0.0");return 0;}',
      );
      execFileSync("/usr/bin/cc", [`${root}/fake.c`, "-o", `${root}/codex`]);
      await chmod(`${root}/codex`, 0o700);
      const calls: string[][] = [];
      const result = await probeCli(
        "codex",
        { executablePath: `${root}/codex` },
        undefined,
        (args, r) => {
          assert.equal(r.exitCode, 0);
          calls.push(args);
        },
      );
      assert.equal(result.capabilities.supported, false);
      assert.deepEqual(
        calls.sort(),
        [
          ["--help"],
          ["--version"],
          ["exec", "--help"],
          ["features", "list"],
        ].sort(),
      );
      await assert.rejects(
        probeCli(
          "codex",
          { executablePath: `${root}/codex` },
          AbortSignal.abort(),
        ),
        { code: "cancelled" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("provider probes reject pre-abort instead of returning fallback status", async () => {
  await assert.rejects(probeProviders({}, AbortSignal.abort()), {
    code: "cancelled",
  });
});

test(
  "closing engine setup cancels streaming native probes and reaps their PIDs",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await realpath(await mkdtemp("/tmp/discovery-cancel-"));
    let service: ReturnType<typeof createEngineSetupService> | undefined;
    try {
      await writeFile(
        `${root}/fake.c`,
        `#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
int main(){int fd=open("${root}/pids",O_WRONLY|O_CREAT|O_APPEND,0600);dprintf(fd,"%d\\n",getpid());close(fd);for(;;){puts("streaming");fflush(stdout);usleep(20000);}}`,
      );
      execFileSync("/usr/bin/cc", [`${root}/fake.c`, "-o", `${root}/codex`]);
      await chmod(`${root}/codex`, 0o700);
      service = createEngineSetupService({
        providers: {
          codex: { executablePath: `${root}/codex` },
          claude: { executablePath: `${root}/codex` },
        },
      });
      const pending = service.status();
      const rejection = assert.rejects(pending, { code: "cancelled" });
      const deadline = Date.now() + 3000;
      let pids: number[] = [];
      while (Date.now() < deadline) {
        try {
          pids = (await readFile(`${root}/pids`, "utf8"))
            .trim()
            .split(/\s+/)
            .map(Number);
        } catch {}
        if (pids.length === 6) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(pids.length, 6, "all fixed credential-free probes started");
      const start = Date.now();
      service.close();
      await rejection;
      assert.ok(Date.now() - start < 500, "API cancellation is immediate");
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const reapDeadline = Date.now() + 3000;
      while (pids.some(alive) && Date.now() < reapDeadline)
        await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(pids.filter(alive), [], "no probe child remains");
    } finally {
      service?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
