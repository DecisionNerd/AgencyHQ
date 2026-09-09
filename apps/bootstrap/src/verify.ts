/**
 * Verifies the current Trigger.dev deployment via the webapp REST API.
 * Reads GET /api/v1/deployments/current with the prod secret key and writes
 * the result into the bootstrap state.
 *
 * No third-party deps — uses Node's built-in fetch.
 */
import { redact } from "./trigger-web.ts";

export interface DeploymentInfo {
  version?: string;
  status?: string;
  imageRef?: string;
  externalId?: string;
  raw: unknown;
}

function log(msg: string): void {
  console.log(`[bootstrap:verify] ${redact(msg)}`);
}

/**
 * GET /api/v1/deployments/current with the prod secret key.
 * Returns the parsed deployment info on success, throws on failure.
 */
export async function verifyDeployment(
  webappUrl: string,
  prodSecretKey: string,
): Promise<DeploymentInfo> {
  const url = `${webappUrl}/api/v1/deployments/current`;
  log(`GET ${url}`);

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${prodSecretKey}`,
      Accept: "application/json",
    },
  });

  if (resp.status === 404) {
    throw Object.assign(
      new Error(
        "GET /api/v1/deployments/current returned 404: no deployment registered yet. " +
          "Ensure trigger deploy completed and the project ref is correct.",
      ),
      { errorCategory: "verify_failed" },
    );
  }

  if (!resp.ok) {
    throw Object.assign(new Error(`GET /api/v1/deployments/current returned HTTP ${resp.status}`), {
      errorCategory: "verify_failed",
    });
  }

  const body = await resp.json();
  const b = body as Record<string, unknown>;
  log(`deployment current: status=${b["status"] ?? "unknown"}`);

  const info: DeploymentInfo = { raw: body };
  if (typeof b["version"] === "string") info.version = b["version"];
  if (typeof b["status"] === "string") info.status = b["status"];
  if (typeof b["imageReference"] === "string") info.imageRef = b["imageReference"];
  if (typeof b["externalId"] === "string") info.externalId = b["externalId"];
  return info;
}
