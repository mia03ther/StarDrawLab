import express from "express";
import {
  getScenes,
  estimatePoints,
  generateSceneImage,
  generateSoraVideo,
  generateDigitalHumanVideo,
  optimizeDigitalHumanBrief,
  optimizeGenerationPrompt,
  checkVideoStatus,
  checkImageStatus,
} from "../controllers/aiController.js";
import { agentBurstLimiter, agentLimiter, generateBurstLimiter, generateLimiter } from "../middlewares/rateLimiter.js";
import { upload } from "../configs/multer.js";
import { listAvailableModelsController } from "../controllers/modelConfigurationController.js";

const aiRouter = express.Router();

aiRouter.get("/scenes", getScenes);
aiRouter.get("/models", listAvailableModelsController);
aiRouter.post("/estimate-points", estimatePoints);

// 限流器直接挂在路由上，执行顺序保证正确（Bug 3 修复）
aiRouter.post("/generate-scene-image", generateBurstLimiter, generateLimiter, upload.array("images", 4), generateSceneImage);
aiRouter.post("/generate-sora-video",  generateBurstLimiter, generateLimiter, upload.array("images", 4), generateSoraVideo);
aiRouter.post("/optimize-digital-human-script", generateBurstLimiter, generateLimiter, optimizeDigitalHumanBrief);
aiRouter.post("/optimize-generation-prompt", agentBurstLimiter, agentLimiter, optimizeGenerationPrompt);
aiRouter.post("/generate-digital-human", generateBurstLimiter, generateLimiter, generateDigitalHumanVideo);

aiRouter.get("/video-status/:creationId", checkVideoStatus);
aiRouter.get("/image-status/:creationId", checkImageStatus);

export default aiRouter;
