/**
 * Integration module — revision manifests and outcome decisions.
 *
 * See: packages/domain/src/integration/manifest.ts
 * See: packages/domain/src/integration/decide.ts
 */

export type {
  DecideIntegrationInput,
  DecideIntegrationResult,
  IntegrateMergeOutput,
} from "./decide.ts";
export { decideIntegrationOutcome } from "./decide.ts";
export type { IntegrateOutcome, ManifestEntry } from "./manifest.ts";
export { allResolved, manifestDigestInput, nextEntry } from "./manifest.ts";
