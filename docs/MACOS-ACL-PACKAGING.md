# Native ACL helper packaging

Every Darwin invocation of `desktop/build.mjs`, including `--runtime-only`, rebuilds
`desktop/build/runtime/native/prce-macos-acl` after runtime cleanup. The build invokes
`scripts/build-macos-acl.mjs` using the build process's Node and an absolute,
module-anchored script path. The host architecture is explicit (`arm64` or
`x86_64`). Prepared `desktop/build/node` is preserved across rebuilds.

The native builder requires Apple's command-line build tools on the **build/CI
host only**. It compiles C, ad-hoc signs and verifies the executable, permits only
libSystem, and installs mode 0755. Errors abort the desktop build. Application
startup and ACL preflight never compile code or search PATH for a replacement.

`desktop:prepare`, `desktop:build`, `desktop:pack:mac`, and `desktop:dist:mac` all
pass through that build. Current packages are arm64 only. The electron-builder
`beforePack` gate rejects non-Darwin hosts, unsupported package targets, missing
or unsafe helper files, wrong architecture, invalid signatures and non-system
libraries. Linux desktop development builds still work without a helper; Linux
cross-packaging is unsupported and cannot yield a claimed functional Mac app.

The existing runtime `extraResources` mapping places the executable at
`Contents/Resources/runtime/native/prce-macos-acl`, outside `app.asar`. It is also
an explicit macOS signing binary so release signing covers it. Source and
compiled ACL modules resolve their respective bundled paths from `import.meta.url`,
not the inspected repository or current working directory.

The diagnostic-only workflow compiles the arm64 bridge in a bounded two-minute
step, then runs the fixed ACL test file (including actual Darwin APIs), before
credential-free Claude help. It neither packages nor uploads installation artifacts.
Normal desktop CI rebuilds automatically and its packaged smoke test checks the
actual installed helper's file type, mode, architecture, signature, libraries and
execution via the bundled standalone Node with no PATH/compiler dependency.

Build regression fixtures copy the native build script and C sources into their
own root (symlinking the script would redirect its module-anchored output). They
exercise full and runtime-only builds and preserve the prepared Node regression.
Darwin checks execute the real compiled reader from a foreign cwd. Linux checks
require that no fake helper exists; they are not evidence of Darwin API success.

Concurrent rebuilds of the same development output while it is running are not
supported. Installed app resources are not rebuilt or mutated at runtime.

Validation here: Linux build/test execution only. Actual Apple compilation,
signing, ACL behavior and packaged smoke remain mandatory pending macOS CI.
