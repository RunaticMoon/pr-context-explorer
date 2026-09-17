const signed = process.env.PRCE_RELEASE_SIGNED === "1";
if (
  signed &&
  (process.platform !== "darwin" ||
    !/^[A-Z0-9]{10}$/.test(process.env.PRCE_APPLE_TEAM_ID || ""))
)
  throw Error("Signed release requires macOS and PRCE_APPLE_TEAM_ID");
module.exports = {
  // Fail before producing a macOS artifact: Linux compilation cannot supply or
  // validate a functional Mach-O helper. This product currently ships arm64 only.
  beforePack: async (context) => {
    if (process.platform !== "darwin")
      throw Error("macOS build host required for native ACL packaging");
    if (
      context.electronPlatformName !== "darwin" ||
      require("builder-util").Arch[context.arch] !== "arm64"
    )
      throw Error("Only macOS arm64 packaging is supported");
    const helper = require("node:path").join(
      __dirname,
      "build/runtime/native/prce-macos-acl",
    );
    const fs = require("node:fs");
    const publicHelper = fs.lstatSync(
      require("node:path").join(__dirname, "build/public-update-helper.cjs"),
    );
    if (
      !publicHelper.isFile() ||
      publicHelper.isSymbolicLink() ||
      publicHelper.size === 0
    )
      throw Error(
        "Missing or unsafe bundled public update helper; run desktop:build",
      );
    const stat = fs.lstatSync(helper);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o7777) !== 0o755
    )
      throw Error(
        "Missing or unsafe native ACL helper; run desktop:build on macOS",
      );
    const run = (file, args) =>
      require("node:child_process").execFileSync(file, args, {
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 65536,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      });
    if (run("/usr/bin/lipo", ["-archs", helper]).trim() !== "arm64")
      throw Error("Native ACL helper must be arm64");
    run("/usr/bin/codesign", ["--verify", "--strict", helper]);
    const libraries = run("/usr/bin/otool", ["-L", helper])
      .split("\n")
      .slice(1)
      .filter(Boolean);
    if (
      libraries.length !== 1 ||
      !/^\s+\/usr\/lib\/libSystem\.B\.dylib \(/.test(libraries[0])
    )
      throw Error("Unexpected native ACL helper dependency");
  },
  forceCodeSigning: signed,
  appId: "com.runaticmoon.pr-context-explorer",
  productName: "PR Context Explorer",
  electronVersion: "44.3.0",
  directories: {
    app: "desktop/build/app",
    output: "release",
    buildResources: "desktop/resources",
  },
  files: [
    "main.cjs",
    "preload.cjs",
    "package.json",
    "THIRD-PARTY-NOTICES.txt",
    "!node_modules{,/**/*}",
  ],
  asar: true,
  npmRebuild: false,
  artifactName: "PR-Context-Explorer-${version}-${arch}.${ext}",
  extraResources: [
    // builder 26's createFilter unconditionally drops root-relative node_modules.
    // Anchor one level above runtime so its dependencies are nested resources.
    // An explicit node_modules glob on the old root does NOT override that rule.
    { from: "desktop/build", to: ".", filter: ["runtime/**/*"] },
    { from: "desktop/vendor/node-darwin-arm64", to: "node" },
    {
      from: "desktop/build/public-update-helper.cjs",
      to: "public-update-helper.cjs",
    },
  ],
  publish: [
    {
      provider: "github",
      owner: "RunaticMoon",
      repo: "pr-context-explorer",
      private: true,
      releaseType: "release",
    },
  ],
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.developer-tools",
    minimumSystemVersion: "13.0",
    identity: signed ? undefined : "-",
    hardenedRuntime: signed,
    gatekeeperAssess: false,
    entitlements: "desktop/resources/entitlements.mac.plist",
    entitlementsInherit: "desktop/resources/entitlements.mac.plist",
    binaries: [
      "Contents/Resources/node/bin/node",
      "Contents/Resources/runtime/native/prce-macos-acl",
    ],
    notarize: signed ? { teamId: process.env.PRCE_APPLE_TEAM_ID } : false,
  },
  dmg: { sign: signed },
  afterPack: "./desktop/after-pack.cjs",
};
