/**
 * SourceRef — portable reference to a source bundle served by the coordinator.
 *
 * A SourceRef replaces host filesystem paths (repoPath, worktreeBase) in v2
 * task payloads. Workers receive a bundle path they fetch from the coordinator
 * internal API rather than a mount point on the host.
 *
 * The bundlePath is a relative path (e.g. "/internal/source/<projectId>?rev=<sha>").
 * It must never be a full URL with credentials embedded in userinfo.
 */

import { z } from "zod";

export const SourceRefSchema = z.object({
  projectId: z.string().min(1),
  /** 40-hex git commit SHA identifying the source revision. */
  revision: z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-hex git sha"),
  /**
   * Relative path under the coordinator internal API at which the bundle is
   * served (e.g. "/internal/source/<projectId>?rev=<sha>").
   * Must be a path — never a full URL containing a scheme, host, or userinfo.
   */
  bundlePath: z
    .string()
    .min(1)
    .refine(
      (s) => {
        // Reject anything that looks like a URL with a scheme or userinfo
        if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(s)) return false;
        // Reject embedded credentials (user:pass@ pattern)
        if (/@/.test(s)) return false;
        return true;
      },
      { message: "bundlePath must be a relative path, not a full URL with credentials" },
    ),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;
