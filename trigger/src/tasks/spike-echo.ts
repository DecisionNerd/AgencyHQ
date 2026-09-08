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
      // Spike-only: values of the allowlisted names the adapters forward to
      // child processes (never secrets), so a host-profile run can be compared
      // with an interactive shell.
      envValues: Object.fromEntries(
        ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TMPDIR"].map((k) => [
          k,
          process.env[k] ?? null,
        ]),
      ),
    };
  },
});
