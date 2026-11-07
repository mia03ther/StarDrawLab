import { AgentPlanStorePort } from "../ports/agentPlanExecutionPort.js";

const parseJson = (value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};

const jsonParameter = (tx, value) => (
  typeof tx.json === "function" ? tx.json(value) : JSON.stringify(value)
);

const mapStep = (row) => row ? ({
  id: String(row.id),
  runId: row.run_id,
  position: Number(row.position),
  callId: row.call_id,
  callName: row.call_name,
  toolKey: row.tool_key,
  reason: row.reason || "",
  parameters: parseJson(row.parameters) || {},
  resolvedParameters: parseJson(row.resolved_parameters),
  result: parseJson(row.result_snapshot),
  resultPersisted: row.result_snapshot != null,
  status: row.status,
  requiresApproval: Boolean(row.requires_approval),
  approvalReasonCode: row.approval_reason_code,
  parameterDigest: row.parameter_digest,
  approvedByUserId: row.approved_by_user_id,
  approvedAt: row.approved_at,
  approvalConsumedAt: row.approval_consumed_at,
  executionIdempotencyKey: row.execution_idempotency_key,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  failedAt: row.failed_at,
}) : null;

const mapRun = (row, steps = []) => row ? ({
  id: row.id,
  userId: row.user_id,
  userRole: row.user_role,
  membershipTier: row.membership_tier,
  sessionId: row.session_id,
  agentMode: row.agent_mode,
  instruction: row.instruction,
  language: row.language,
  summary: row.summary,
  plan: parseJson(row.plan_snapshot) || {},
  status: row.status,
  currentStep: Number(row.current_step || 0),
  totalSteps: Number(row.total_steps || 0),
  progress: Number(row.progress || 0),
  activeJobId: row.active_job_id == null ? null : String(row.active_job_id),
  errorCode: row.error_code,
  errorMessage: row.error_message,
  cancelReason: row.cancel_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  failedAt: row.failed_at,
  cancelledAt: row.cancelled_at,
  steps,
}) : null;

const fail = (message, code, status = 409) => {
  throw Object.assign(new Error(message), { code, status });
};

export class PostgresAgentPlanStore extends AgentPlanStorePort {
  constructor({ sqlClient } = {}) {
    super();
    if (!sqlClient || typeof sqlClient.begin !== "function") {
      throw new TypeError("PostgresAgentPlanStore requires a transactional SQL client");
    }
    this.sql = sqlClient;
  }

  async createRun({ run, steps }) {
    return this.sql.begin(async (tx) => {
      const [created] = await tx`
        INSERT INTO agent_plan_runs
          (id, user_id, user_role, membership_tier, session_id, agent_mode,
           instruction, language, summary, plan_snapshot, request_idempotency_key,
           request_hash, total_steps)
        VALUES
          (${run.id}, ${run.userId}, ${run.userRole}, ${run.membershipTier},
           ${run.sessionId}, ${run.agentMode}, ${run.instruction}, ${run.language},
           ${run.summary}, ${jsonParameter(tx, run.plan)}, ${run.requestIdempotencyKey},
           ${run.requestHash}, ${steps.length})
        ON CONFLICT (user_id, request_idempotency_key) DO NOTHING
        RETURNING *
      `;
      if (!created) {
        const [existing] = await tx`
          SELECT * FROM agent_plan_runs
          WHERE user_id = ${run.userId} AND request_idempotency_key = ${run.requestIdempotencyKey}
          LIMIT 1
        `;
        if (!existing || existing.request_hash !== run.requestHash) {
          fail("Agent plan idempotency key was reused with different parameters", "AGENT_PLAN_IDEMPOTENCY_CONFLICT");
        }
        const existingSteps = await tx`
          SELECT * FROM agent_plan_steps WHERE run_id = ${existing.id} ORDER BY position ASC
        `;
        return mapRun(existing, existingSteps.map(mapStep));
      }
      for (const step of steps) {
        await tx`
          INSERT INTO agent_plan_steps
            (run_id, position, call_id, call_name, tool_key, reason, parameters,
             execution_idempotency_key)
          VALUES
             (${run.id}, ${step.position}, ${step.callId}, ${step.callName},
             ${step.toolKey}, ${step.reason}, ${jsonParameter(tx, step.parameters)},
             ${step.executionIdempotencyKey})
        `;
      }
      return mapRun(created, steps);
    });
  }

  async attachJob({ runId, userId, jobId }) {
    const [row] = await this.sql`
      UPDATE agent_plan_runs
      SET active_job_id = ${jobId}, updated_at = NOW()
      WHERE id = ${runId} AND user_id = ${userId}
        AND status IN ('queued', 'running', 'waiting_approval', 'waiting_client')
      RETURNING *
    `;
    if (!row) fail("Agent plan cannot accept a job", "AGENT_PLAN_STATE_CONFLICT");
    return mapRun(row);
  }

