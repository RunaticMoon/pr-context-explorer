import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestPull } from "../src/server/ingest.ts";
import type { Connection } from "../src/server/github.ts";
const url = process.argv[2];
if (!url)
  throw Error(
    "Usage: npm run smoke:public -- https://github.com/owner/repo/pull/number",
  );
const connection: Connection = {
  id: "public-smoke",
  type: "github",
  webUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  apiVersion: "2022-11-28",
  account: "public",
  auth: { kind: "public" },
};
const root = mkdtempSync(path.join(tmpdir(), "prce-public-smoke-"));
const start = performance.now();
try {
  const s = await ingestPull(connection, url, root, {
    onProgress: (message) => console.log(message),
  });
  console.log(
    JSON.stringify(
      {
        verification:
          "actual public unauthenticated GitHub HTTPS + Git fetch; no model transmission",
        snapshotId: s.snapshotId,
        repository: s.pr.repository,
        number: s.pr.number,
        baseSha: s.baseSha,
        headSha: s.headSha,
        mergeBaseShas: s.mergeBaseShas,
        phases: s.phases.length,
        coverage: s.coverage,
        durationMs: Math.round(performance.now() - start),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
