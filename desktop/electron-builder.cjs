const signed = process.env.PRCE_RELEASE_SIGNED === "1";
if (
  signed &&
  (process.platform !== "darwin" ||
    !/^[A-Z0-9]{10}$/.test(process.env.PRCE_APPLE_TEAM_ID || ""))
)
  throw Error("Signed release requires macOS and PRCE_APPLE_TEAM_ID");
module.exports = {
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
    { from: "desktop/build/runtime", to: "runtime" },
    { from: "desktop/vendor/node-darwin-arm64", to: "node" },
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
    binaries: ["Contents/Resources/node/bin/node"],
    notarize: signed ? { teamId: process.env.PRCE_APPLE_TEAM_ID } : false,
  },
  dmg: { sign: signed },
  afterPack: "./desktop/after-pack.cjs",
};
