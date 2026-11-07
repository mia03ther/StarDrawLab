# PostgreSQL 持久化 Job Queue 第一版

本版队列是一个独立的应用端口和 PostgreSQL 适配器。`JobQueuePort` 不依赖数据库或具体消息中间件；`PostgresJobQueue` 只依赖现有 `configs/db.js` 导出的 postgres 客户端接口。未来可以增加 Redis/BullMQ adapter，而不改变工作流、Agent、计费和审计的核心服务。

## 数据边界

Job 的 `payload`、`input_refs`、`metadata` 和 `result_snapshot` 只保存 JSON 参数、OSS/其他对象存储 key、任务 ID 等引用。适配器拒绝 Buffer、TypedArray、ArrayBuffer、循环对象和超过 512 KiB 的 JSON；媒体文件必须留在对象存储中。

## 状态和租约

`queued -> running -> completed` 是成功路径；执行失败时，只要尚未达到 `max_attempts` 就重新进入 `queued`，达到上限后进入 `failed`。`cancel` 将排队或运行中的任务置为终态 `cancelled`。

Worker 领取任务时使用数据库事务、`FOR UPDATE SKIP LOCKED` 和租约。Worker 崩溃后，其他 Worker 可以领取已过期租约；达到最大尝试次数的过期任务会变成 `failed`。只有当前租约 owner 才能 heartbeat、complete 或 fail，旧 Worker 不能覆盖新 Worker 的结果。

## 幂等和扩展

`(queue_name, user_id, idempotency_key)` 唯一约束保证重复提交返回原任务；同一 key 搭配不同参数会返回冲突。队列端口不关心 HTTP 请求、Agent、模型供应商或媒体存储。

Worker 使用 `createJobWorker({ queue, execute })`，执行器由组合根注入。当前组合根通过
`JobExecutorRegistry` 注册 `workflow.dispatch`、`workflow.node`、`agent.tool` 和
`mcp.call`；未知 job type 会 fail-closed，进入队列已有的重试/终态失败流程。
这样队列只负责可靠调度，未来可以把 PostgreSQL 的 lease 实现替换成 Redis/BullMQ，而不会把队列细节泄漏到领域层。

## Agent 结算补偿

Agent 供应商成功后，服务先把结果快照写入 `metered_agent_operations`，再用
`charge:agent-operation:<id>` 幂等扣除此前的积分预占。扣款失败时状态为
`settlement_pending`，积分仍保持 held；补偿扫描器只处理同时具备
`provider_completed_at` 和结果快照的记录，因此不会在供应商结果未知时自动扣费或返还。
连续失败达到阈值后，扫描器会写入审计字段并通过 SMTP 给
`OPERATIONAL_ALERT_EMAILS` 配置的 root/admin 发告警。需要人工调查的未知结果不会触发第二次
供应商调用。

## Worker 进程

API 不会在主进程里偷偷启动 Worker。`workerEntry.js` 是独立组合根，默认由
`JOB_WORKER_ENABLED=false` 保护；部署编排应把它作为独立进程运行，并显式设置
`JOB_WORKER_ENABLED=true`、`JOB_QUEUE_NAME=workflow`。在迁移 025、026、027、031
审核并执行、所有实际 provider handler 和计费规则就绪前，不要启动它。

例如可以在已构建的 server 镜像中以独立容器命令运行：

```bash
docker compose run --rm \
  -e JOB_WORKER_ENABLED=true \
  -e JOB_QUEUE_NAME=workflow \
  api node workerEntry.js
```

同一个 Worker 还可以通过独立开关运行支付宝支付查单补偿。应用迁移 035 后设置
`SUBSCRIPTION_PAYMENT_RECONCILIATION_ENABLED=true`，它会领取带数据库租约的待支付
订单并调用 `alipay.trade.query`；超时未支付订单通过 `alipay.trade.close` 关闭。
该开关与普通工作流队列开关分离，默认关闭。

生产环境应将该命令配置为带 `restart: unless-stopped` 的独立服务，而不是与
API 进程共用生命周期。

### Worker 进程健康检查

Worker 不开放 HTTP 端口。`workerEntry.js` 在任务循环启动后，每隔
`WORKER_HEALTH_INTERVAL_MS` 将不含凭据的进程快照原子写入
`WORKER_HEALTH_FILE`。Compose 使用独立 Node 检查器核对以下条件：

- 心跳 JSON 可读取且状态为 `running`；
- 心跳年龄不超过 `WORKER_HEALTH_STALE_MS`；
- 记录的 PID 仍存在于当前容器进程命名空间。

默认值为 15 秒写入一次、60 秒后判定过期。该心跳只反映 Worker 进程和事件循环
存活，不替代任务租约心跳，也不会连接 PostgreSQL。Worker 日志写入独立的
`/app/logs/worker` 目录和 `worker_logs` 卷，不再与 API 日志混写。

## 上线注意

`025_persistent_jobs.sql` 和 `031_metered_agent_settlement_reconciliation.sql` 只作为待发布迁移文件，本次没有连接或修改任何生产数据库，也没有重建、重启容器或修改线上服务。当前 Worker 代码已接入独立组合根，但本次没有启动 Worker，也没有执行迁移，避免改变正在运行的服务启动行为。补偿扫描还受 `METERED_SETTLEMENT_RECONCILIATION_ENABLED=false` 保护，必须在迁移和演练完成后单独开启。
