import { X509Certificate } from "node:crypto";
import {
  JiraConfigurationError,
  projectPattern,
  registeredSites,
} from "./config.ts";
import type { JiraConnection } from "./types.ts";
export interface JiraLimits {
  timeoutMs: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
}
export function connectionSettings(
  config: JiraConnection,
  deployment: "cloud" | "data_center",
): { config: JiraConnection; limits: JiraLimits } {
  const site = registeredSites([config])[0];
  if (site.deployment !== deployment)
    throw new JiraConfigurationError("Adapter deployment mismatch");
  if (
    typeof config.accountContextId !== "string" ||
    !config.accountContextId ||
    config.accountContextId.length > 200
  )
    throw new JiraConfigurationError("Account context ID required");
  projectPattern(config.projectKeyPattern);
  if (
    config.authentication !== undefined &&
    !["anonymous", "session"].includes(config.authentication)
  )
    throw new JiraConfigurationError("Invalid authentication state");
  if (
    config.authentication === "anonymous" &&
    (config.credential || config.accountContextId !== "anonymous")
  )
    throw new JiraConfigurationError(
      "Anonymous access cannot claim an account or credentials",
    );
  const fields = config.acceptanceCriteriaFields ?? [];
  if (
    fields.length > 20 ||
    fields.some(
      (f) =>
        !/^customfield_[1-9][0-9]{0,19}$/.test(f.id) ||
        (f.label?.length ?? 0) > 200,
    ) ||
    new Set(fields.map((f) => f.id)).size !== fields.length
  )
    throw new JiraConfigurationError(
      "Invalid acceptance criteria field mapping",
    );
  const limits = {
    timeoutMs: 15_000,
    maxResponseBytes: 1_048_576,
    maxTotalBytes: 4_194_304,
    ...config.limits,
  };
  for (const [name, min, max] of [
    ["timeoutMs", 10, 120_000],
    ["maxResponseBytes", 256, 8_388_608],
    ["maxTotalBytes", 256, 33_554_432],
  ] as const) {
    if (
      !Number.isSafeInteger(limits[name]) ||
      limits[name] < min ||
      limits[name] > max
    )
      throw new JiraConfigurationError("Invalid Jira capture limit");
  }
  if (config.customCaPem !== undefined) {
    const pem = config.customCaPem;
    const blocks =
      typeof pem === "string" && pem.length <= 65_536
        ? pem.match(
            /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
          )
        : null;
    if (
      !blocks?.length ||
      blocks.length > 8 ||
      pem
        .replace(
          /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
          "",
        )
        .trim()
    )
      throw new JiraConfigurationError("Invalid custom CA bundle");
    try {
      blocks.forEach((block) => new X509Certificate(block));
    } catch {
      throw new JiraConfigurationError("Invalid custom CA certificate");
    }
  }
  const credential = config.credential;
  if (
    credential &&
    (credential.kind === "env"
      ? !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credential.variable) ||
        !["Bearer", "Basic"].includes(credential.scheme)
      : credential.kind !== "callback" ||
        typeof credential.resolve !== "function")
  )
    throw new JiraConfigurationError("Invalid credential binding");
  // Copy trusted settings so callers cannot mutate endpoints or field mappings after validation.
  return {
    config: {
      ...site,
      accountContextId: config.accountContextId,
      authentication: config.authentication,
      credential: credential ? { ...credential } : undefined,
      acceptanceCriteriaFields: fields.map((f) => ({ ...f })),
      projectKeyPattern: config.projectKeyPattern,
      customCaPem: config.customCaPem,
      limits: { ...limits },
    },
    limits,
  };
}
