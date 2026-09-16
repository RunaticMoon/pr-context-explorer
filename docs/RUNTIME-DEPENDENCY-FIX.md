# Runtime dependency packaging fix

## Confirmed root cause

Pinned `app-builder-lib@26.16.1` `out/util/filter.js:createFilter` rejects **exactly root-relative `node_modules` before evaluating glob patterns**. The old `extraResources` source was `desktop/build/runtime`, making its dependency directory that rejected root. `files: ['!node_modules{,/**/*}']` is not the cause; adding an explicit dependency glob to the old resource mapping cannot override the hard-coded filter.

The regression uses the actual pinned `getFileMatchers` and `copyFiles`, real compiled server modules and installed npm dependencies, copied outside the checkout with an empty PATH/NODE_PATH/NODE_OPTIONS. Old mapping reproduces `ERR_MODULE_NOT_FOUND: Cannot find package 'typescript'` from `runtime/src/server/git.js`; the new mapping imports it successfully.

Parent independently inspected the published v0.4.0 ZIP (`artifacts/released-v0.4.0.zip`, SHA-256 `e6b3ca6f4e0a254eadc50f85a42b7b464e2508ae4363e06384e49758fc4543a7`, 172313749 bytes): zero `runtime/node_modules` entries and no TypeScript package manifest. This is a shipped artifact omission, not an end-user Git/CLT issue.

## Fix and interface contract

- Resource mapping is now `{ from: 'desktop/build', to: '.', filter: ['runtime/**/*'] }`. Dependencies are nested (`runtime/node_modules`) relative to the matcher, so the real copier retains them. Only runtime is selected: app/Node preparation output is not duplicated. Native ACL helper, module tree, prompts, web assets and fonts remain under the same runtime paths. No post-sign copy or npm install is used.
- `desktop/runtime-dependencies.mjs` is a build-time, Node-builtins-only helper. It exports `copyRuntimeDependencies(projectRoot, runtime)` and `verifyRuntimeDependencies(runtime)` (both async). Verification returns `{ name, version, directory }[]` with directories relative to runtime. The verifier never executes app/package code or consults source/global package resolution.
- Build-time copy traverses the installed production dependency/required-peer graph from `typescript` and `ajv`, including installed optional dependencies, preserving nested package paths. Complete real package contents/manifests are copied without running scripts. Runtime `package.json` records the root dependencies. `runtime/runtime-dependencies.json` records SHA-256 of every dependency file, catching missing lazy-loaded files as well as packages.
- Verification checks real directories/files (no dependency symlinks), follows manifest dependencies **only within the runtime boundary**, and compares full file inventory. A project ancestor cannot satisfy a missing package.
- `after-pack.cjs` validates `Contents/Resources/runtime` before touching fuses. Pinned `PlatformPackager.doPack` calls resource copying, awaited `emitAfterPack`, sanity checks/fuses, then `doSignAfterPack`, in that order. A verification exception therefore prevents signing and artifact creation.
- Packaged smoke owner can import `verifyRuntimeDependencies` directly with the staged runtime path. Existing source-build fixture now copies the new helper alongside `build.mjs`; no production Node cleanup behavior changed.

## Verified local results

- `npm test`: 667 tests, 657 passed, 10 platform skips, 0 failures (full suite).
- `npm run desktop:build`: passed, including TypeScript checking and real web compilation.
- `node --test tests/e2e/desktop-runtime.mjs`: passed; compiled runtime served the real UI/demo and loaded dynamic AI modules.
- Actual pinned resource copier applied to the full locally built runtime: **1,235 files byte-compared**, including **496 font files** and **6 prompt files**; every file matched its source. Local Linux output deliberately has no Mach-O ACL helper.
- Bundle-only graph verification found TypeScript 5.9.3, Ajv 8.20.0, fast-deep-equal 3.1.3, fast-uri 3.1.7, json-schema-traverse 1.0.0, require-from-string 2.0.2.
- Additional regressions cover ancestor-resolution masking, missing lazy package files, symlink refusal without foreign writes, and an undeclared external runtime import. Esbuild analyzes all compiled modules (including workers) without executing them; new bare imports must be declared as runtime roots, then the dependency/peer graph is copied automatically. Third-party notices use that same discovered dependency closure.
- `git diff --check`: passed.

## Scope and acceptance

Linux can verify real pinned resource matcher/copy behavior, dependency closure, isolated Node module imports, and fail-fast afterPack errors. It cannot certify Mach-O signing, Gatekeeper, notarization, macOS 26 first-window behavior or the separate ICU76 concern. Those remain real-Mac release acceptance gates. Do not install npm dependencies into an end-user bundle or overwrite v0.4.0.
