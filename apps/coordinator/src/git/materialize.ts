/**
 * materialize.ts — coordinator-side mirror utilities for building source bundles.
 *
 * Used by internal routes to serve source bundles for worker containers:
 * the coordinator exports a (optionally thin) git bundle from the project mirror
 * at the requested revision.
 */

export { exportBundle, importBundle } from "./bundle.ts";
export type { MirrorDeps, MirrorProject, MirrorRef } from "./mirror.ts";
export {
  diffDigest,
  ensureMirror,
  fetchRef,
  hasCommit,
  isAncestorInMirror,
  lsRemote,
  mirrorPath,
  revParse,
} from "./mirror.ts";
