const pickChinese = (zh) => zh;

export const getGenerationErrorDetail = (error) => {
  const data = error?.response?.data ?? error;
  const value = data?.error_message ?? data?.error?.message ?? data?.message ?? data;
  if (typeof value === "string") return value.trim();
  if (value && typeof value.message === "string") return value.message.trim();
  return "";
};

export const getGenerationErrorMessage = (error, t = pickChinese, fallback) => {
  const data = error?.response?.data ?? error;
  const code = String(data?.code ?? data?.error?.code ?? "");
  const detail = getGenerationErrorDetail(error);
  const text = `${code} ${detail}`;
  const status = Number(error?.response?.status ?? data?.statusCode ?? data?.httpStatus);
  // An upstream authorization failure is different from an expired website login.
  if (/provider.*(?:HTTP\s*)?(?:401|403)|(?:401|403).*provider/i.test(text)) {
    return t("模型服务授权失败，请换一个模型或联系管理员检查模型配置。", "The model service denied access. Choose another model or ask an administrator to check its configuration.");
  }
  if (status === 401 || /AUTH_REQUIRED|TOKEN_EXPIRED|Authorization header required/i.test(text)) {
    return t("登录状态已失效，请重新登录后再试。", "Your login has expired. Sign in again and retry.");
  }
  if (status === 403 || /FORBIDDEN|ACCESS_DENIED/.test(code)) {
    return t("当前账号没有执行此操作的权限，请联系管理员。", "Your account does not have permission for this action. Contact an administrator.");
  }
  if (/INSUFFICIENT_POINTS|insufficient (?:points|credits)/i.test(text)) {
    return t("积分不足，请查看积分余额和本次所需积分后再提交。", "You do not have enough points. Check your balance and the estimated cost before submitting again.");
  }
  if (/MODEL_ROUTE_INCOMPATIBLE|selected model route is incompatible/i.test(text)) {
    return t("所选模型不支持这次生成，请更换模型后再提交。", "The selected model does not support this request. Choose another model before submitting again.");
  }
  if (/content.?policy|moderation|content.?filter|safety.?system|CONTENT_REJECTED/i.test(text)) {
    return t("内容未通过模型审核，请调整描述或参考素材后再试。", "The model rejected the content. Adjust your description or reference material and retry.");
  }
  if (status === 429 || /overload|rate.?limit|too many requests/i.test(text)) {
    return t("模型服务繁忙，请稍后重试或更换模型。", "The model service is busy. Retry later or choose another model.");
  }
  if (/invalid (?:JSON|planning response)|CANVAS_AGENT_INVALID_RESPONSE/i.test(text)) {
    return t("助手未能生成可执行的方案，请简化要求后重试，或直接进入图片、视频工作台。", "The assistant could not create an executable plan. Simplify your request and retry, or use the image or video workspace directly.");
  }
  if (/timeout|timed out|ECONNABORTED|ETIMEDOUT/i.test(text)) {
    return t("请求等待超时，请先到任务中心确认任务状态，避免重复提交。", "The request timed out. Check Task Center before submitting again to avoid duplicate tasks.");
  }
  if (/Network Error|ERR_NETWORK|Failed to fetch/i.test(text)) {
    return t("网络连接中断，请检查网络，并到任务中心确认是否已提交成功。", "The connection was interrupted. Check your network and Task Center to see whether the task was accepted.");
  }
  if (/Video generation failed/i.test(text)) {
    return t("视频生成失败，请更换模型或调整描述后重试；积分变化请以积分记录为准。", "Video generation failed. Choose another model or adjust your description; check your points history for billing details.");
  }
  if (/MEDIA_ARTIFACT_|empty.*(?:video|artifact)|(?:video|artifact).*empty/i.test(text)) {
    return t("视频文件尚未保存成功，请稍后在任务中心查看结果。", "The video file has not been saved successfully. Check Task Center again shortly.");
  }
  if (/[\u3400-\u9fff]/.test(detail)) return detail;
  return fallback || t("本次操作未完成，请查看任务状态后重试，或联系管理员反馈。", "This action did not complete. Check the task status before retrying, or contact an administrator.");
};
