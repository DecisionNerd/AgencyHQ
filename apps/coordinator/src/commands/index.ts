/**
 * Command handlers barrel.
 *
 * commandHandlers(deps) returns an object with all operator command functions
 * bound to the injected dependencies.  The app wires these in on startup.
 */

export { ackVisit, lastAckAt } from "./ack-visit.ts";
export { confirmStop, readStopEvidence } from "./confirm-stop.ts";
export { createWorkItem } from "./create-work-item.ts";
export { pauseWorkItem, resumeWorkItem } from "./pause.ts";
export type { CommandDeps } from "./stop.ts";
export { stopAttempt } from "./stop.ts";

import { ackVisit, lastAckAt } from "./ack-visit.ts";
import { confirmStop } from "./confirm-stop.ts";
import { createWorkItem } from "./create-work-item.ts";
import { pauseWorkItem, resumeWorkItem } from "./pause.ts";
import type { CommandDeps } from "./stop.ts";
import { stopAttempt } from "./stop.ts";

export function commandHandlers(deps: CommandDeps) {
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
    lastAckAt,
  };
}
