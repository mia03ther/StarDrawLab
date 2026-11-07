import sql from "../../configs/db.js";
import { createPostgresJobQueue } from "../../services/postgresJobQueue.js";
import { planCanvasAgentNextAction } from "./planner.js";
import { CanvasAgentRunService } from "./runService.js";
import { CanvasAgentRunStore } from "./runStore.js";
import { getCanvasAgentToolRegistry } from "./toolRegistry.js";
import { executeMeteredAgentOperation } from "../../services/meteredAgentOperationService.js";

let runtime;

export const buildCanvasAgentRuntime = ({
  sqlClient = sql,
  jobQueue = createPostgresJobQueue({ sqlClient }),
  toolRegistry = getCanvasAgentToolRegistry(),
  planner = planCanvasAgentNextAction,
} = {}) => {
  const meteredPlanner = planner === planCanvasAgentNextAction
    ? async (input) => {
      const operation = await executeMeteredAgentOperation({
        userId: input.userId,
        membershipTier: input.run?.membershipTier || "free",
        operationType: "canvas_agent_plan",
        modelKey: input.modelKey,
        idempotencyKey: `canvas-agent-plan:${input.run?.id || "unknown"}:turn:${Number(input.run?.steps?.length || 0) + 1}`,
        requestPayload: {
          canvasAgentRunId: input.run?.id || null,
          conversationId: input.run?.conversationId || null,
          instruction: input.instruction,
          modelKey: input.modelKey,
          stepCount: input.run?.steps?.length || 0,
          toolKeys: (input.tools || []).map((tool) => tool.toolKey),
        },
        invoke: ({ route }) => planner({ ...input, modelRoute: route }),
      });
      return operation.result;
    }
    : planner;

  return new CanvasAgentRunService({
  store: new CanvasAgentRunStore({ sqlClient }),
  jobQueue,
  toolRegistry,
  planner: meteredPlanner,
  queueName: process.env.CANVAS_AGENT_JOB_QUEUE_NAME || "canvas_agent",
  mediaPollIntervalMs: Number(process.env.CANVAS_AGENT_MEDIA_POLL_MS || 5_000),
  });
};

export const getCanvasAgentRuntime = () => {
  if (!runtime) runtime = buildCanvasAgentRuntime();
  return runtime;
};

export const resetCanvasAgentRuntimeForTests = () => { runtime = null; };
