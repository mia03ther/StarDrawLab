# PostgreSQL 迁移账本与受控执行

迁移 041 新建 `schema_migrations`，只记录从 041 开始通过受控脚本执行的迁移。不要凭文件名
猜测并回填 001–040；历史迁移需要先对生产结构、约束、索引和当时 SQL 做单独审计。

每次迁移前先执行 PostgreSQL 备份并完成校验，然后在服务器的 `server/` 目录运行：

```bash
npm run migration:apply -- \
  --file migrations/041_schema_migration_ledger.sql \
  --applied-by authing:你的-root-user-id \
  --release-version 20260808-ledger
```

脚本会：

1. 只接受 `server/migrations/NNN_name.sql`；
2. 获取 PostgreSQL advisory lock，避免两个发布同时迁移；
3. 计算 SHA-256，并拒绝已应用版本的文件、名称或摘要变化；
4. 强制迁移版本递增；
5. 使用支持多语句的 simple-query 模式，兼容 040 一类不能被外层事务包裹的并发索引迁移；
6. 记录执行人、发布版本和耗时。

041 成功后，候选 API 的 `/ready` 才会返回 migration 41。公网响应只公开迁移能力版本，
不会公开 PostgreSQL 数据库名或 schema 名。
