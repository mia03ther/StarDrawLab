/**
 * Application-facing contract for admission control around paid or
 * externally-backed work.
 *
 * The port deliberately does not mention PostgreSQL, Redis, Express, or a
 * provider. An adapter may persist leases and usage in PostgreSQL today and
 * be replaced by a Redis-backed implementation later without changing the
 * Agent/workflow modules.
 */
export class ExecutionGovernorPort {
  async admit() {
    throw new Error("ExecutionGovernorPort.admit must be implemented");
  }

  async heartbeat() {
    throw new Error("ExecutionGovernorPort.heartbeat must be implemented");
  }

  async complete() {
    throw new Error("ExecutionGovernorPort.complete must be implemented");
  }

  async release() {
    throw new Error("ExecutionGovernorPort.release must be implemented");
  }
}

export const EXECUTION_ADMISSION_STATES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