  async getRun({ runId, userId = null }) {
    const [row] = await this.sql`
      SELECT * FROM agent_plan_runs
      WHERE id = ${runId} AND (${userId}::varchar IS NULL OR user_id = ${userId})
      LIMIT 1
    `;
    if (!row) return null;
    const stepRows = await this.sql`
      SELECT * FROM agent_plan_steps WHERE run_id = ${runId} ORDER BY position ASC
    `;
    return mapRun(row, stepRows.map(mapStep));
  }

  async markWaitingApproval({ runId, stepId, resolvedParameters, parameterDigest, reasonCode }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE agent_plan_steps
        SET status = 'waiting_approval', resolved_parameters = ${jsonParameter(tx, resolvedParameters)},
            requires_approval = TRUE, approval_reason_code = ${reasonCode || null},
            parameter_digest = ${parameterDigest}, error_code = NULL, error_message = NULL,
            updated_at = NOW()
        WHERE id = ${stepId} AND run_id = ${runId}
          AND status IN ('ready', 'waiting_approval')
        RETURNING *
      `;
      if (!step) fail("Agent plan step cannot wait for approval", "AGENT_PLAN_STEP_STATE_CONFLICT");
      await tx`
        UPDATE agent_plan_runs
        SET status = 'waiting_approval', current_step = ${step.position},
            progress = FLOOR(((${step.position} - 1)::numeric / total_steps) * 100)::int,
            updated_at = NOW(), started_at = COALESCE(started_at, NOW())
        WHERE id = ${runId} AND status NOT IN ('completed', 'failed', 'cancelled')
      `;
      return mapStep(step);
    });
  }

  async approveStep({ runId, userId, stepId, parameterDigest, jobId }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE agent_plan_steps
        SET status = 'ready', approved_by_user_id = ${userId}, approved_at = NOW(),
            updated_at = NOW(), error_code = NULL, error_message = NULL
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'waiting_approval'
          AND parameter_digest = ${parameterDigest}
          AND EXISTS (
            SELECT 1 FROM agent_plan_runs runs
            WHERE runs.id = ${runId} AND runs.user_id = ${userId}
              AND runs.status = 'waiting_approval'
          )
        RETURNING *
      `;
      if (!step) fail("Agent plan step is no longer awaiting this approval", "AGENT_PLAN_APPROVAL_STATE_CONFLICT");
      await tx`
        UPDATE agent_plan_runs
        SET status = 'queued', active_job_id = ${jobId}, updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId} AND status = 'waiting_approval'
      `;
      return mapStep(step);
    });
  }

  async markWaitingClient({ runId, stepId, result }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE agent_plan_steps
        SET status = 'waiting_client', result_snapshot = ${jsonParameter(tx, result ?? null)},
            updated_at = NOW(), error_code = NULL, error_message = NULL
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'running'
        RETURNING *
      `;
      if (!step) fail("Agent plan step cannot wait for the browser", "AGENT_PLAN_STEP_STATE_CONFLICT");
      await tx`
        UPDATE agent_plan_runs
        SET status = 'waiting_client', current_step = ${step.position},
            progress = FLOOR(((${step.position} - 1)::numeric / total_steps) * 100)::int,
            updated_at = NOW(), started_at = COALESCE(started_at, NOW())
        WHERE id = ${runId} AND status NOT IN ('completed', 'failed', 'cancelled')
      `;
      return mapStep(step);
    });
  }

  async completeClientStep({ runId, userId, stepId, clientResult, jobId = null }) {
    return this.completeClientStepAndAppend({ runId, userId, stepId, clientResult, jobId, newSteps: [] });
  }

  async completeClientStepAndAppend({ runId, userId, stepId, clientResult, jobId = null, newSteps = [], finalResponse = null }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE agent_plan_steps
        SET status = 'completed',
            result_snapshot = COALESCE(result_snapshot, '{}'::jsonb)
              || ${jsonParameter(tx, { clientResult: clientResult ?? null })},
            completed_at = NOW(), updated_at = NOW(), error_code = NULL, error_message = NULL
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'waiting_client'
          AND EXISTS (
            SELECT 1 FROM agent_plan_runs runs
            WHERE runs.id = ${runId} AND runs.user_id = ${userId}
              AND runs.status = 'waiting_client'
          )
        RETURNING *
      `;
      if (!step) fail("Agent browser action is no longer waiting", "AGENT_PLAN_CLIENT_ACTION_STATE_CONFLICT");
      for (const nextStep of newSteps) {
        await tx`
          INSERT INTO agent_plan_steps
            (run_id, position, call_id, call_name, tool_key, reason, parameters,
             execution_idempotency_key)
          VALUES
            (${runId}, ${nextStep.position}, ${nextStep.callId}, ${nextStep.callName},
             ${nextStep.toolKey}, ${nextStep.reason}, ${jsonParameter(tx, nextStep.parameters)},
             ${nextStep.executionIdempotencyKey})
        `;
      }
      const [counts] = await tx`
        SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
               COUNT(*)::int AS total
        FROM agent_plan_steps WHERE run_id = ${runId}
      `;
      const completed = Number(counts.completed || 0);
      const total = Number(counts.total || 1);
      const done = completed === total;
      await tx`
        UPDATE agent_plan_runs
        SET status = ${done ? "completed" : "queued"}, current_step = ${completed},
            total_steps = ${total},
            progress = ${done ? 100 : Math.floor((completed / total) * 100)},
            active_job_id = ${done ? null : jobId},
            plan_snapshot = CASE WHEN ${finalResponse || null}::text IS NULL THEN plan_snapshot
              ELSE jsonb_set(plan_snapshot, '{finalResponse}', to_jsonb(${finalResponse || null}::text), TRUE) END,
            completed_at = CASE WHEN ${done} THEN NOW() ELSE completed_at END,
            updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId} AND status = 'waiting_client'
      `;
      return { step: mapStep(step), done };
    });
  }

  async markStepRunning({ runId, stepId, resolvedParameters, parameterDigest }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE agent_plan_steps
        SET status = 'running', resolved_parameters = ${jsonParameter(tx, resolvedParameters)},
            parameter_digest = ${parameterDigest}, started_at = COALESCE(started_at, NOW()),
            updated_at = NOW(), error_code = NULL, error_message = NULL
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'ready'
        RETURNING *
      `;
      if (!step) fail("Agent plan step is not ready", "AGENT_PLAN_STEP_STATE_CONFLICT");
      await tx`
        UPDATE agent_plan_runs
        SET status = 'running', current_step = ${step.position},
            started_at = COALESCE(started_at, NOW()), updated_at = NOW(),
            error_code = NULL, error_message = NULL
        WHERE id = ${runId} AND status IN ('queued', 'running')
      `;
      return mapStep(step);
    });
  }

  async recordStepResult({ runId, stepId, result }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE agent_plan_steps
        SET result_snapshot = ${jsonParameter(tx, result ?? null)}, updated_at = NOW()
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'running'
        RETURNING *
      `;
      if (!step) fail("Agent plan step cannot persist its result", "AGENT_PLAN_STEP_STATE_CONFLICT");
      return mapStep(step);
    });
  }

  async deferStep({ runId, stepId, result, jobId }) {
    return this.sql.begin(async (tx) => {
      const [step] = result === undefined
        ? await tx`
            UPDATE agent_plan_steps
            SET status = 'ready', updated_at = NOW(), error_code = NULL, error_message = NULL
            WHERE id = ${stepId} AND run_id = ${runId} AND status IN ('ready', 'running')
            RETURNING *
          `
        : await tx`
            UPDATE agent_plan_steps
            SET status = 'ready', result_snapshot = ${jsonParameter(tx, result ?? null)},
                updated_at = NOW(), error_code = NULL, error_message = NULL
            WHERE id = ${stepId} AND run_id = ${runId} AND status IN ('ready', 'running')
            RETURNING *
          `;
      if (!step) fail("Agent plan step cannot be deferred", "AGENT_PLAN_STEP_STATE_CONFLICT");
      const [run] = await tx`
        UPDATE agent_plan_runs
        SET status = 'queued', active_job_id = ${jobId}, current_step = ${step.position},
            updated_at = NOW(), error_code = NULL, error_message = NULL
        WHERE id = ${runId} AND status IN ('queued', 'running')
        RETURNING *
      `;
      if (!run) fail("Agent plan cannot be deferred", "AGENT_PLAN_STATE_CONFLICT");
      const stepRows = await tx`
        SELECT * FROM agent_plan_steps WHERE run_id = ${runId} ORDER BY position ASC
      `;
      return mapRun(run, stepRows.map(mapStep));
    });
  }

  async completeStep({ runId, stepId, result, approvalConsumed = false }) {
    return this.completeStepAndAppend({ runId, stepId, result, approvalConsumed, newSteps: [] });
  }

  async completeStepAndAppend({ runId, stepId, result, approvalConsumed = false, newSteps = [], finalResponse = null }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE agent_plan_steps
        SET status = 'completed', result_snapshot = ${jsonParameter(tx, result ?? null)},
            approval_consumed_at = CASE WHEN ${approvalConsumed} THEN NOW() ELSE approval_consumed_at END,
            completed_at = NOW(), updated_at = NOW(), error_code = NULL, error_message = NULL
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'running'
        RETURNING *
      `;
      if (!step) fail("Agent plan step is not running", "AGENT_PLAN_STEP_STATE_CONFLICT");
      for (const nextStep of newSteps) {
        await tx`
          INSERT INTO agent_plan_steps
            (run_id, position, call_id, call_name, tool_key, reason, parameters,
             execution_idempotency_key)
          VALUES
            (${runId}, ${nextStep.position}, ${nextStep.callId}, ${nextStep.callName},
             ${nextStep.toolKey}, ${nextStep.reason}, ${jsonParameter(tx, nextStep.parameters)},
             ${nextStep.executionIdempotencyKey})
        `;
      }
      const [counts] = await tx`
        SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
               COUNT(*)::int AS total
        FROM agent_plan_steps WHERE run_id = ${runId}
      `;
      const completed = Number(counts.completed || 0);
      const total = Number(counts.total || 1);
      const done = completed === total;
      const [run] = await tx`
        UPDATE agent_plan_runs
        SET status = ${done ? "completed" : "running"}, current_step = ${completed},
            total_steps = ${total},
            progress = ${done ? 100 : Math.floor((completed / total) * 100)},
            plan_snapshot = CASE WHEN ${finalResponse || null}::text IS NULL THEN plan_snapshot
              ELSE jsonb_set(plan_snapshot, '{finalResponse}', to_jsonb(${finalResponse || null}::text), TRUE) END,
            completed_at = CASE WHEN ${done} THEN NOW() ELSE completed_at END,
            updated_at = NOW()
        WHERE id = ${runId} AND status NOT IN ('failed', 'cancelled')
        RETURNING *
      `;
      const stepRows = await tx`
        SELECT * FROM agent_plan_steps WHERE run_id = ${runId} ORDER BY position ASC
      `;
      return mapRun(run, stepRows.map(mapStep));
    });
  }

  async resetStepForRetry({ runId, stepId, errorCode }) {
    const [step] = await this.sql`
      UPDATE agent_plan_steps
      SET status = 'ready', error_code = ${errorCode || "AGENT_STEP_RETRY"},
          error_message = 'Agent step will be retried', updated_at = NOW()
      WHERE id = ${stepId} AND run_id = ${runId} AND status = 'running'
      RETURNING *
    `;
    if (!step) fail("Agent plan step cannot be retried", "AGENT_PLAN_STEP_STATE_CONFLICT");
    await this.sql`
      UPDATE agent_plan_runs SET status = 'queued', updated_at = NOW()
      WHERE id = ${runId} AND status = 'running'
    `;
    return mapStep(step);
  }

  async failStep({ runId, stepId, errorCode, errorMessage }) {
    return this.sql.begin(async (tx) => {
      if (stepId != null) {
        await tx`
          UPDATE agent_plan_steps
          SET status = 'failed', error_code = ${errorCode}, error_message = ${errorMessage},
              failed_at = NOW(), updated_at = NOW()
          WHERE id = ${stepId} AND run_id = ${runId}
            AND status NOT IN ('completed', 'cancelled')
        `;
      }
      const [run] = await tx`
        UPDATE agent_plan_runs
        SET status = 'failed', error_code = ${errorCode}, error_message = ${errorMessage},
            failed_at = NOW(), updated_at = NOW()
        WHERE id = ${runId} AND status NOT IN ('completed', 'cancelled')
        RETURNING *
      `;
      return mapRun(run);
    });
  }

  async cancelRun({ runId, userId, reason }) {
    return this.sql.begin(async (tx) => {
      const [run] = await tx`
        UPDATE agent_plan_runs
        SET status = 'cancelled', cancel_reason = ${reason}, cancelled_at = NOW(), updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId}
          AND status IN ('queued', 'running', 'waiting_approval', 'waiting_client')
        RETURNING *
      `;
      if (!run) {
        const [existing] = await tx`SELECT * FROM agent_plan_runs WHERE id = ${runId} AND user_id = ${userId}`;
        if (!existing) fail("Agent plan was not found", "AGENT_PLAN_NOT_FOUND", 404);
        if (existing.status === "cancelled") return mapRun(existing);
        fail("Agent plan cannot be cancelled", "AGENT_PLAN_STATE_CONFLICT");
      }
      await tx`
        UPDATE agent_plan_steps SET status = 'cancelled', updated_at = NOW()
        WHERE run_id = ${runId} AND status IN ('ready', 'running', 'waiting_approval', 'waiting_client')
      `;
      return mapRun(run);
    });
  }
}
