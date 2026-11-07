import sql from "../configs/db.js";
import { PostgresExecutionGovernor } from "../infrastructure/postgresExecutionGovernor.js";
import { ExecutionGovernorService } from "./executionGovernorService.js";

let governor;

/**
 * The flag keeps the rollout safe: the adapter is available in code, but the
 * running service must not query the new tables until migration 029 has been
 * applied and verified in that environment.
 */
export const getExecutionGovernor = () => {
  if (process.env.EXECUTION_GOVERNOR_ENABLED !== "true") return null;
  if (!governor) governor = new ExecutionGovernorService({
    store: new PostgresExecutionGovernor({ sqlClient: sql }),
  });
  return governor;
};

export const resetExecutionGovernorForTests = () => {
  governor = null;
};
