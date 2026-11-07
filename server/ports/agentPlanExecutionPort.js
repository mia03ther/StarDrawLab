/**
 * Persistence contract for durable Global Agent plans.
 *
 * The application layer knows nothing about PostgreSQL tables or worker
 * leases. Adapters persist bounded JSON only and never store raw approval
 * tokens, provider credentials, or media bytes.
 */
export class AgentPlanStorePort {
  async createRun() { throw new Error("AgentPlanStorePort.createRun must be implemented"); }
  async attachJob() { throw new Error("AgentPlanStorePort.attachJob must be implemented"); }
  async getRun() { throw new Error("AgentPlanStorePort.getRun must be implemented"); }
  async markWaitingApproval() { throw new Error("AgentPlanStorePort.markWaitingApproval must be implemented"); }
  async approveStep() { throw new Error("AgentPlanStorePort.approveStep must be implemented"); }
  async markWaitingClient() { throw new Error("AgentPlanStorePort.markWaitingClient must be implemented"); }
  async completeClientStep() { throw new Error("AgentPlanStorePort.completeClientStep must be implemented"); }
  async markStepRunning() { throw new Error("AgentPlanStorePort.markStepRunning must be implemented"); }
  async recordStepResult() { throw new Error("AgentPlanStorePort.recordStepResult must be implemented"); }
  async deferStep() { throw new Error("AgentPlanStorePort.deferStep must be implemented"); }
  async completeStep() { throw new Error("AgentPlanStorePort.completeStep must be implemented"); }
  async completeStepAndAppend() { throw new Error("AgentPlanStorePort.completeStepAndAppend must be implemented"); }
  async completeClientStepAndAppend() { throw new Error("AgentPlanStorePort.completeClientStepAndAppend must be implemented"); }
  async resetStepForRetry() { throw new Error("AgentPlanStorePort.resetStepForRetry must be implemented"); }
  async failStep() { throw new Error("AgentPlanStorePort.failStep must be implemented"); }
  async cancelRun() { throw new Error("AgentPlanStorePort.cancelRun must be implemented"); }
}
