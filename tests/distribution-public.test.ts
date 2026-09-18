import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const script = resolve("distribution/public-manifest.py");
const source = "RunaticMoon/pr-context-explorer";
const releaseName = "v0.6.1 — personal unsigned Apple Silicon";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "public-release-test-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "0.6.1" }),
  );
  const env = {
    ...process.env,
    RELEASE_TAG: "v0.6.1",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_REPOSITORY: source,
  };
  const result = spawnSync("python3", [
    "-c",
    `import zipfile,plistlib,json,hashlib,struct,sys
from pathlib import Path
p=Path(sys.argv[1]); r='PR Context Explorer.app/Contents/Resources/'
package=json.dumps({'version':'0.6.1'}).encode(); header=json.dumps({'files':{'package.json':{'size':len(package),'offset':'0'}}}).encode(); hp=struct.pack('<I',len(header))+header; hp+=b'\\0'*((-len(hp))%4); hp=struct.pack('<I',len(hp))+hp
asar=struct.pack('<II',4,len(hp))+hp+package
with zipfile.ZipFile(p/'PR-Context-Explorer-0.6.1-arm64.zip','w') as z:
 z.writestr('PR Context Explorer.app/Contents/Info.plist',plistlib.dumps({'CFBundleShortVersionString':'0.6.1','CFBundleIdentifier':'com.runaticmoon.pr-context-explorer'}))
 z.writestr(r+'app.asar',asar)
 for name in ['node/bin/node','runtime/native/prce-macos-acl']: z.writestr(r+name,b'fixture executable')
 files={'node_modules/ajv/package.json':b'{"name":"ajv"}','node_modules/typescript/package.json':b'{"name":"typescript"}'}
 for name,data in files.items(): z.writestr(r+'runtime/'+name,data)
 z.writestr(r+'runtime/runtime-dependencies.json',json.dumps({'version':1,'roots':['typescript','ajv'],'files':{n:hashlib.sha256(d).hexdigest() for n,d in files.items()}}))
(p/'PR-Context-Explorer-0.6.1-arm64.dmg').write_bytes(b'fixture dmg')`,
    root,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  return {
    root,
    env,
    run: (args = ["generate"], extra = {}) =>
      spawnSync("python3", [script, ...args, "."], {
        cwd: root,
        env: { ...env, ...extra },
        encoding: "utf8",
      }),
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("public manifest hashes real ZIP and records the released source commit", () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(readFileSync(join(f.root, "public-mac.json"), "utf8"));
    assert.deepEqual(m, {
      schemaVersion: 1,
      channel: "public-personal-unsigned",
      repository: "RunaticMoon/pr-context-explorer",
      version: "0.6.1",
      tag: "v0.6.1",
      sourceCommit: "a".repeat(40),
      platform: "darwin",
      arch: "arm64",
      asset: {
        name: "PR-Context-Explorer-0.6.1-arm64.zip",
        size: readFileSync(join(f.root, "PR-Context-Explorer-0.6.1-arm64.zip"))
          .length,
        sha256: createHash("sha256")
          .update(
            readFileSync(join(f.root, "PR-Context-Explorer-0.6.1-arm64.zip")),
          )
          .digest("hex"),
      },
    });
  } finally {
    f.clean();
  }
});
function fakeGh(root: string) {
  writeFileSync(
    join(root, "gh"),
    `#!/usr/bin/env python3
import json,os,sys,pathlib,shutil,re
p=pathlib.Path(__file__).parent; args=sys.argv[1:]
mode=(p/'mode').read_text() if (p/'mode').exists() else ''
payload=json.load(sys.stdin) if '--input' in args else None
with (p/'calls.jsonl').open('a') as out: out.write(json.dumps({'args':args,'host':os.environ.get('GH_HOST'),'input':payload})+'\\n')
repo='RunaticMoon/pr-context-explorer'; released='a'*40
state=p/'state.json'; release=json.loads(state.read_text()) if state.exists() else None
untagged='https://github.com/'+repo+'/releases/tag/untagged-987ef9514e871504eaef'
if args[0]=='api':
 assert args[1:3]==['--hostname','github.com']; endpoint=args[3]
 m=re.search(r'/releases/(\\d+)$',endpoint)
 if endpoint=='repos/'+repo: result={'full_name':repo,'private':False}
 elif '/git/matching-refs/' in endpoint: result=[]
 elif endpoint.endswith('/releases?per_page=100'): result=[[release]] if release else [[]]
 elif endpoint.endswith('/git/refs'):
  assert payload=={'ref':'refs/tags/v0.6.1','sha':released}
  if mode=='tag-race': sys.exit(1)
  result={'ref':payload['ref'],'object':{'type':'commit','sha':released}}
 elif endpoint.endswith('/releases'):
  assert payload['draft'] is True and payload['prerelease'] is False and payload['target_commitish']==released and payload['name']=="${releaseName}"
  result={**payload,'id':123,'assets':[],'html_url':untagged}; release=result; state.write_text(json.dumps(result))
 elif endpoint.endswith('/releases/latest'): result=release
 elif m:
  rid=int(m.group(1))
  if release is None or rid != release['id']: sys.exit(22)
  if '--method' in args and args[args.index('--method')+1]=='PATCH':
   assert payload=={'draft':False,'prerelease':False,'make_latest':'true'}
   release.update(payload); state.write_text(json.dumps(release))
  result=json.loads(json.dumps(release))
  if result.get('draft') is False: result['html_url']='https://github.com/'+repo+'/releases/tag/'+result['tag_name']
  if (p/'url_override').exists(): result['html_url']=(p/'url_override').read_text().strip()
 elif '/git/ref/tags/' in endpoint: result={'object':{'type':'commit','sha':released}}
 else: raise Exception('unexpected API')
 if mode=='branch-target-field' and m: result['target_commitish']='main'
 if mode=='repo-private' and endpoint=='repos/'+repo: result['private']=True
 if mode=='repo-wrong-name' and endpoint=='repos/'+repo: result['full_name']='RunaticMoon/wrong-repo'
 if mode=='existing-tag' and '/git/matching-refs/' in endpoint: result=[{'ref':'refs/tags/v0.6.1'}]
 if mode=='existing-release' and endpoint.endswith('/releases?per_page=100'): result=[[{'tag_name':'v0.6.1','draft':True,'id':7}]]
 if mode=='tag-mismatch' and '/git/ref/tags/' in endpoint: result={'object':{'type':'commit','sha':'d'*40}}
 if mode=='extra-asset' and m and result['assets']: result['assets']=result['assets']+[{'name':'private.txt','size':1,'state':'uploaded'}]
 print(json.dumps(result))
elif args[:2]==['release','upload']:
 assert args[-2:]==['--repo','github.com/'+repo]
 release['assets']=[{'name':pathlib.Path(a).name,'size':pathlib.Path(a).stat().st_size,'state':'uploaded'} for a in args[3:-2]]; state.write_text(json.dumps(release))
elif args[:2]==['release','download']:
 assert args[args.index('--repo')+1]=='github.com/'+repo
 dest=pathlib.Path(args[args.index('--dir')+1])
 for a in release['assets']: shutil.copyfile(p/a['name'],dest/a['name'])
 if mode=='corrupt-download': (dest/'public-mac.json').write_bytes(b'corrupt')
else: raise Exception('unexpected operation')
`,
    { mode: 0o755 },
  );
}
const releaseBody = (commit: string) =>
  `Public personal unsigned Apple Silicon build. Source commit: ${commit}. Ad-hoc signed, NOT Apple Developer ID signed or notarized. macOS may require explicit first-launch approval; no Gatekeeper bypass. ZIP, DMG and public-mac.json only. Public tag targets the exact tested source commit; manifest sourceCommit records the same commit.`;
const untaggedUrl =
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/untagged-987ef9514e871504eaef";
function seedDraft(root: string, overrides: Record<string, unknown> = {}) {
  writeFileSync(
    join(root, "state.json"),
    JSON.stringify({
      id: 390511318,
      tag_name: "v0.6.1",
      draft: true,
      prerelease: false,
      name: releaseName,
      body: releaseBody("a".repeat(40)),
      assets: [],
      html_url: untaggedUrl,
      target_commitish: "a".repeat(40),
      ...overrides,
    }),
  );
}
function calls(root: string) {
  return readFileSync(join(root, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
const token = "DEDICATED_FAKE_PUBLISH_TOKEN_DO_NOT_TRANSMIT";
function runPublish(
  f: ReturnType<typeof fixture>,
  extra: Record<string, string | undefined> = {},
) {
  return spawnSync("bash", [resolve("distribution/publish-public.sh")], {
    cwd: f.root,
    env: {
      ...f.env,
      PATH: f.root + ":" + process.env.PATH,
      GH_TOKEN: token,
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      APPROVE_PUBLIC_RELEASE: "true",
      GH_HOST: "evil.invalid",
      PUBLIC_RELEASE_DIRECTORY: ".",
      ...extra,
    },
    encoding: "utf8",
  });
}
test("publisher drafts, verifies download bytes and promotes only exact public assets (fake gh; no network)", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    const r = runPublish(f);
    assert.equal(r.status, 0, r.stderr);
    const raw = readFileSync(join(f.root, "calls.jsonl"), "utf8");
    assert.ok(!raw.includes(token));
    assert.ok(!(r.stdout + r.stderr).includes(token));
    assert.ok(
      raw.indexOf("/git/refs") >= 0 &&
        raw.indexOf("/git/refs") < raw.indexOf('"POST"'),
    );
    const recorded = calls(f.root) as { args: string[] }[];
    const download = recorded.findIndex(
      (c) => c.args.slice(0, 2).join("/") === "release/download",
    );
    const promote = recorded.findIndex((c) => c.args.includes("PATCH"));
    assert.ok(download >= 0, "verification download must be recorded");
    assert.ok(
      recorded[download].args.includes(
        "github.com/RunaticMoon/pr-context-explorer",
      ),
      "verification download must be pinned to the public repository",
    );
    assert.ok(promote > download, "download readback must precede promotion");
    const published = JSON.parse(
      readFileSync(join(f.root, "state.json"), "utf8"),
    );
    assert.equal(published.draft, false);
    assert.ok(published.html_url.includes("/releases/tag/untagged-"));
    assert.equal(
      JSON.parse(readFileSync(join(f.root, "public-mac.json"), "utf8"))
        .sourceCommit,
      "a".repeat(40),
    );
  } finally {
    f.clean();
  }
});
for (const mode of [
  "repo-private",
  "repo-wrong-name",
  "existing-tag",
  "existing-release",
])
  test(`publisher fails closed before any mutation: ${mode} (fake gh only)`, () => {
    const f = fixture();
    try {
      assert.equal(f.run().status, 0);
      fakeGh(f.root);
      writeFileSync(join(f.root, "mode"), mode);
      const r = runPublish(f);
      assert.notEqual(r.status, 0);
      const calls = readFileSync(join(f.root, "calls.jsonl"), "utf8");
      assert.ok(!calls.includes("PATCH"));
      assert.ok(!calls.includes("delete"));
      assert.ok(!calls.includes("--clobber"));
      assert.ok(!calls.includes(token));
      assert.ok(!calls.includes("POST"));
    } finally {
      f.clean();
    }
  });
for (const mode of ["extra-asset", "corrupt-download"])
  test(`publisher fails closed after upload without promotion: ${mode} (fake gh only)`, () => {
    const f = fixture();
    try {
      assert.equal(f.run().status, 0);
      fakeGh(f.root);
      writeFileSync(join(f.root, "mode"), mode);
      const r = runPublish(f);
      assert.notEqual(r.status, 0);
      const c = calls(f.root);
      assert.ok(!c.some((x) => x.args.includes("PATCH")));
      assert.ok(!c.some((x) => x.args.includes("DELETE")));
      assert.ok(!c.some((x) => x.args.includes("--clobber")));
      assert.ok(!readFileSync(join(f.root, "calls.jsonl"), "utf8").includes(token));
      assert.ok(!(r.stdout + r.stderr).includes(token));
    } finally {
      f.clean();
    }
  });
for (const extra of [
  { RELEASE_TAG: "v0.6.1;bad" },
  { RELEASE_TAG: "v00.6.1" },
  { GITHUB_SHA: "A".repeat(40) },
  { GITHUB_REPOSITORY: "wrong/repo" },
  { APPROVE_PUBLIC_RELEASE: "false" },
  { GITHUB_ACTIONS: "false" },
])
  test(`invalid context fails before any GitHub call: ${JSON.stringify(extra)}`, () => {
    const f = fixture();
    try {
      assert.equal(f.run().status, 0);
      fakeGh(f.root);
      assert.notEqual(runPublish(f, extra).status, 0);
      assert.throws(() => readFileSync(join(f.root, "calls.jsonl")));
    } finally {
      f.clean();
    }
  });
function addEntry(root: string, name: string, data: string) {
  const r = spawnSync("python3", [
    "-c",
    `import zipfile,sys
with zipfile.ZipFile(sys.argv[1],'a',compression=zipfile.ZIP_DEFLATED) as z: z.writestr(sys.argv[2],sys.argv[3])`,
    join(root, "PR-Context-Explorer-0.6.1-arm64.zip"),
    name,
    data,
  ]);
  assert.equal(r.status, 0);
}
for (const name of [
  "PR Context Explorer.app/Contents/Resources/.env",
  "PR Context Explorer.app/Contents/Resources/.git/config",
  "PR Context Explorer.app/Contents/Resources/runtime/docs/private.md",
  "PR Context Explorer.app/Contents/Resources/runtime/src/server/private.ts",
  "PR Context Explorer.app/Contents/Resources/private.key",
  "../escape",
])
  test(`ZIP audit rejects ${name}`, () => {
    const f = fixture();
    try {
      addEntry(f.root, name, "private");
      assert.notEqual(f.run().status, 0);
    } finally {
      f.clean();
    }
  });
test("compressed ZIP exact injected fake token is blocked before network and never printed", () => {
  const f = fixture();
  try {
    addEntry(
      f.root,
      "PR Context Explorer.app/Contents/Resources/runtime/src/server/public.js",
      token,
    );
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    const r = runPublish(f);
    assert.notEqual(r.status, 0);
    assert.ok(!(r.stdout + r.stderr).includes(token));
    assert.throws(() => readFileSync(join(f.root, "calls.jsonl")));
  } finally {
    f.clean();
  }
});
test("manifest unknown fields, inventory tampering and changed ZIP are rejected", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const p = join(f.root, "public-mac.json");
    const text = readFileSync(p, "utf8");
    writeFileSync(p, JSON.stringify({ ...JSON.parse(text), token: "extra" }));
    assert.notEqual(f.run(["verify"]).status, 0);
    writeFileSync(p, text);
    addEntry(
      f.root,
      "PR Context Explorer.app/Contents/Resources/runtime/node_modules/ajv/extra.js",
      "untracked",
    );
    assert.notEqual(f.run(["verify"]).status, 0);
  } finally {
    f.clean();
  }
});
test("manifest numeric impostors and duplicate keys are rejected", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    const p = join(f.root, "public-mac.json");
    const original = readFileSync(p, "utf8");
    for (const text of [
      original.replace('"schemaVersion": 1', '"schemaVersion": true'),
      original.replace('"schemaVersion": 1', '"schemaVersion": 1.0'),
      original.replace(
        '"schemaVersion": 1',
        '"schemaVersion": 1, "schemaVersion": 1',
      ),
    ]) {
      writeFileSync(p, text);
      assert.notEqual(f.run(["verify"]).status, 0);
    }
  } finally {
    f.clean();
  }
});
test("workflow gates build validation branches and publishes only from main with the workflow token", () => {
  const text = readFileSync(
    resolve(".github/workflows/macos-public-release.yml"),
    "utf8",
  );
  const [build, publish] = text.split("  publish:\n");
  assert.ok(
    build.includes("runs-on: macos-15") && build.includes("runs-on: macos-26"),
  );
  assert.equal(
    (build.match(/npm run test:public-update:mac/g) || []).length,
    2,
  );
  assert.ok(
    !text.includes("--if-present") && !text.includes("continue-on-error"),
  );
  assert.ok(!build.includes("secrets.PUBLIC_RELEASE_TOKEN"));
  assert.ok(!build.includes("secrets.GITHUB_TOKEN"));
  assert.ok(!text.includes("secrets.PUBLIC_RELEASE_TOKEN"));
  assert.ok(!text.includes("resume_draft_id"));
  assert.ok(!text.includes("RESUME"));
  assert.ok(
    publish.includes("needs: [build, macos26-install]") &&
      publish.includes("inputs.approve_public_release == true"),
  );
  assert.equal(
    (publish.match(/secrets\.GITHUB_TOKEN/g) || []).length,
    1,
  );
  assert.ok(publish.includes("permissions:") && publish.includes("contents: write"));
  assert.equal(
    (text.match(/contents: write/g) || []).length,
    1,
    "write permission must exist only on the publish job",
  );
  assert.ok(!build.includes("contents: write"));
  assert.ok(
    build.includes("test -z \"${GH_TOKEN:-}\"") &&
      publish.includes("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}"),
  );
  assert.equal(
    (
      text.match(
        /artifact-ids: \$\{\{ needs.build.outputs.artifact-id \}\}/g,
      ) || []
    ).length,
    2,
  );
  assert.equal((text.match(/digest-mismatch: error/g) || []).length, 2);
  assert.ok(publish.includes("environment: public-release"));
  assert.ok(
    !text.includes("upload-artifact") ||
      !text.includes("path: release\n          if-no-files-found"),
  );
  assert.ok(
    text.includes("branches: [feat/public*, fix/public*]"),
  );
  assert.ok(
    build.includes("startsWith(github.ref, 'refs/heads/feat/public')") &&
      build.includes("startsWith(github.ref, 'refs/heads/fix/public')"),
  );
  assert.ok(!publish.includes("feat/public"));
  assert.ok(publish.includes("github.ref == 'refs/heads/main'"));
  assert.ok(
    publish.includes("github.event_name == 'workflow_dispatch'") &&
      publish.includes("github.event.repository.visibility == 'public'"),
  );
  assert.ok(
    build.includes("github.event.repository.visibility == 'public'") &&
      !text.includes("github.event.repository.private"),
  );
  assert.ok(!text.includes("PUBLIC_RELEASE_TOKEN"));
});
test("concurrent tag creation fails without creating a release or deleting the tag", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    writeFileSync(join(f.root, "mode"), "tag-race");
    assert.notEqual(runPublish(f).status, 0);
    const calls = readFileSync(join(f.root, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.filter((c) => c.args.includes("POST")).length, 1);
    assert.ok(
      !calls.some((c) => c.args.includes("PATCH") || c.args.includes("DELETE")),
    );
    assert.throws(() => readFileSync(join(f.root, "state.json")));
  } finally {
    f.clean();
  }
});
test("resolved public tag is authoritative when release target_commitish is a branch label", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    writeFileSync(join(f.root, "mode"), "branch-target-field");
    const result = runPublish(f);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    f.clean();
  }
});
test("validation diagnostics identify forbidden dependency support files without printing paths or bytes", () => {
  const f = fixture();
  try {
    addEntry(f.root, "PR Context Explorer.app/Contents/Resources/runtime/node_modules/fast-uri/.github/workflows/ci.yml", token);
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.equal(r.stderr, "Public release validation failed [PRIVATE_CONFIG_CONTENT_IN_ZIP]: Private/config content in ZIP; no automatic recovery or overwrite.\n");
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr.includes(token));
    assert.ok(!r.stderr.includes("fast-uri"));
  } finally { f.clean(); }
});
test("unexpected exceptions emit only enumerated type diagnostics, never exception arguments or class names", () => {
  const f = fixture();
  try {
    for (const [expression, code] of [
      ["ValueError(secret)", "UNEXPECTED_VALUE_ERROR"],
      ["KeyError(secret)", "UNEXPECTED_KEY_ERROR"],
      ["FileNotFoundError(secret)", "UNEXPECTED_FILE_NOT_FOUND"],
      ["zipfile.BadZipFile(secret)", "UNEXPECTED_BAD_ZIP_FILE"],
      ["type(secret, (Exception,), {})(secret)", "UNEXPECTED_ERROR"],
    ]) {
      const result = spawnSync("python3", ["-c", `import json,runpy,sys,zipfile
secret=sys.argv[2]
def fail(*args, **kwargs): raise ${expression}
json.loads=fail
sys.argv=[sys.argv[1], 'generate', '.']
runpy.run_path(sys.argv[0],run_name='__main__')`, script, token], { cwd: f.root, env: f.env, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `Public release validation failed [${code}]; no automatic recovery or overwrite.\n`);
      assert.ok(!result.stderr.includes(token));
    }
  } finally { f.clean(); }
});
test("every require diagnostic is a source literal in the closed vocabulary", () => {
  const result = spawnSync("python3", ["-c", `import ast,runpy,sys
module=runpy.run_path(sys.argv[1]); tree=ast.parse(open(sys.argv[1]).read())
for node in ast.walk(tree):
 if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='require':
  assert isinstance(node.args[1],ast.Constant) and type(node.args[1].value) is str
  module['Reason'](node.args[1].value)
try: module['ValidationFailure'](sys.argv[2])
except TypeError: pass
else: raise AssertionError('untrusted diagnostic accepted')`, script, token], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
test("audit reads @electron/asar producer output, not only a hand-built header (Linux content fixture)", () => {
  const f = fixture();
  try {
    const packed = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { createPackage } from '@electron/asar';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root=process.argv[1], app=join(root,'app'); mkdirSync(app);
for (const [name, bytes] of Object.entries({'main.cjs':'// fixture main','preload.cjs':'// fixture preload','THIRD-PARTY-NOTICES.txt':'fixture notice','package.json':JSON.stringify({version:'0.6.1',main:'main.cjs'})})) writeFileSync(join(app,name), bytes);
await createPackage(app,join(root,'producer.asar'));
`, f.root], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const replaced = spawnSync("python3", ["-c", `import zipfile,sys,pathlib
p=pathlib.Path(sys.argv[1]); original=p/'PR-Context-Explorer-0.6.1-arm64.zip'; temp=p/'repacked.zip'
with zipfile.ZipFile(original) as src, zipfile.ZipFile(temp,'w') as dst:
 for item in src.infolist(): dst.writestr(item,(p/'producer.asar').read_bytes() if item.filename.endswith('/app.asar') else src.read(item))
temp.replace(original)`, f.root], { encoding: "utf8" });
    assert.equal(replaced.status, 0, replaced.stderr);
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
  } finally { f.clean(); }
});
for (const bad of [
  "http://github.com/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0",
  "https://evil.invalid/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0",
  "https://github.com.evil.invalid/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0",
  "https://user:pw@github.com/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0",
  "https://github.com:443/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0",
  "https://github.com/RunaticMoon/other-repo/releases/tag/v0.6.0",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0?x=1",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0#f",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0/extra",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/v0.6.0%20",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/untagged-",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/untagged-987EF9514e871504eaef",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/untagged-987ef9514e871504eaef/extra",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/untagged-987ef9514e871504eaef?x=1",
  "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/untagged-987ef9514e871504eaef%2f..",
  `https://github.com/RunaticMoon/pr-context-explorer/releases/tag/untagged-${"9".repeat(65)}`,
])
  test(`release html_url audit rejects ${bad} (fake gh)`, () => {
    const f = fixture();
    try {
      assert.equal(f.run().status, 0);
      fakeGh(f.root);
      writeFileSync(join(f.root, "url_override"), bad);
      const r = runPublish(f);
      assert.notEqual(r.status, 0);
      assert.ok(r.stderr.includes("UNEXPECTED_RELEASE_REPOSITORY"));
      assert.ok(!(r.stdout + r.stderr).includes(token));
      const c = calls(f.root);
      assert.ok(
        !c.some((x) => x.args[0] === "release" && x.args[1] === "upload"),
      );
      assert.ok(!c.some((x) => x.args.includes("PATCH")));
    } finally {
      f.clean();
    }
  });
test("draft html_url may already be the exact canonical tag URL", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    writeFileSync(
      join(f.root, "url_override"),
      "https://github.com/RunaticMoon/pr-context-explorer/releases/tag/v0.6.1",
    );
    assert.equal(runPublish(f).status, 0);
  } finally {
    f.clean();
  }
});
test("published release must use the exact canonical tag URL, never untagged", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    // url_override also rewrites the post-promotion record: drafts accept the
    // observed untagged form but a published release must be canonical.
    writeFileSync(join(f.root, "url_override"), untaggedUrl);
    const r = runPublish(f);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("UNEXPECTED_RELEASE_REPOSITORY"));
  } finally {
    f.clean();
  }
});
test("listing calls use paginated slurp and a leftover draft aborts with zero mutation (fake gh)", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    seedDraft(f.root);
    const r = runPublish(f);
    // A leftover draft for the same tag must abort with zero mutation.
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("RELEASE_EXISTS_MANUAL_RECOVERY_REQUIRED"));
    const c = calls(f.root);
    const listed = c.filter(
      (x) =>
        Array.isArray(x.args) &&
        x.args[3] ===
          "repos/RunaticMoon/pr-context-explorer/releases?per_page=100",
    );
    assert.ok(listed.length >= 1);
    assert.ok(
      listed.every(
        (x) => x.args.includes("--paginate") && x.args.includes("--slurp"),
      ),
    );
    assert.ok(!c.some((x) => x.args.includes("POST")));
    assert.ok(!c.some((x) => x.args.includes("PATCH")));
    assert.ok(
      !c.some((x) => x.args[0] === "release" && x.args[1] === "upload"),
    );
  } finally {
    f.clean();
  }
});
test("unknown release ids fail closed in the fake gh recorder (fake gh)", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    const probe = spawnSync("python3", ["-c", "import subprocess,os; r=subprocess.run(['./gh','api','--hostname','github.com','repos/RunaticMoon/pr-context-explorer/releases/390511318'],capture_output=True,text=True); raise SystemExit(0 if r.returncode!=0 else 1)"], { cwd: f.root, encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    assert.throws(() => readFileSync(join(f.root, "state.json")));
  } finally {
    f.clean();
  }
});
test("removed resume inputs are never consumed: stray resume env still publishes normally (fake gh)", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    const r = runPublish(f, {
      PUBLIC_RELEASE_RESUME_DRAFT_ID: "390511318",
      PUBLIC_RELEASE_RESUME_SOURCE_COMMIT: "c".repeat(40),
    });
    assert.equal(r.status, 0, r.stderr);
    const c = calls(f.root);
    // The publisher has no resume branch: the only numeric-ID release read is
    // the created draft's own record (id 123 from the fake).
    const reads = c.filter(
      (x) =>
        Array.isArray(x.args) &&
        typeof x.args[3] === "string" &&
        /\/releases\/\d+$/.test(x.args[3]) &&
        !x.args.includes("PATCH"),
    );
    assert.ok(reads.length >= 1);
    assert.ok(reads.every((x) => x.args[3].endsWith("/releases/123")));
    assert.ok(
      JSON.parse(readFileSync(join(f.root, "state.json"), "utf8")).draft ===
        false,
    );
  } finally {
    f.clean();
  }
});
test("tag must resolve to the released source commit, not another SHA (fake gh)", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    writeFileSync(join(f.root, "mode"), "tag-mismatch");
    const r = runPublish(f);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("PUBLIC_TAG_TARGET_MISMATCH"));
    const c = calls(f.root);
    // Tag creation happened, but the mismatched readback must abort before
    // any release creation or asset upload.
    assert.ok(!c.some((x) => x.args[0] === "release" && x.args[1] === "upload"));
    assert.ok(!c.some((x) => x.args.includes("PATCH")));
  } finally {
    f.clean();
  }
});
test("pre-existing tag aborts with zero mutation and leaves the tag untouched (fake gh)", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    writeFileSync(join(f.root, "mode"), "existing-tag");
    const r = runPublish(f);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("TAG_EXISTS_MANUAL_RECOVERY_REQUIRED"));
    const c = calls(f.root);
    assert.ok(!c.some((x) => x.args.includes("POST")));
    assert.ok(!c.some((x) => x.args.includes("PATCH")));
    assert.ok(!c.some((x) => x.args.includes("DELETE")));
    assert.ok(
      !c.some((x) => x.args[0] === "release" && x.args[1] === "upload"),
    );
  } finally {
    f.clean();
  }
});
test("non-public repository is refused before any mutation (fake gh)", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    writeFileSync(join(f.root, "mode"), "repo-private");
    const r = runPublish(f);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("EXPECTED_PUBLIC_REPOSITORY_REQUIRED"));
    const c = calls(f.root);
    assert.ok(!c.some((x) => x.args.includes("POST")));
    assert.ok(!c.some((x) => x.args.includes("PATCH")));
    assert.ok(
      !c.some((x) => x.args[0] === "release" && x.args[1] === "upload"),
    );
  } finally {
    f.clean();
  }
});
test("pre-existing release aborts with zero mutation and never uploads (fake gh)", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    fakeGh(f.root);
    writeFileSync(join(f.root, "mode"), "existing-release");
    const r = runPublish(f);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("RELEASE_EXISTS_MANUAL_RECOVERY_REQUIRED"));
    const c = calls(f.root);
    assert.ok(!c.some((x) => x.args.includes("POST")));
    assert.ok(!c.some((x) => x.args.includes("PATCH")));
    assert.ok(
      !c.some((x) => x.args[0] === "release" && x.args[1] === "upload"),
    );
  } finally {
    f.clean();
  }
});
export { fixture };
