import sql from "../configs/db.js";
import { workflowContainsMcpCall } from "./workflowCostService.js";

const text = (value) => String(value ?? "").trim();

const findOwner = async (sqlClient, table, idColumn, ownerColumn, id) => {
  if (!id) return null;
  const queries = {
    canvas: () => sqlClient`SELECT user_id AS owner_user_id FROM canvases WHERE id = ${id} LIMIT 1`,
    creation: () => sqlClient`SELECT user_id AS owner_user_id FROM creations WHERE id::text = ${id} LIMIT 1`,
    template: () => sqlClient`SELECT owner_user_id FROM prompt_templates WHERE id::text = ${id} LIMIT 1`,
  };
  const key = `${table}:${idColumn}:${ownerColumn}`;
  const resolver = {
    "canvases:id:user_id": queries.canvas,
    "creations:id:user_id": queries.creation,
    "prompt_templates:id:owner_user_id": queries.template,
  }[key];
  if (!resolver) return null;
  const [row] = await resolver();
  return row?.owner_user_id || null;
};

const contentOwner = async ({ sqlClient, parameters }) => {
  const resourceType = text(parameters?.resourceType || parameters?.resource_type).toLowerCase();
  const resourceId = text(parameters?.resourceId || parameters?.resource_id);
  if (["canvas", "canvases"].includes(resourceType)) {
    return findOwner(sqlClient, "canvases", "id", "user_id", resourceId);
  }
  if (["creation", "image", "video"].includes(resourceType)) {
    return findOwner(sqlClient, "creations", "id", "user_id", resourceId);
  }
  if (["template", "private_template", "prompt_template"].includes(resourceType)) {
    return findOwner(sqlClient, "prompt_templates", "id", "owner_user_id", resourceId);
  }
  return null;
};

/**
 * Resolves only server-owned authorization context for Agent tools.
 * Missing resources are attributed to the current user so handlers can
 * return a normal 404; a found resource owned by another user is denied by
 * the policy layer before its handler runs.
 */
export const resolveTrustedAgentToolContext = async ({
  userId,
  toolKey,
  parameters = {},
  sqlClient = sql,
} = {}) => {
  const normalizedTool = text(toolKey).toLowerCase();
  const canvasWorkflowTools = new Set(["workflow.read", "workflow.save", "workflow.patch", "workflow.run"]);
  const context = normalizedTool === "workflow.run"
    && workflowContainsMcpCall(parameters?.definition ?? parameters?.workflow)
    ? { operationClassOverrideTrusted: true, operationClassOverride: "external_mcp" }
    : {};

  let owner = null;
  if (normalizedTool.startsWith("canvas.")
      || normalizedTool.startsWith("storyboard.")
      || normalizedTool.startsWith("timeline.")
      || normalizedTool.startsWith("director3d.")
      || canvasWorkflowTools.has(normalizedTool)) {
    owner = await findOwner(
      sqlClient,
      "canvases",
      "id",
      "user_id",
      text(parameters?.canvasId || parameters?.canvas_id),
    );
  } else if (normalizedTool === "creation.get") {
    owner = await findOwner(
      sqlClient,
      "creations",
      "id",
      "user_id",
      text(parameters?.creationId || parameters?.creation_id),
    );
  } else if (normalizedTool === "content.delete") {
    owner = await contentOwner({ sqlClient, parameters });
  } else if (normalizedTool === "content.publish") {
    owner = await findOwner(
      sqlClient,
      "prompt_templates",
      "id",
      "owner_user_id",
      text(parameters?.resourceId || parameters?.resource_id),
    );
  }

  const ownershipTool = normalizedTool === "creation.get"
    || normalizedTool === "content.delete"
    || normalizedTool === "content.publish"
    || normalizedTool.startsWith("canvas.")
    || normalizedTool.startsWith("storyboard.")
    || normalizedTool.startsWith("timeline.")
    || normalizedTool.startsWith("director3d.")
    || canvasWorkflowTools.has(normalizedTool);

  return ownershipTool
    ? { ...context, resourceOwnerUserId: owner || userId }
    : context;
};
