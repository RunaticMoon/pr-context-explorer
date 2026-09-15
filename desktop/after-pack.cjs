const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");
const path = require("node:path");
module.exports = async (context) => {
  const app = path.join(
    context.appOutDir,
    context.packager.appInfo.productFilename + ".app",
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
