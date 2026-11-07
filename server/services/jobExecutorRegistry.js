import { getAgentRuntime } from "./agentRuntimeComposition.js";
import { getAgentPlanExecution } from "./agentPlanExecutionComposition.js";
import { getMcpToolRuntime } from "./mcpRuntimeComposition.js";
import { getWorkflowRuntime } from "./workflowRuntimeComposition.js";
import { getCanvasAgentRuntime } from "../modules/canvas-agent/composition.js";

export const DURABLE_JOB_TYPES = Object.freeze({
  WORKFLOW_DISPATCH: "workflow.dispatch",
  WORKFLOW_NODE: "workflow.node",
  AGENT_TOOL: "agent.tool",
  AGENT_PLAN: "agent.plan",
  MCP_CALL: "mcp.call",
  CANVAS_AGENT_REACT: "canvas.agent.react",
});

const fail = (message, code = "JOB_EXECUTOR_UNAVAILABLE") => {
  throw Object.assign(new Error(message), { status: 503, code });
};

const required = (value, label) => {
  const normalized = String(value || "").trim();
  if (!normalized) fail(`${label} is required`, "INVALID_DURABLE_JOB_PAYLOAD");
  return normalized;
};

/**
 * Durable job execution seam. The queue knows only this small interface;
 * provider/database-specific work remains inside the injected runtimes.
 */
export class JobExecutorRegistry {
  #executors;

  constructor({ executors = new Map() } = {}) {
    this.#executors = executors instanceof Map
      ? new Map(executors)
      : new Map(Object.entries(executors || {}));
    for (const [jobType, executor] of this.#executors) {
      this.#assertExecutor(jobType, executor);
    }
  }

  #assertExecutor(jobType, executor) {
    const type = required(jobType, "jobType");
    if (typeof executor !== "function") fail(`Executor for ${type} must be a function`, "INVALID_JOB_EXECUTOR");
  }

  register(jobType, executor) {
    this.#assertExecutor(jobType, executor);
    this.#executors.set(String(jobType).trim(), executor);
    return this;
  }

  has(jobType) {
    return this.#executors.has(String(jobType || "").trim());
  }

  list() {
    return [...this.#executors.keys()].sort();
  }

  async execute(job, context = {}) {
    const jobType = required(job?.jobType || job?.job_type, "jobType");
    const executor = this.#executors.get(jobType);
    if (!executor) fail(`No executor is registered for durable job type ${jobType}`, "UNSUPPORTED_DURABLE_JOB");
    return executor(job, context);
  }
}

const payloadValue = (payload, camel, snake = camel) => payload?.[camel] ?? payload?.[snake];

const createWorkflowExecutor = (runtimeFactory) => async (job) => runtimeFactory().executeJob(job);

const createMcpExecutor = (runtimeFactory) => async (job) => {
  const payload = job.payload || {};
  return runtimeFactory().callTool({
    userId: required(job.userId || job.user_id, "job.userId"),
    userRole: payloadValue(payload, "userRole", "user_role") || "user",
    agentMode: payloadValue(payload, "agentMode", "agent_mode") || "full_access",
    connectionId: required(payloadValue(payload, "connectionId", "connection_id"), "connectionId"),
    serverKey: payloadValue(payload, "serverKey", "server_key") || null,
    toolName: required(payloadValue(payload, "toolName", "tool_name"), "toolName"),
    arguments: payloadValue(payload, "arguments") || {},
    approvalId: payloadValue(payload, "approvalId", "approval_id") || null,
  });
};

const createAgentToolExecutor = (runtimeFactory) => async (job) => {
  const payload = job.payload || {};
  const approvalToken = payloadValue(payload, "approvalToken", "approval_token");
  if (approvalToken) {
    fail("One-time Agent approval tokens must not be persisted in a durable job payload", "AGENT_JOB_SECRET_NOT_ALLOWED");
  }
  return runtimeFactory().execute({
    userId: required(job.userId || job.user_id, "job.userId"),
    userRole: payloadValue(payload, "userRole", "user_role") || "user",
    agentMode: payloadValue(payload, "agentMode", "agent_mode") || "full_access",
    sessionId: required(payloadValue(payload, "sessionId", "session_id"), "sessionId"),
    toolKey: required(payloadValue(payload, "toolKey", "tool_key"), "toolKey"),
    parameters: payloadValue(payload, "parameters") || {},
    context: payloadValue(payload, "context") || {},
    membershipTier: payloadValue(payload, "membershipTier", "membership_tier") || "free",
  });
};

const createCanvasAgentExecutor = (runtimeFactory) => async (job) => runtimeFactory().executeJob(job);

export const createApplicationJobExecutorRegistry = ({
  workflowRuntimeFactory = getWorkflowRuntime,
  agentRuntimeFactory = getAgentRuntime,
  agentPlanExecutionFactory = getAgentPlanExecution,
  mcpRuntimeFactory = getMcpToolRuntime,
} = {}) => new JobExecutorRegistry({
  executors: new Map([
    [DURABLE_JOB_TYPES.WORKFLOW_DISPATCH, createWorkflowExecutor(workflowRuntimeFactory)],
    [DURABLE_JOB_TYPES.WORKFLOW_NODE, createWorkflowExecutor(workflowRuntimeFactory)],
    [DURABLE_JOB_TYPES.AGENT_TOOL, createAgentToolExecutor(agentRuntimeFactory)],
    [DURABLE_JOB_TYPES.AGENT_PLAN, async (job) => agentPlanExecutionFactory().executeJob(job)],
    [DURABLE_JOB_TYPES.MCP_CALL, createMcpExecutor(mcpRuntimeFactory)],
    [DURABLE_JOB_TYPES.CANVAS_AGENT_REACT, createCanvasAgentExecutor(getCanvasAgentRuntime)],
  ]),
});
