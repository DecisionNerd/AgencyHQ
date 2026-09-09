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

const VERIFY_TIMEOUT_MS = Number(process.env.BOOTSTRAP_VERIFY_TIMEOUT_MS ?? "30000");

function log(msg: string): void {
  console.log(`[bootstrap:verify] ${redact(msg)}`);
}

/**
 * GET /api/v1/deployments/current with the prod secret key.
 * Returns the parsed deployment info on success, throws on failure.
 * Times out after BOOTSTRAP_VERIFY_TIMEOUT_MS (default 30 s).
 *
 * When `expectedExternalId` is provided and the API response carries its own
 * `externalId`, the two values must match. A mismatch means the running
 * deployment is not the one we just deployed (stale or wrong project) and
 * fails with `verify_failed`.
 */
export async function verifyDeployment(
  webappUrl: string,
  prodSecretKey: string,
  expectedExternalId?: string,
): Promise<DeploymentInfo> {
  const url = `${webappUrl}/api/v1/deployments/current`;
  log(`GET ${url}`);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${prodSecretKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw Object.assign(new Error("verify_deployment timed out"), {
        errorCategory: "verify_failed",
      });
    }
    throw err;
  }

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
  log(`deployment current: status=${b.status ?? "unknown"}`);

  const info: DeploymentInfo = { raw: body };
  if (typeof b.version === "string") info.version = b.version;
  if (typeof b.status === "string") info.status = b.status;
  if (typeof b.imageReference === "string") info.imageRef = b.imageReference;
  if (typeof b.externalId === "string") info.externalId = b.externalId;

  // Assert the deployment is in DEPLOYED state (not FAILED, TIMED_OUT, etc.).
  if (b.status !== "DEPLOYED") {
    throw Object.assign(
      new Error(`deployment status is ${b.status ?? "unknown"} (expected DEPLOYED)`),
      { errorCategory: "verify_failed" },
    );
  }

  // Assert external-id matches what we deployed (when both sides supply a value).
  if (expectedExternalId !== undefined && info.externalId !== undefined) {
    if (info.externalId !== expectedExternalId) {
      throw Object.assign(
        new Error(
          `deployment external-id mismatch: deployed=${expectedExternalId} api=${info.externalId}`,
        ),
        { errorCategory: "verify_failed" },
      );
    }
  }

  return info;
}
