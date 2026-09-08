/**
 * Command handlers barrel.
 *
 * commandHandlers(deps) returns an object with all operator command functions
 * bound to the injected dependencies.  The app wires these in on startup.
 */

export { ackVisit, lastAckAt } from "./ack-visit.ts";
export type { ApproveDeps } from "./approve.ts";
export { approveWorkItem } from "./approve.ts";
export {
  assignCampaign,
  createCampaign,
  setMainEffort,
  setWorkItemRank,
} from "./campaign.ts";
export { confirmStop, readStopEvidence } from "./confirm-stop.ts";
export { createWorkItem } from "./create-work-item.ts";
export type {
  DispositionDeps,
  DispositionInput,
  DispositionResult,
  DispositionValue,
} from "./disposition.ts";
export { dispositionFinding } from "./disposition.ts";
export { invalidateAcceptance } from "./invalidate-acceptance.ts";
export { pauseWorkItem, resumeWorkItem } from "./pause.ts";
export { rejectWorkItem } from "./reject.ts";
export type { CommandDeps } from "./stop.ts";
export { stopAttempt } from "./stop.ts";
export { updateAuthority } from "./update-authority.ts";

import { ackVisit, lastAckAt } from "./ack-visit.ts";
import type { ApproveDeps } from "./approve.ts";
import { approveWorkItem } from "./approve.ts";
import { assignCampaign, createCampaign, setMainEffort, setWorkItemRank } from "./campaign.ts";
import { confirmStop } from "./confirm-stop.ts";
import { createWorkItem } from "./create-work-item.ts";
import type { DispositionDeps } from "./disposition.ts";
import { dispositionFinding } from "./disposition.ts";
import { invalidateAcceptance } from "./invalidate-acceptance.ts";
import { pauseWorkItem, resumeWorkItem } from "./pause.ts";
import { rejectWorkItem } from "./reject.ts";
import { stopAttempt } from "./stop.ts";
import { updateAuthority } from "./update-authority.ts";

export function commandHandlers(deps: ApproveDeps & DispositionDeps) {
  return {
    stop: (input: Parameters<typeof stopAttempt>[1]) => stopAttempt(deps, input),
    confirmStop: (
      client: Parameters<typeof confirmStop>[1],
      input: Parameters<typeof confirmStop>[2],
    ) => confirmStop(deps, client, input),
    pause: (input: Parameters<typeof pauseWorkItem>[1]) => pauseWorkItem(deps, input),
    resume: (input: Parameters<typeof resumeWorkItem>[1]) => resumeWorkItem(deps, input),
    createWorkItem: (input: Parameters<typeof createWorkItem>[1]) => createWorkItem(deps, input),
    ackVisit: (input: Parameters<typeof ackVisit>[1]) => ackVisit(deps, input),
    approve: (input: Parameters<typeof approveWorkItem>[1]) => approveWorkItem(deps, input),
    disposition: (input: Parameters<typeof dispositionFinding>[1]) =>
      dispositionFinding(deps, input),
    lastAckAt,
    // Control-plane commands (slice 5)
    reject: (input: Parameters<typeof rejectWorkItem>[1]) => rejectWorkItem(deps, input),
    invalidateAcceptance: (input: Parameters<typeof invalidateAcceptance>[1]) =>
      invalidateAcceptance(deps, input),
    createCampaign: (input: Parameters<typeof createCampaign>[1]) => createCampaign(deps, input),
    assignCampaign: (input: Parameters<typeof assignCampaign>[1]) => assignCampaign(deps, input),
    setMainEffort: (input: Parameters<typeof setMainEffort>[1]) => setMainEffort(deps, input),
    setWorkItemRank: (input: Parameters<typeof setWorkItemRank>[1]) => setWorkItemRank(deps, input),
    updateAuthority: (input: Parameters<typeof updateAuthority>[1]) => updateAuthority(deps, input),
  };
}
