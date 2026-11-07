const parseJson = (value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};

const json = (db, value) => typeof db.json === "function" ? db.json(value) : JSON.stringify(value);

const fail = (message, code = "CANVAS_AGENT_STATE_CONFLICT", status = 409) => {
  throw Object.assign(new Error(message), { code, status });
};

const mapStep = (row) => row ? ({
  id: String(row.id),
  runId: row.run_id,
  position: Number(row.position),
  thought: row.thought || "",
  toolKey: row.tool_key,
  parameters: parseJson(row.parameters) || {},
  result: parseJson(row.result_snapshot),
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
  conversationId: row.conversation_id,
  userId: row.user_id,
  canvasId: row.canvas_id,
  userRole: row.user_role,
  membershipTier: row.membership_tier,
  agentMode: row.agent_mode,
  textModel: row.text_model_key,
  imageModel: row.image_model_key,
  videoModel: row.video_model_key,
  instruction: row.instruction,
  language: row.language,
  contextSnapshot: parseJson(row.context_snapshot) || {},
  finalSummary: row.final_summary,
  status: row.status,
  currentStep: Number(row.current_step || 0),
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

const addEvent = (db, runId, userId, eventType, payload = {}) => db`
  INSERT INTO canvas_agent_events (run_id, user_id, event_type, payload)
  VALUES (${runId}, ${userId}, ${eventType}, ${json(db, payload)})
`;

export class CanvasAgentRunStore {
  constructor({ sqlClient } = {}) {
    if (!sqlClient || typeof sqlClient.begin !== "function") {
      throw new TypeError("CanvasAgentRunStore requires a transactional SQL client");
    }
    this.sql = sqlClient;
  }

  async createRun({ run }) {
    return this.sql.begin(async (tx) => {
      const [created] = await tx`
        INSERT INTO canvas_agent_runs
          (id, conversation_id, user_id, canvas_id, user_role, membership_tier,
           agent_mode, text_model_key, image_model_key, video_model_key,
           instruction, language, context_snapshot, request_idempotency_key, request_hash)
        VALUES
          (${run.id}, ${run.conversationId}, ${run.userId}, ${run.canvasId},
           ${run.userRole}, ${run.membershipTier}, ${run.agentMode}, ${run.textModel},
           ${run.imageModel || null}, ${run.videoModel || null}, ${run.instruction},
           ${run.language}, ${json(tx, run.contextSnapshot || {})},
           ${run.requestIdempotencyKey}, ${run.requestHash})
        ON CONFLICT (user_id, request_idempotency_key) DO NOTHING
        RETURNING *
      `;
      if (!created) {
        const [existing] = await tx`
          SELECT * FROM canvas_agent_runs
          WHERE user_id = ${run.userId} AND request_idempotency_key = ${run.requestIdempotencyKey}
          LIMIT 1
        `;
        if (!existing || existing.request_hash !== run.requestHash) {
          fail("Canvas Agent idempotency key was reused with different parameters", "CANVAS_AGENT_IDEMPOTENCY_CONFLICT");
        }
        const rows = await tx`SELECT * FROM canvas_agent_steps WHERE run_id = ${existing.id} ORDER BY position ASC`;
        return mapRun(existing, rows.map(mapStep));
      }
      await addEvent(tx, run.id, run.userId, "run.queued", { status: "queued" });
      return mapRun(created);
    });
  }

  async attachJob({ runId, userId, jobId, status = "queued" }) {
    const [row] = await this.sql`
      UPDATE canvas_agent_runs
      SET active_job_id = ${jobId}, status = ${status}, updated_at = NOW()
      WHERE id = ${runId} AND user_id = ${userId}
        AND status IN ('queued', 'running', 'waiting_external')
      RETURNING *
    `;
    if (!row) fail("Canvas Agent run cannot accept a job");
    return mapRun(row);
  }

  async getRun({ runId, userId = null }) {
    const [row] = await this.sql`
      SELECT * FROM canvas_agent_runs
      WHERE id = ${runId} AND (${userId}::varchar IS NULL OR user_id = ${userId})
      LIMIT 1
    `;
    if (!row) return null;
    const stepRows = await this.sql`
      SELECT * FROM canvas_agent_steps WHERE run_id = ${runId} ORDER BY position ASC
    `;
    return mapRun(row, stepRows.map(mapStep));
  }

  async listEvents({ runId, userId, afterId = 0, limit = 100 }) {
    const rows = await this.sql`
      SELECT event.id, event.event_type, event.payload, event.created_at
      FROM canvas_agent_events event
      JOIN canvas_agent_runs run ON run.id = event.run_id
      WHERE event.run_id = ${runId} AND run.user_id = ${userId} AND event.id > ${afterId}
      ORDER BY event.id ASC
      LIMIT ${Math.min(200, Math.max(1, Number(limit) || 100))}
    `;
    return rows.map((row) => ({
      id: String(row.id),
      eventType: row.event_type,
      payload: parseJson(row.payload) || {},
      createdAt: row.created_at,
    }));
  }

  async addStep({ runId, userId, thought, toolKey, parameters, executionIdempotencyKey }) {
    return this.sql.begin(async (tx) => {
      const [run] = await tx`
        SELECT * FROM canvas_agent_runs
        WHERE id = ${runId} AND user_id = ${userId}
          AND status IN ('queued', 'running', 'waiting_external')
        FOR UPDATE
      `;
      if (!run) fail("Canvas Agent run is not active");
      const position = Number(run.current_step || 0) + 1;
      if (position > 240) fail("Canvas Agent reached the stored observation limit", "CANVAS_AGENT_STEP_LIMIT", 422);
      const [step] = await tx`
        INSERT INTO canvas_agent_steps
          (run_id, position, thought, tool_key, parameters, execution_idempotency_key)
        VALUES
          (${runId}, ${position}, ${String(thought || "").slice(0, 1200)}, ${toolKey},
           ${json(tx, parameters || {})}, ${executionIdempotencyKey})
        RETURNING *
      `;
      await tx`
        UPDATE canvas_agent_runs
        SET status = 'running', current_step = ${position},
            progress = LEAST(95, ${Math.max(2, Math.floor((position / 40) * 95))}),
            started_at = COALESCE(started_at, NOW()), updated_at = NOW()
        WHERE id = ${runId}
      `;
      await addEvent(tx, runId, userId, "step.planned", {
        stepId: String(step.id), position, thought: step.thought, toolKey,
      });
      return mapStep(step);
    });
  }

  async markWaitingApproval({ runId, userId, stepId, parameterDigest, reasonCode }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE canvas_agent_steps
        SET status = 'waiting_approval', requires_approval = TRUE,
            approval_reason_code = ${reasonCode}, parameter_digest = ${parameterDigest}, updated_at = NOW()
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'ready'
        RETURNING *
      `;
      if (!step) fail("Canvas Agent step cannot wait for approval");
      await tx`
        UPDATE canvas_agent_runs
        SET status = 'waiting_approval', active_job_id = NULL, updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId}
      `;
      await addEvent(tx, runId, userId, "step.waiting_approval", {
        stepId: String(step.id), position: Number(step.position), toolKey: step.tool_key,
        reasonCode,
      });
      return mapStep(step);
    });
  }

  async approveStep({ runId, userId, stepId, parameterDigest, jobId }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE canvas_agent_steps
        SET status = 'ready', approved_by_user_id = ${userId}, approved_at = NOW(), updated_at = NOW()
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'waiting_approval'
          AND parameter_digest = ${parameterDigest}
          AND EXISTS (
            SELECT 1 FROM canvas_agent_runs run
            WHERE run.id = ${runId} AND run.user_id = ${userId} AND run.status = 'waiting_approval'
          )
        RETURNING *
      `;
      if (!step) fail("Canvas Agent approval is no longer valid", "CANVAS_AGENT_APPROVAL_STATE_CONFLICT");
      await tx`
        UPDATE canvas_agent_runs
        SET status = 'queued', active_job_id = ${jobId}, updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId} AND status = 'waiting_approval'
      `;
      await addEvent(tx, runId, userId, "step.approved", {
        stepId: String(step.id), position: Number(step.position), toolKey: step.tool_key,
      });
      return mapStep(step);
    });
  }

  async markStepRunning({ runId, userId, stepId, parameterDigest }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE canvas_agent_steps
        SET status = 'running', parameter_digest = ${parameterDigest},
            started_at = COALESCE(started_at, NOW()), updated_at = NOW(),
            error_code = NULL, error_message = NULL
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'ready'
        RETURNING *
      `;
      if (!step) fail("Canvas Agent step is not ready");
      await tx`
        UPDATE canvas_agent_runs
        SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId} AND status IN ('queued', 'running', 'waiting_external')
      `;
      await addEvent(tx, runId, userId, "step.running", {
        stepId: String(step.id), position: Number(step.position), toolKey: step.tool_key,
      });
      return mapStep(step);
    });
  }

  async completeStep({ runId, userId, stepId, result, waitingExternal = false }) {
    return this.sql.begin(async (tx) => {
      const [step] = await tx`
        UPDATE canvas_agent_steps
        SET status = 'completed', result_snapshot = ${json(tx, result ?? null)},
            approval_consumed_at = CASE WHEN approved_at IS NOT NULL THEN NOW() ELSE approval_consumed_at END,
            completed_at = NOW(), updated_at = NOW(), error_code = NULL, error_message = NULL
        WHERE id = ${stepId} AND run_id = ${runId} AND status = 'running'
        RETURNING *
      `;
      if (!step) fail("Canvas Agent step is not running");
      await tx`
        UPDATE canvas_agent_runs
        SET status = ${waitingExternal ? "waiting_external" : "running"}, updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId} AND status = 'running'
      `;
      await addEvent(tx, runId, userId, "step.completed", {
        stepId: String(step.id), position: Number(step.position), toolKey: step.tool_key,
        waitingExternal: Boolean(waitingExternal),
      });
      return mapStep(step);
    });
  }

  async resetStepForRetry({ runId, userId, stepId, errorCode }) {
    const [step] = await this.sql`
      UPDATE canvas_agent_steps
      SET status = 'ready', error_code = ${errorCode}, error_message = 'Canvas Agent step will be retried', updated_at = NOW()
      WHERE id = ${stepId} AND run_id = ${runId} AND status = 'running'
      RETURNING *
    `;
    if (!step) fail("Canvas Agent step cannot be retried");
    await this.sql`
      UPDATE canvas_agent_runs SET status = 'queued', updated_at = NOW()
      WHERE id = ${runId} AND user_id = ${userId} AND status = 'running'
    `;
    return mapStep(step);
  }

  async completeRun({ runId, userId, summary }) {
    return this.sql.begin(async (tx) => {
      const [run] = await tx`
        UPDATE canvas_agent_runs
        SET status = 'completed', final_summary = ${String(summary || "").slice(0, 8000)},
            progress = 100, active_job_id = NULL, completed_at = NOW(), updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId}
          AND status IN ('queued', 'running', 'waiting_external')
        RETURNING *
      `;
      if (!run) fail("Canvas Agent run cannot be completed");
      await addEvent(tx, runId, userId, "run.completed", { summary: run.final_summary });
      const rows = await tx`SELECT * FROM canvas_agent_steps WHERE run_id = ${runId} ORDER BY position ASC`;
      return mapRun(run, rows.map(mapStep));
    });
  }

  async failRun({ runId, userId, stepId = null, errorCode, errorMessage }) {
    return this.sql.begin(async (tx) => {
      if (stepId != null) {
        await tx`
          UPDATE canvas_agent_steps
          SET status = 'failed', error_code = ${errorCode}, error_message = ${errorMessage},
              failed_at = NOW(), updated_at = NOW()
          WHERE id = ${stepId} AND run_id = ${runId} AND status NOT IN ('completed', 'cancelled')
        `;
      }
      const [run] = await tx`
        UPDATE canvas_agent_runs
        SET status = 'failed', error_code = ${errorCode}, error_message = ${errorMessage},
            active_job_id = NULL, failed_at = NOW(), updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId} AND status NOT IN ('completed', 'cancelled')
        RETURNING *
      `;
      if (!run) return null;
      await addEvent(tx, runId, userId, "run.failed", { errorCode, errorMessage });
      const rows = await tx`SELECT * FROM canvas_agent_steps WHERE run_id = ${runId} ORDER BY position ASC`;
      return mapRun(run, rows.map(mapStep));
    });
  }

  async cancelRun({ runId, userId, reason }) {
    return this.sql.begin(async (tx) => {
      const [run] = await tx`
        UPDATE canvas_agent_runs
        SET status = 'cancelled', cancel_reason = ${String(reason || "Cancelled by user").slice(0, 500)},
            active_job_id = NULL, cancelled_at = NOW(), updated_at = NOW()
        WHERE id = ${runId} AND user_id = ${userId}
          AND status IN ('queued', 'running', 'waiting_approval', 'waiting_external')
        RETURNING *
      `;
      if (!run) {
        // Do not call this.getRun() here. It uses the root SQL client while
        // this transaction still holds the row lock from the UPDATE. A
        // second PostgreSQL connection can wait for this transaction to
        // commit while this transaction is waiting for that query.
        const [existing] = await tx`
          SELECT * FROM canvas_agent_runs
          WHERE id = ${runId} AND user_id = ${userId}
          LIMIT 1
        `;
        if (!existing) fail("Canvas Agent run was not found", "CANVAS_AGENT_RUN_NOT_FOUND", 404);
        if (existing.status === "cancelled") {
          const rows = await tx`SELECT * FROM canvas_agent_steps WHERE run_id = ${runId} ORDER BY position ASC`;
          return mapRun(existing, rows.map(mapStep));
        }
        fail("Canvas Agent run cannot be cancelled");
      }
      await tx`
        UPDATE canvas_agent_steps SET status = 'cancelled', updated_at = NOW()
        WHERE run_id = ${runId} AND status IN ('ready', 'running', 'waiting_approval', 'waiting_external')
      `;
      await addEvent(tx, runId, userId, "run.cancelled", { reason: run.cancel_reason });
      const rows = await tx`SELECT * FROM canvas_agent_steps WHERE run_id = ${runId} ORDER BY position ASC`;
      return mapRun(run, rows.map(mapStep));
    });
  }
}

export { mapRun as mapCanvasAgentRun, mapStep as mapCanvasAgentStep };
