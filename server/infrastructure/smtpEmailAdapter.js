import nodemailer from "nodemailer";
import { EmailPort } from "../ports/emailPort.js";

const asString = (value) => String(value ?? "");

const smtpConfigFromEnv = (env = process.env) => ({
  host: asString(env.SMTP_HOST).trim(),
  port: Number(env.SMTP_PORT || 465),
  secure: asString(env.SMTP_SECURE || "true").toLowerCase() === "true",
  auth: {
    user: asString(env.SMTP_USER).trim(),
    pass: asString(env.SMTP_PASSWORD),
  },
});

export const smtpConfigurationStatus = (env = process.env) => {
  const config = smtpConfigFromEnv(env);
  const from = asString(env.SMTP_FROM).trim();
  const missing = [];
  if (!config.host) missing.push("SMTP_HOST");
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) missing.push("SMTP_PORT");
  if (!config.auth.user) missing.push("SMTP_USER");
  if (!config.auth.pass) missing.push("SMTP_PASSWORD");
  if (!from) missing.push("SMTP_FROM");
  return { configured: missing.length === 0, missing, config, from };
};

/** Adapter for the current Nodemailer SMTP provider. */
export class SmtpEmailAdapter extends EmailPort {
  #transporter;

  constructor({ transporter, config, transportFactory = nodemailer.createTransport } = {}) {
    super();
    if (!transporter && typeof transportFactory !== "function") {
      throw new TypeError("SMTP email adapter requires a transport factory");
    }
    if (!transporter && !config?.host) {
      throw new TypeError("SMTP email adapter requires SMTP host configuration");
    }
    if (!transporter && (!Number.isSafeInteger(config?.port) || config.port < 1 || config.port > 65_535)) {
      throw new TypeError("SMTP email adapter requires a valid SMTP port");
    }
    if (!transporter && (!config?.auth?.user || !config?.auth?.pass)) {
      throw new TypeError("SMTP email adapter requires SMTP credentials");
    }
    this.#transporter = transporter || transportFactory(config);
    if (typeof this.#transporter?.sendMail !== "function") {
      throw new TypeError("SMTP email adapter requires a transporter with sendMail");
    }
  }

  send(message) {
    return this.#transporter.sendMail(message);
  }
}

export const isSmtpConfigured = (env = process.env) => smtpConfigurationStatus(env).configured;

export const createSmtpEmailAdapter = ({ env = process.env, transportFactory } = {}) => {
  const status = smtpConfigurationStatus(env);
  if (!status.configured) {
    throw new TypeError(`SMTP configuration is incomplete: ${status.missing.join(", ")}`);
  }
  const config = status.config;
  return new SmtpEmailAdapter({ config, transportFactory });
};

export { smtpConfigFromEnv };
