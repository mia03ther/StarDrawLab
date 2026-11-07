import winston from "winston";
import path from "path";
import fs from "fs";

const LOG_DIR = process.env.LOG_DIR || "logs";

// 确保日志目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const { combine, timestamp, json, colorize, simple, errors } = winston.format;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(errors({ stack: true }), timestamp(), json()),
  transports: [
    // 控制台输出（容器平台采集 stdout）
    new winston.transports.Console({
      format: combine(colorize(), simple()),
    }),
    // 持久化：所有日志
    new winston.transports.File({
      filename: path.join(LOG_DIR, "app.log"),
      maxsize: 20 * 1024 * 1024,  // 20 MB
      maxFiles: 14,
      tailable: true,
    }),
    // 持久化：仅错误日志
    new winston.transports.File({
      filename: path.join(LOG_DIR, "error.log"),
      level: "error",
      maxsize: 20 * 1024 * 1024,
      maxFiles: 14,
      tailable: true,
    }),
  ],
});

export default logger;
