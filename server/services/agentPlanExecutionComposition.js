import sql from "../configs/db.js";
import { PostgresAgentPlanStore } from "../infrastructure/postgresAgentPlanStore.js";
import { AgentPlanExecutionService } from "./agentPlanExecutionService.js";
import { getAgentRuntime } from "./agentRuntimeComposition.js";
import { getCreativeAgent } from "./creativeAgentComposition.js";
import { resolveTrustedAgentToolContext } from "./agentTrustedContextService.js";
import { createPostgresJobQueue } from "./postgresJobQueue.js";
import { selectAgentTools } from "./agentToolSelectionService.js";
import { executeMeteredAgentOperation } from "./meteredAgentOperationService.js";

let service;

export const getAgentPlanExecution = () => {
  if (!service) {
    service = new AgentPlanExecutionService({
      store: new PostgresAgentPlanStore({ sqlClient: sql }),
      jobQueue: createPostgresJobQueue({ sqlClient: sql }),
      runtimeFactory: getAgentRuntime,
      trustedContextResolver: (input) => resolveTrustedAgentToolContext({ ...input, sqlClient: sql }),
      reactPlanner: async ({ userId, runId, modelKey, membershipTier, instruction, tools, context, language }) => {
        const reactiveContext = { ...context, reactive: true };
        const selectedTools = selectAgentTools({ tools, instruction, context: reactiveContext });
        const observations = Array.isArray(reactiveContext.observations) ? reactiveContext.observations : [];
        const operation = await executeMeteredAgentOperation({
          userId,
          membershipTier: membershipTier || "free",
          operationType: "global_agent_plan",
          modelKey,
          idempotencyKey: `global-agent-plan:${runId || "unknown"}:turn:${observations.length + 1}`,
          requestPayload: {
            agentPlanRunId: runId || null,
            instruction,
            language,
            modelKey: modelKey || null,
            observations,
            toolKeys: selectedTools.map((tool) => tool.toolKey),
          },
          invoke: ({ route }) => getCreativeAgent().planGlobal({
            userId,
            instruction,
            tools: selectedTools,
            context: reactiveContext,
            language,
            modelRoute: route,
          }),
        });
        return operation.result;
      },
      queueName: process.env.JOB_QUEUE_NAME || "workflow",
    });
  }
  return service;
};

export const resetAgentPlanExecutionForTests = () => {
  service = null;
};
