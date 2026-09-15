import { transform, build } from "esbuild";
import {
  readdir,
  mkdir,
  readFile,
  writeFile,
  cp,
  rm,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
const out = path.join(root, "desktop/build");
// Compilation owns generated application/runtime output, not the separately
// checksum-verified host sidecar installed by desktop:prepare. CI rebuilds here
// between prepare and Electron launch; removing node prevents any first window.
// Refuse a foreign output target before enumerating or removing any children.
const previous = await lstat(out).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (previous && (!previous.isDirectory() || previous.isSymbolicLink()))
  throw new Error("Unsafe desktop build root: expected a real directory");
await mkdir(out, { recursive: true });
const current = await lstat(out);
if (!current.isDirectory() || current.isSymbolicLink())
  throw new Error("Unsafe desktop build root: expected a real directory");
for (const name of await readdir(out))
  if (name !== "node")
    await rm(path.join(out, name), { recursive: true, force: true });
const runtime = path.join(out, "runtime");
async function compile(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name),
      dest = path.join(to, entry.name);
    if (entry.isDirectory()) await compile(source, dest);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      const text = await readFile(source, "utf8");
      const result = await transform(text, {
        loader: "ts",
        format: "esm",
        target: "node24",
        sourcefile: source,
      });
      // Preserve the module tree and import.meta.url; includes trusted dynamic module specifiers.
      const js = result.code.replace(
        /(["'])(\.{1,2}\/[^"']+)\.ts\1/g,
        "$1$2.js$1",
      );
      await writeFile(dest.replace(/\.ts$/, ".js"), js);
    } else if (!entry.name.endsWith(".d.ts")) await cp(source, dest);
  }
}
await compile("src/server", path.join(runtime, "src/server"));
await mkdir(path.join(runtime, "desktop"), { recursive: true });
const backend = await transform(await readFile("desktop/backend.ts", "utf8"), {
  loader: "ts",
  format: "esm",
  target: "node24",
});
await writeFile(
  path.join(runtime, "desktop/backend.js"),
  backend.code.replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, "$1$2.js$1"),
);
await writeFile(
  path.join(runtime, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
for (const name of [
  "typescript",
  "ajv",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
])
  await cp("node_modules/" + name, path.join(runtime, "node_modules", name), {
    recursive: true,
  });
await cp(
  "references/pr-context-reviewer-prompts/runtime",
  path.join(runtime, "references/pr-context-reviewer-prompts/runtime"),
  { recursive: true },
);
await cp("dist", path.join(runtime, "dist"), { recursive: true });
let mainMeta;
if (!process.argv.includes("--runtime-only")) {
  mainMeta = await build({
    metafile: true,
    entryPoints: ["desktop/main.ts"],
    outfile: path.join(out, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    define: {
      __PRCE_SIGNED_BUILD__: JSON.stringify(
        process.env.PRCE_RELEASE_SIGNED === "1",
      ),
      __PRCE_TEAM_ID__: JSON.stringify(process.env.PRCE_APPLE_TEAM_ID || ""),
    },
  });
  await build({
    entryPoints: ["desktop/preload.ts"],
    outfile: path.join(out, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  });
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await mkdir(path.join(out, "app"), { recursive: true });
if (!process.argv.includes("--runtime-only")) {
  await cp(path.join(out, "main.cjs"), path.join(out, "app/main.cjs"));
  await cp(path.join(out, "preload.cjs"), path.join(out, "app/preload.cjs"));
  await writeFile(
    path.join(out, "app/package.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      private: true,
      main: "main.cjs",
      description: pkg.description,
      author: pkg.author,
    }),
  );
  const notices = [];
  const packageDirs = new Set(
    [
      "@fontsource/noto-sans-kr",
      "@xyflow/react",
      "@xyflow/system",
      "react",
      "react-dom",
      "scheduler",
      "zustand",
      "use-sync-external-store",
      "d3-drag",
      "d3-dispatch",
      "d3-selection",
      "d3-zoom",
      "d3-transition",
      "d3-interpolate",
      "d3-color",
      "d3-ease",
      "d3-timer",
      "classcat",
      "typescript",
      "ajv",
      "fast-deep-equal",
      "fast-uri",
      "json-schema-traverse",
      "require-from-string",
    ].map((n) => "node_modules/" + n),
  );
  for (const input of Object.keys(mainMeta?.metafile.inputs || {})) {
    const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/);
    if (match) packageDirs.add(match[1]);
  }
  for (const base of [...packageDirs].sort()) {
    const name = base.replace(/^.*node_modules\//, "");
    const meta = JSON.parse(await readFile(base + "/package.json", "utf8"));
    const files = (await readdir(base)).filter((n) =>
      /^licen[sc]e(?:\.|$)/i.test(n),
    );
    notices.push(
      name +
        " " +
        meta.version +
        " (" +
        meta.license +
        ")\n" +
        (
          await Promise.all(files.map((n) => readFile(base + "/" + n, "utf8")))
        ).join("\n"),
    );
  }
  await writeFile(
    path.join(out, "app/THIRD-PARTY-NOTICES.txt"),
    notices.join("\n\n---\n\n") +
      "\n\nElectron licenses are in the application Frameworks; Node license is Resources/node/LICENSE.",
  );
}
// Runtime cleanup above removes the old helper. Rebuild for the host on every
// Darwin build, including --runtime-only. No compiler is invoked by the app.
if (process.platform === "darwin") {
  execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/build-macos-acl.mjs"),
      "--arch",
      process.arch === "x64" ? "x86_64" : process.arch,
    ],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 120000,
    },
  );
}
console.log("Desktop runtime compiled to " + out);
