import logger from "../configs/logger.js";
import { getExecutionGovernor } from "./executionGovernorComposition.js";
import { getGenerationApplication } from "./generationApplicationService.js";

const safeTier = (value) => String(value || "free").trim().toLowerCase() || "free";

/**
 * Application boundary for direct HTTP media generation.
 *
 * Business idempotency and point reservations remain owned by the generation
 * application. This wrapper owns only shared cross-instance admission so a
 * second API process cannot bypass per-user rate, concurrency or daily caps.
 */
export class GenerationExecutionService {
  constructor({ generationApplication, governor = null, log = logger } = {}) {
    if (typeof generationApplication?.generateImage !== "function"
      || typeof generationApplication?.generateVideo !== "function") {
      throw new TypeError("GenerationExecutionService requires a generation application");
    }
    if (governor && (typeof governor.admit !== "function"
      || typeof governor.complete !== "function"
      || typeof governor.release !== "function")) {
      throw new TypeError("GenerationExecutionService requires a compatible execution governor");
    }
    this.generationApplication = generationApplication;
    this.governor = governor;
    this.log = log;
  }

  async #execute({ operationKey, membershipTier, request, invoke }) {
    const admission = this.governor
      ? await this.governor.admit({
          userId: request.userId,
          membershipTier: safeTier(membershipTier),
          operationKey,
          queueName: "media-generation",
          idempotencyKey: request.idempotencyKey || null,
          leaseDurationMs: 30 * 60 * 1000,
          metadata: {
            source: "direct_media_generation",
            sceneKey: String(request.sceneKey || "").slice(0, 120),
          },
        })
      : null;

    try {
      const result = await invoke();
      if (admission) {
        await this.governor.complete({ leaseId: admission.leaseId }).catch((error) => {
          this.log.error("generation.execution_governor.complete_failed", {
            operationKey,
            userId: request.userId,
            error: error.message,
          });
        });
      }
      return result;
    } catch (error) {
      if (admission) {
        await this.governor.release({ leaseId: admission.leaseId, outcome: "failed", error }).catch((releaseError) => {
          this.log.error("generation.execution_governor.release_failed", {
            operationKey,
            userId: request.userId,
            error: releaseError.message,
          });
        });
      }
      throw error;
    }
  }

  async generateImage({ membershipTier = "free", ...request } = {}) {
    return this.#execute({
      operationKey: "generation.image",
      membershipTier,
      request,
      invoke: () => this.generationApplication.generateImage(request),
    });
  }

  async generateVideo({ membershipTier = "free", ...request } = {}) {
    return this.#execute({
      operationKey: "generation.video",
      membershipTier,
      request,
      invoke: () => this.generationApplication.generateVideo(request),
    });
  }
}

let runtime;
export const getGenerationExecution = () => {
  if (!runtime) runtime = new GenerationExecutionService({
    generationApplication: getGenerationApplication(),
    governor: getExecutionGovernor(),
  });
  return runtime;
};

export const resetGenerationExecutionForTests = () => {
  runtime = null;
};
