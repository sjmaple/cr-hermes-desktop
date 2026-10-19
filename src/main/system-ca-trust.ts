import * as tls from "node:tls";

interface CertificateTrustApi {
  getCACertificates?: (type: "default" | "system") => string[];
  setDefaultCACertificates?: (certificates: readonly string[]) => void;
}

export type SystemCertificateTrustResult =
  | "enabled"
  | "unsupported"
  | "unavailable";

/** Extend the current trust selection; never replace it with system roots alone. */
// @lat: [[remote-dashboard-oauth#Remote Dashboard OAuth#Node system certificate trust]]
export function initializeSystemCertificateTrust(
  api: CertificateTrustApi = tls,
): SystemCertificateTrustResult {
  if (
    typeof api.getCACertificates !== "function" ||
    typeof api.setDefaultCACertificates !== "function"
  ) {
    return "unsupported";
  }
  try {
    const current = api.getCACertificates("default");
    const system = api.getCACertificates("system");
    api.setDefaultCACertificates([...new Set([...current, ...system])]);
    return "enabled";
  } catch {
    // Reading system roots or parsing them can fail. Keep certificate and
    // hostname verification in place; do not install a permissive fallback.
    return "unavailable";
  }
}

// index.ts imports this side effect first, before main-process consumers can
// create cached TLS sessions. Older development Node runtimes simply retain
// their supported defaults. Electron's cookie/net trust boundary is unchanged.
export const systemCertificateTrust = initializeSystemCertificateTrust();
if (systemCertificateTrust === "unavailable") {
  console.warn(
    "[TLS] System certificate trust could not be loaded; existing certificate verification remains enabled.",
  );
}
