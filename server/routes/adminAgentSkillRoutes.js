import express from "express";
import {
  deactivateDatabaseSkill,
  listDatabaseSkills,
  upsertDatabaseSkill,
} from "../services/agentSkillDatabaseService.js";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";
import { executeAdministratorOperation } from "../services/administratorOperationService.js";
import { writeAuditLog } from "../services/auditService.js";

const router = express.Router();
const requireSkillManage = requirePermission(PERMISSIONS.AGENT_SKILL_MANAGE);

const key = (req) => String(req.headers["x-idempotency-key"] || "").trim();
const requireMutation = (req, res, next) => {
  if (!key(req) || key(req).length > 128) {
    return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid X-Idempotency-Key header is required" });
  }
  return next();
};

router.get("/", requireSkillManage, async (_req, res, next) => {
  try {
    return res.json({ success: true, data: await listDatabaseSkills({ includeInactive: true }) });
  } catch (error) { return next(error); }
});

router.post("/", requireSkillManage, requireMutation, async (req, res, next) => {
  try {
    const data = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: key(req),
      action: "agent_skill.created",
      targetType: "agent_skill",
      targetId: req.body?.name,
      requestPayload: req.body,
      mutate: async (tx) => {
        const result = await upsertDatabaseSkill({ input: req.body, actorUserId: req.auth.userId, db: tx });
        await writeAuditLog({
          req, actorUserId: req.auth.userId, actorRole: req.auth.role,
          action: "agent_skill.created", targetType: "agent_skill", targetId: result.id,
          reason: "管理员创建数据库 Skill", after: { ...result, content: "[REDACTED]" }, tx,
        });
        return result;
      },
    });
    return res.status(201).json({ success: true, data });
  } catch (error) { return next(error); }
});

router.put("/:name", requireSkillManage, requireMutation, async (req, res, next) => {
  try {
    const data = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: key(req),
      action: "agent_skill.updated",
      targetType: "agent_skill",
      targetId: req.params.name,
      requestPayload: req.body,
      mutate: async (tx) => {
        const result = await upsertDatabaseSkill({
          input: req.body, existingName: req.params.name, actorUserId: req.auth.userId, db: tx,
        });
        await writeAuditLog({
          req, actorUserId: req.auth.userId, actorRole: req.auth.role,
          action: "agent_skill.updated", targetType: "agent_skill", targetId: result.id,
          reason: "管理员更新数据库 Skill", after: { ...result, content: "[REDACTED]" }, tx,
        });
        return result;
      },
    });
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
});

router.delete("/:name", requireSkillManage, requireMutation, async (req, res, next) => {
  try {
    const data = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: key(req),
      action: "agent_skill.deactivated",
      targetType: "agent_skill",
      targetId: req.params.name,
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const result = await deactivateDatabaseSkill({ name: req.params.name, actorUserId: req.auth.userId, db: tx });
        await writeAuditLog({
          req, actorUserId: req.auth.userId, actorRole: req.auth.role,
          action: "agent_skill.deactivated", targetType: "agent_skill", targetId: result.id,
          reason: "管理员停用数据库 Skill", after: { ...result, content: "[REDACTED]" }, tx,
        });
        return result;
      },
    });
    return res.json({ success: true, data });
  } catch (error) { return next(error); }
});

export default router;
