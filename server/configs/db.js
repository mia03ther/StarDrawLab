/**
 * 数据库连接 — postgres（porsager）
 *
 * 生产基线：PostgreSQL 16（spec-v1 决策 5A 完全冻结，不允许使用旧版本）。
 * 云厂商不绑定：可使用阿里云 ApsaraDB RDS for PostgreSQL 16 或其他支持 PG16 的托管/自建实例。
 * 使用标准 TCP 连接池，API 与 @neondatabase/serverless 模板字面量接口兼容，事务写法相同。
 */
import postgres from "postgres";
import logger from "./logger.js";
import { resolveDatabaseSsl } from "./databaseSecurity.js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  logger.warn("DATABASE_URL is not set — database calls will fail");
}

const sql = postgres(DATABASE_URL || "postgres://localhost/quickai", {
  max: 10,              // 连接池最大连接数
  idle_timeout: 30,     // 空闲连接超时（秒）
  connect_timeout: 10,  // 连接超时（秒）
  ssl: resolveDatabaseSsl(),
  onnotice: (msg) => logger.debug("pg.notice", { msg }),
  debug: process.env.NODE_ENV === "development"
    ? (conn, query) => logger.debug("pg.query", { query: query.slice(0, 200) })
    : undefined,
});

export default sql;
