import { requestCanvasAgentJson, requestCanvasAgentText } from "../canvas-agent/llmProvider.js";
import { executeMeteredAgentOperation } from "../../services/meteredAgentOperationService.js";
import {
  evaluateWorkflowCondition,
  interpolateWorkflowValue,
  resolveWorkflowExpression,
} from "./expression.js";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const contextFor = ({ inputs = {}, executionContext = {} } = {}) => ({
  nodes: inputs,
  inputs: object(executionContext.inputs),
  variables: object(executionContext.variables),
  loop: object(executionContext.loop),
});

export const createWorkflowControlNodeHandlers = ({ defaultTextModel } = {}) => new Map([
  ["condition.rule", async (runtime) => {
    const context = contextFor(runtime);
    const config = interpolateWorkflowValue(object(runtime.config), context);
    const left = resolveWorkflowExpression(config.left, context) ?? config.left;
    const right = resolveWorkflowExpression(config.right, context) ?? config.right;
    return { kind: "workflow_condition", ...evaluateWorkflowCondition({ left, operator: config.operator, right }) };
  }],
  ["condition.ai", async (runtime) => {
    const context = contextFor(runtime);
    const config = interpolateWorkflowValue(object(runtime.config), context);
    const value = resolveWorkflowExpression(config.valueExpression || config.value_expression, context)
      ?? config.value
      ?? runtime.inputs;
    const modelKey = String(config.model || runtime.executionContext?.textModel || defaultTextModel?.() || "").trim();
    const operation = await executeMeteredAgentOperation({
      userId: runtime.userId,
      membershipTier: runtime.executionContext?.membershipTier || "free",
      operationType: "canvas_agent_plan",
      modelKey,
      idempotencyKey: `workflow-agent:${runtime.runId}:${runtime.nodeKey}:attempt:${runtime.attemptCount || 1}`,
      requestPayload: {
        kind: "condition.ai",
        runId: runtime.runId,
        nodeKey: runtime.nodeKey,
        attempt: runtime.attemptCount || 1,
        modelKey,
        criterion: config.prompt || config.criterion,
        value,
      },
      invoke: ({ route }) => requestCanvasAgentJson({
        userId: runtime.userId,
        modelKey,
        modelRoute: route,
        system: "You are a workflow condition evaluator. Return only JSON with matched:boolean and reason:string. Do not call tools.",
        messages: [{ role: "user", content: JSON.stringify({ criterion: config.prompt || config.criterion, value }) }],
        maxTokens: 500,
      }),
    });
    const response = operation.result;
    const matched = response.data?.matched === true;
    return {
      kind: "workflow_ai_condition",
      matched,
      branch: matched ? "true" : "false",
      reason: String(response.data?.reason || "").slice(0, 1000),
      model: response.model,
    };
  }],
  ["agent.call", async (runtime) => {
    const context = contextFor(runtime);
    const config = interpolateWorkflowValue(object(runtime.config), context);
    const modelKey = String(config.model || runtime.executionContext?.textModel || defaultTextModel?.() || "").trim();
    const operation = await executeMeteredAgentOperation({
      userId: runtime.userId,
      membershipTier: runtime.executionContext?.membershipTier || "free",
      operationType: "canvas_agent_plan",
      modelKey,
      idempotencyKey: `workflow-agent:${runtime.runId}:${runtime.nodeKey}:attempt:${runtime.attemptCount || 1}`,
      requestPayload: {
        kind: "agent.call",
        runId: runtime.runId,
        nodeKey: runtime.nodeKey,
        attempt: runtime.attemptCount || 1,
        modelKey,
        prompt: config.prompt || config.instruction || JSON.stringify(runtime.inputs || {}),
      },
      invoke: ({ route }) => requestCanvasAgentText({
        userId: runtime.userId,
        modelKey,
        modelRoute: route,
        system: "You are a text node inside a StarDraw canvas workflow. Follow the instruction and return the requested content without tool calls.",
        prompt: config.prompt || config.instruction || JSON.stringify(runtime.inputs || {}),
      }),
    });
    return { ...operation.result, pointsCharged: operation.pointsCost, operationId: operation.operationId };
  }],
]);
