import sql from "../configs/db.js";
import { chargePoints, releasePoints, reservePoints } from "../services/pointsService.js";
import { GenerationStorePort } from "../ports/generationStorePort.js";

export class PostgresGenerationStore extends GenerationStorePort {
  #sql;
  #points;

  constructor({ sqlClient = sql, points = { chargePoints, releasePoints, reservePoints } } = {}) {
    super();
    if (!sqlClient?.begin) throw new TypeError("Postgres generation store requires a transactional SQL client");
    for (const method of ["chargePoints", "releasePoints", "reservePoints"]) {
      if (typeof points?.[method] !== "function") throw new TypeError(`Postgres generation store requires ${method}`);
    }
    this.#sql = sqlClient;
    this.#points = points;
  }

  async findTemplate({ userId, sceneKey }) {
    const [template] = await this.#sql`
      SELECT * FROM prompt_templates
      WHERE scene_key = ${sceneKey} AND is_active = true
        AND (
          (visibility = 'public' AND approval_status = 'approved')
          OR owner_user_id = ${userId}
        )
      LIMIT 1
    `;
    return template || null;
  }

  async getMembershipTier(userId) {
    const [account] = await this.#sql`
      SELECT membership_tier FROM user_point_accounts WHERE user_id = ${userId}
    `;
    return String(account?.membership_tier || "free");
  }

  async findDigitalHumanRole({ userId, roleId }) {
    if (!roleId) return null;
    const [role] = await this.#sql`
      SELECT *
      FROM digital_human_roles
      WHERE id = ${roleId}
        AND user_id = ${userId}
        AND (
          status = 'ready'
          OR (status = 'training' AND ready_at IS NOT NULL AND ready_at <= NOW())
        )
      LIMIT 1
    `;
    if (!role) return null;
    if (role.status === "training") {
      const [ready] = await this.#sql`
        UPDATE digital_human_roles
        SET status = 'ready', updated_at = NOW()
        WHERE id = ${role.id} AND user_id = ${userId}
        RETURNING *
      `;
      return ready || { ...role, status: "ready" };
    }
    return role;
  }

  reserveImage({
    userId,
    template,
    sceneKey,
    model,
    pointsCost,
    idempotencyKey,
    expiresAt,
    metadata,
  }) {
    return this.#sql.begin(async (tx) => {
      const [creation] = await tx`
        INSERT INTO creations
          (user_id, provider, model, scene_key, scene_name, type, status, charge_status,
           points_reserved, points_cost, request_idempotency_key, expires_at, prompt, meta_info)
        VALUES
          (${userId}, ${template.target_provider}, ${model},
           ${sceneKey}, ${template.scene_name}, 'image', 'pending', 'none',
           0, 0, ${idempotencyKey}, ${expiresAt}, ${metadata.user_prompt || null}, ${JSON.stringify(metadata)}::jsonb)
        ON CONFLICT (user_id, request_idempotency_key) DO NOTHING
        RETURNING id
      `;

      if (!creation) {
        const [existing] = await tx`
          SELECT id, status, task_id, provider_status, content, thumbnail_url, points_reserved,
                 points_cost, expires_at, meta_info
          FROM creations
          WHERE user_id = ${userId} AND request_idempotency_key = ${idempotencyKey}
          FOR UPDATE
        `;
        return { isExisting: true, existing: existing || null };
      }

      await this.#points.reservePoints({
        userId,
        amount: pointsCost,
        creationId: creation.id,
        idempotencyKey: `reserve:creation:${creation.id}`,
        note: `预占：${template.scene_name}`,
        tx,
      });
      const [updated] = await tx`
        UPDATE creations
        SET charge_status = 'reserved', points_reserved = ${pointsCost}
        WHERE id = ${creation.id} AND charge_status = 'none'
        RETURNING id
      `;
      if (!updated) {
        throw Object.assign(new Error("Creation reservation state changed unexpectedly"), {
          status: 409,
          code: "CREATION_STATE_CONFLICT",
        });
      }
      return { isExisting: false, creationId: creation.id };
    });
  }

  async persistImageReference({
    creationId,
    referenceImageUrl,
    referenceImageObjectKey,
    referenceImageUrls = [],
    referenceImageObjectKeys = [],
  }) {
    const [updated] = await this.#sql`
      UPDATE creations
      SET meta_info = COALESCE(meta_info, '{}'::jsonb) || ${JSON.stringify({
        referenceImageUrl,
        referenceImageObjectKey,
        referenceImageUrls,
        referenceImageObjectKeys,
      })}::jsonb
      WHERE id = ${creationId} AND charge_status = 'reserved'
      RETURNING id
    `;
    if (!updated) {
      throw Object.assign(new Error("Image reference metadata could not be persisted"), {
        status: 409,
        code: "CREATION_STATE_CONFLICT",
      });
    }
    return updated;
  }

  async persistImageTask({ creationId, taskId, providerStatus, metadata = {} }) {
    const [updated] = await this.#sql`
      UPDATE creations
      SET task_id = ${taskId},
          status = 'pending',
          provider_status = ${providerStatus || "queued"},
          meta_info = (
            CASE
              WHEN jsonb_typeof(COALESCE(meta_info, '{}'::jsonb)) = 'object' THEN meta_info
              ELSE '{}'::jsonb
            END || ${JSON.stringify(metadata)}::jsonb
          )
      WHERE id = ${creationId} AND charge_status = 'reserved'
      RETURNING id
    `;
    if (!updated) {
      throw Object.assign(new Error("Reserved creation was not found while persisting the image provider task"), {
        status: 409,
        code: "CREATION_STATE_CONFLICT",
      });
    }
    return updated;
  }

  settleImage({ userId, creationId, pointsCost, contentUrl, contentObjectKey, generationTimeMs, template, metadata = {} }) {
    return this.#sql.begin(async (tx) => {
      const [reservedCreation] = await tx`
        SELECT id, charge_status
        FROM creations
        WHERE id = ${creationId} AND user_id = ${userId}
        FOR UPDATE
      `;
      if (!reservedCreation || reservedCreation.charge_status !== "reserved") {
        throw Object.assign(new Error("Creation is no longer reserved for settlement"), {
          status: 409,
          code: "CREATION_STATE_CONFLICT",
        });
      }

      await this.#points.chargePoints({
        userId,
        amount: pointsCost,
        creationId,
        idempotencyKey: `charge:creation:${creationId}`,
        note: `结算：${template.scene_name}`,
        tx,
      });
      const [updated] = await tx`
        UPDATE creations
        SET status = 'completed', charge_status = 'charged',
            provider_status = COALESCE(${metadata.providerStatus || null}, provider_status),
            points_reserved = 0, points_cost = ${pointsCost},
            content = ${contentUrl}, content_object_key = ${contentObjectKey},
            generation_time_ms = ${generationTimeMs},
            meta_info = COALESCE(meta_info, '{}'::jsonb) || ${JSON.stringify(metadata)}::jsonb
        WHERE id = ${creationId} AND charge_status = 'reserved'
        RETURNING id
      `;
      if (!updated) {
        throw Object.assign(new Error("Creation settlement state changed unexpectedly"), {
          status: 409,
          code: "CREATION_STATE_CONFLICT",
        });
      }
      return updated;
    });
  }

  releaseImage({ userId, creationId, errorMessage, providerStatus = null }) {
    return this.#sql.begin(async (tx) => {
      const [creation] = await tx`
        SELECT charge_status, points_reserved
        FROM creations
        WHERE id = ${creationId} AND user_id = ${userId}
        FOR UPDATE
      `;
      if (!creation || creation.charge_status !== "reserved") {
        return { released: false, chargeStatus: creation?.charge_status || null };
      }

      const reservedAmount = Number(creation.points_reserved || 0);
      await this.#points.releasePoints({
        userId,
        amount: reservedAmount,
        creationId,
        idempotencyKey: `release:creation:${creationId}`,
        note: "返还：图片生成失败",
        tx,
      });
      const [updated] = await tx`
        UPDATE creations
        SET status = 'failed', charge_status = 'released',
            provider_status = COALESCE(${providerStatus}, provider_status),
            points_reserved = 0, error_message = ${String(errorMessage || "Image generation failed").slice(0, 2000)}
        WHERE id = ${creationId} AND charge_status = 'reserved'
        RETURNING id
      `;
      if (!updated) throw new Error("Creation release state changed unexpectedly");
      return { released: true, reservedAmount };
    });
  }

  reserveVideo({
    userId,
    template,
    sceneKey,
    model,
    pointsCost,
    idempotencyKey,
    expiresAt,
    metadata,
  }) {
    return this.#sql.begin(async (tx) => {
      const [creation] = await tx`
        INSERT INTO creations
          (user_id, provider, model, scene_key, scene_name, type, status, charge_status,
           points_reserved, points_cost, request_idempotency_key, expires_at, prompt, meta_info)
        VALUES
          (${userId}, ${template.target_provider}, ${model},
           ${sceneKey}, ${template.scene_name}, 'video', 'pending', 'none',
           0, 0, ${idempotencyKey}, ${expiresAt}, ${metadata.user_prompt || null}, ${JSON.stringify(metadata)}::jsonb)
        ON CONFLICT (user_id, request_idempotency_key) DO NOTHING
        RETURNING id
      `;

      if (!creation) {
        const [existing] = await tx`
          SELECT id, status, task_id, points_reserved, points_cost, expires_at, meta_info
          FROM creations
          WHERE user_id = ${userId} AND request_idempotency_key = ${idempotencyKey}
          FOR UPDATE
        `;
        return { isExisting: true, existing: existing || null };
      }

      await this.#points.reservePoints({
        userId,
        amount: pointsCost,
        creationId: creation.id,
        idempotencyKey: `reserve:creation:${creation.id}`,
        note: `预占：${template.scene_name}`,
        tx,
      });
      const [updated] = await tx`
        UPDATE creations
        SET charge_status = 'reserved', points_reserved = ${pointsCost}
        WHERE id = ${creation.id} AND charge_status = 'none'
        RETURNING id
      `;
      if (!updated) {
        throw Object.assign(new Error("Creation reservation state changed unexpectedly"), {
          status: 409,
          code: "CREATION_STATE_CONFLICT",
        });
      }
      return { isExisting: false, creationId: creation.id };
    });
  }

  async persistVideoTask({ creationId, taskId, providerStatus, metadata }) {
    const [updated] = await this.#sql`
      UPDATE creations
      SET task_id = ${taskId}, status = 'pending',
          provider_status = ${providerStatus || "queued"},
          meta_info = (
            CASE
              WHEN jsonb_typeof(COALESCE(meta_info, '{}'::jsonb)) = 'object' THEN meta_info
              ELSE '{}'::jsonb
            END || ${JSON.stringify(metadata)}::jsonb
          )
      WHERE id = ${creationId} AND charge_status = 'reserved'
      RETURNING id
    `;
    if (!updated) {
      throw Object.assign(new Error("Reserved creation was not found while persisting the provider task"), {
        status: 409,
        code: "CREATION_STATE_CONFLICT",
      });
    }
    return updated;
  }

  releaseVideo({ userId, creationId, errorMessage }) {
    return this.#sql.begin(async (tx) => {
      const [creation] = await tx`
        SELECT charge_status, points_reserved
        FROM creations
        WHERE id = ${creationId} AND user_id = ${userId}
        FOR UPDATE
      `;
      if (!creation || creation.charge_status !== "reserved") {
        return { released: false, chargeStatus: creation?.charge_status || null };
      }

      const reservedAmount = Number(creation.points_reserved || 0);
      await this.#points.releasePoints({
        userId,
        amount: reservedAmount,
        creationId,
        idempotencyKey: `release:creation:${creationId}`,
        note: "返还：视频任务提交失败",
        tx,
      });
      const [updated] = await tx`
        UPDATE creations
        SET status = 'failed', charge_status = 'released',
            points_reserved = 0, error_message = ${String(errorMessage || "Video generation failed").slice(0, 2000)}
        WHERE id = ${creationId} AND charge_status = 'reserved'
        RETURNING id
      `;
      if (!updated) throw new Error("Creation release state changed unexpectedly");
      return { released: true, reservedAmount };
    });
  }
}

export const createPostgresGenerationStore = (options = {}) => new PostgresGenerationStore(options);
