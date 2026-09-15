const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const path = require("node:path");
module.exports = async (context) => {
  const app = path.join(
    context.appOutDir,
    context.packager.appInfo.productFilename + ".app",
  );
  // Runs after extraResources copying and before fuses, signing and artifacts.
  const { verifyRuntimeDependencies } =
    await import("./runtime-dependencies.mjs");
  const packages = await verifyRuntimeDependencies(
    path.join(app, "Contents/Resources/runtime"),
  );
  console.log(
    "Verified bundled runtime dependencies: " +
      packages
        .map((p) => `${p.name}@${p.version}`)
        .sort()
        .join(", "),
  );
  await flipFuses(app, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};
