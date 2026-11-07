export const assertVideoGenerationAvailable = () => {
  if (String(process.env.VIDEO_GENERATION_ENABLED || "true").toLowerCase() === "false") {
    throw Object.assign(new Error("视频生成维护中，恢复后另行通知。已有视频仍可查看和下载。"), {status:503,code:"VIDEO_GENERATION_MAINTENANCE",retryable:false});
  }
};
