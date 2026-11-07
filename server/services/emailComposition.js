import { SmtpEmailAdapter, createSmtpEmailAdapter, isSmtpConfigured } from "../infrastructure/smtpEmailAdapter.js";
import { EmailPort } from "../ports/emailPort.js";

let emailSender;

const assertEmailPort = (adapter) => {
  if (!adapter || typeof adapter.send !== "function") {
    throw new TypeError("An email adapter with send(message) is required");
  }
  return adapter;
};

/**
 * Composition root for outbound email. The adapter is created lazily so a
 * server with no SMTP configuration never creates a network-capable client.
 */
export const getEmailSender = () => {
  if (emailSender) return emailSender;
  if (!isSmtpConfigured()) return null;
  emailSender = createSmtpEmailAdapter();
  return emailSender;
};

export const setEmailSender = (adapter) => {
  emailSender = assertEmailPort(adapter);
  return emailSender;
};

export const resetEmailSender = () => {
  emailSender = null;
};

export { EmailPort, SmtpEmailAdapter };
