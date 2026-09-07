import { task } from "@trigger.dev/sdk";

import type { SpikeEchoPayload } from "../types.ts";
import { TASK_IDS } from "../types.ts";

export const spikeEcho = task({
  id: TASK_IDS.spikeEcho,
  run: async (payload: SpikeEchoPayload) => {
    return {
      message: payload.message,
      envKeys: Object.keys(process.env).sort(),
      node: process.version,
    };
  },
});
