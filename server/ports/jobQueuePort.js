/**
 * Application-facing contract for durable jobs.
 *
 * The port deliberately knows nothing about PostgreSQL, Redis, workers, HTTP,
 * providers, or media storage. Implementations persist JSON parameters and
 * references (for example OSS keys), never media bytes.
 * Final failures are durable dead letters. Notification is intentionally a
 * separate injected settlement seam and is not part of this port.
 */
export class JobQueuePort {
  async enqueue() {
    throw new Error("JobQueuePort.enqueue must be implemented");
  }

  async lease() {
    throw new Error("JobQueuePort.lease must be implemented");
  }

  async heartbeat() {
    throw new Error("JobQueuePort.heartbeat must be implemented");
  }

  async complete() {
    throw new Error("JobQueuePort.complete must be implemented");
  }

  async fail() {
    throw new Error("JobQueuePort.fail must be implemented");
  }

  async cancel() {
    throw new Error("JobQueuePort.cancel must be implemented");
  }

  async retry() {
    throw new Error("JobQueuePort.retry must be implemented");
  }

  async inspect() {
    throw new Error("JobQueuePort.inspect must be implemented");
  }
}

export const JOB_STATUSES = Object.freeze([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
