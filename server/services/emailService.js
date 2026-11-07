import logger from "../configs/logger.js";
import { getEmailSender } from "./emailComposition.js";
import { isSmtpConfigured } from "../infrastructure/smtpEmailAdapter.js";

export { isSmtpConfigured };

const operationalAlertRecipients = () => [...new Set(
  String(process.env.OPERATIONAL_ALERT_EMAILS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
)];

const getConfiguredFrom = () => String(process.env.SMTP_FROM || process.env.SMTP_USER || "").trim();

const SENSITIVE_DETAIL_KEY = /authorization|cookie|credential|password|payload|secret|token/i;
const redactSensitiveText = (value) => String(value ?? "")
  .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
  .replace(/\b(?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
  .slice(0, 1_000);

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
}[character]));

const taskLabels = Object.freeze({
  "workflow.run": "工作流",
  "agent.tool": "Agent 任务",
  "mcp.call": "MCP 任务",
  "creation.image": "图片生成",
  "creation.video": "视频生成",
  "creation.digital_human": "数字人生成",
});

export const sendOperationalAlert = async ({ subject, message, details = {} } = {}) => {
  const recipients = operationalAlertRecipients();
  if (recipients.length === 0) {
    logger.warn("operational.alert.skipped", { reason: "missing_recipients", subject });
    return { sent: false, skipped: true, reason: "missing_recipients" };
  }
  const mailer = getEmailSender();
  if (!mailer) {
    logger.warn("operational.alert.skipped", { reason: "smtp_not_configured", subject });
    return { sent: false, skipped: true, reason: "smtp_not_configured" };
  }
  const from = getConfiguredFrom();
  if (!from) {
    logger.warn("operational.alert.skipped", { reason: "smtp_from_not_configured", subject });
    return { sent: false, skipped: true, reason: "smtp_from_not_configured" };
  }

  const safeSubject = String(subject || "StarDraw operational alert").trim().slice(0, 180);
  const safeMessage = String(message || "An operational alert requires attention.").trim().slice(0, 4_000);
  const safeDetails = Object.fromEntries(Object.entries(details || {}).map(([key, value]) => {
    const safeKey = String(key).slice(0, 100);
    return [safeKey, SENSITIVE_DETAIL_KEY.test(safeKey) ? "[REDACTED]" : redactSensitiveText(value)];
  }));
  const detailText = Object.entries(safeDetails).map(([key, value]) => `${key}: ${value}`).join("\n");
  await mailer.send({
    from,
    to: recipients,
    subject: safeSubject,
    text: `${safeMessage}${detailText ? `\n\n${detailText}` : ""}`,
  });
  logger.info("operational.alert.sent", { subject: safeSubject, recipientCount: recipients.length });
  return { sent: true, recipientCount: recipients.length };
};

export const sendJobSettlementNotification = async ({
  to,
  displayName,
  taskId,
  jobType,
  outcome,
} = {}) => {
  const recipient = String(to || "").trim().toLowerCase().slice(0, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false, skipped: true, reason: "missing_recipient" };
  }
  const mailer = getEmailSender();
  if (!mailer) return { sent: false, skipped: true, reason: "smtp_not_configured" };
  const from = getConfiguredFrom();
  if (!from) return { sent: false, skipped: true, reason: "smtp_from_not_configured" };

  const normalizedOutcome = outcome === "completed" ? "completed" : "failed";
  const taskLabel = taskLabels[jobType] || "长任务";
  const safeTaskId = String(taskId || "").trim().slice(0, 128);
  const safeName = String(displayName || "用户").trim().slice(0, 80) || "用户";
  const statusText = normalizedOutcome === "completed" ? "已完成" : "最终失败";
  const subject = `StarDraw ${taskLabel}任务${normalizedOutcome === "completed" ? "完成" : "失败"}`;
  const text = `${safeName}，你的${taskLabel}（任务编号：${safeTaskId}）${statusText}。请登录 StarDraw 查看任务详情。`;

  await mailer.send({
    from,
    to: recipient,
    subject,
    text,
    html: `<p>${escapeHtml(safeName)}，你的${escapeHtml(taskLabel)}（任务编号：<code>${escapeHtml(safeTaskId)}</code>）${statusText}。</p><p>请登录 StarDraw 查看任务详情。</p>`,
  });
  logger.info("job-settlement.notification.sent", { jobType, outcome: normalizedOutcome });
  return { sent: true };
};

export const sendSubscriptionExpiryReminder = async ({ to, planName, expiresAt }) => {
  const recipient = String(to || "").trim();
  if (!recipient) return { sent: false, skipped: true, reason: "missing_recipient" };

  const mailer = getEmailSender();
  if (!mailer) {
    logger.warn("subscription.reminder.skipped", { reason: "smtp_not_configured" });
    return { sent: false, skipped: true, reason: "smtp_not_configured" };
  }

  const from = getConfiguredFrom();
  if (!from) {
    logger.warn("subscription.reminder.skipped", { reason: "smtp_from_not_configured" });
    return { sent: false, skipped: true, reason: "smtp_from_not_configured" };
  }

  const dateText = new Intl.DateTimeFormat("zh-CN", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(expiresAt));

  const safePlanName = String(planName || "会员套餐");

  await mailer.send({
    from,
    to: recipient,
    subject: "StarDraw 会员即将到期，请及时续费",
    text: `你的 StarDraw「${safePlanName}」会员将于 ${dateText} 到期。到期后不会自动续费，请登录 StarDraw 选择套餐主动续费。`,
    html: `<p>你的 StarDraw「${escapeHtml(safePlanName)}」会员将于 <strong>${escapeHtml(dateText)}</strong> 到期。</p><p>到期后不会自动续费，请登录 StarDraw 选择套餐主动续费。</p>`,
  });

  logger.info("subscription.reminder.sent", { planName, expiresAt });
  return { sent: true };
};
