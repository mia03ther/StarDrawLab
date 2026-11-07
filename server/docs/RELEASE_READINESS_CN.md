# StarDraw 当前上线前清单

本文记录“代码已在工作区”和“已经在线生效”的区别。本文只提供检查和上线顺序，
不会由应用自动执行数据库迁移，也不会自动打开支付或后台 Worker。

## 当前线上基线与工作区状态

- 服务端测试：227/227 通过。
- 前端 ESLint：通过。
- 前端生产构建：通过。
- `docker compose config --quiet`：通过。
- `git diff --check`：通过。
- API 和 Worker 已挂载只读的 root Skill 目录；默认分镜 Skill 可被服务端读取。
- `npm run release:check` 可执行不连接数据库的配置和迁移文件预检。
- 支付查单会保留支付宝响应中的显式 APPID/PID，避免被本地配置掩盖。
- 当前工作区最新迁移为 `057`；生产数据库实际版本必须通过 `release:db-check` 核对，部署新 API 前在维护窗口按顺序应用缺失迁移。
- API 与 Worker 使用同一个版本化服务端镜像；Web 使用同一发布号构建。
- PostgreSQL 16 custom dump 已完成校验与 `pg_restore --list` 验证；其 schema 已在无宿主端口、无生产卷的隔离 PostgreSQL 16 中恢复，并从真实迁移 43 结构成功试跑迁移 44。隔离验证容器已清理。
- 支付查询和退款补偿 Worker 已启用；支付宝周期扣款关闭时，到期订阅会正常过期并回到手动续费路径。

## 容器入口与可观测性（待下次镜像发布生效）

- Web Nginx 使用 Docker 内置 DNS `127.0.0.11` 动态解析 `api:5000`，API 容器
  地址变化后无需依赖重启 Web 才能恢复代理。
- `/health` 显式代理 API 存活检查，`/ready` 显式代理数据库感知的 API 就绪检查；
  外层公网反向代理应按运维策略限制 `/ready` 的公网访问，避免公开内部就绪详情。
- Web 使用仅允许容器本机访问的 `/nginx-health` 做健康检查，不把 API 故障误报为
  Nginx 进程故障。
- Worker 使用本地文件心跳和 PID 检查，不新增 HTTP 监听端口，也不在健康检查中
  连接数据库。
- API 与 Worker 分别使用 `api_logs`、`worker_logs` 卷和独立目录；API、Worker、
  Web 的 Docker `json-file` 日志统一限制为每文件 10 MiB、最多 5 个文件。

以上项目只是工作区配置；应用到生产前仍需构建版本化镜像并在维护窗口部署。
单独执行 `docker compose config --quiet`、Nginx `-t` 或 Worker 心跳单测不会连接数据库。

## 当前仍需业务验收或保持关闭

1. `SUBSCRIPTION_PURCHASES_ENABLED` 同时控制会员和长期积分包购买，仍需两类商品的支付宝正式小额支付验收后再开启。
2. `ALIPAY_PERIODIC_ENABLED=false`，当前只做主动续费提醒，不做自动扣款。
3. `HEYGEN_API_KEY` 未配置时只允许浏览器离线数字人渲染，外部 HeyGen 能力保持关闭。
4. root 新增的每个 MCP 服务、OAuth client 和用户授权仍需逐项验收。
5. `CREATION_NOTIFICATION_ENABLED` 打开前应评估是否会给历史终态作品补发邮件。

预检命令：

```bash
cd /opt/stardraw/server
npm run release:check
npm run release:db-check
```

`release:check` 不连接 PostgreSQL；`release:db-check` 只读连接数据库并验证真实 schema capability。
两者都不会调用模型供应商、发送邮件、执行迁移或重启容器。

`ALIPAY_PERIODIC_ENABLED` 当前按产品决定保持 `false`。这表示用户到期前收到主动
续费提醒，不会发生自动扣款；不要仅填写一个产品码就打开该开关。

## 数据库迁移顺序

迁移文件必须从 `001_full_schema.sql` 到 `057_generation_pricing_modes.sql`
按数字顺序审查和应用。应用前必须完成数据库备份、目标库确认、维护窗口和回滚方案。
应用代码不会替管理员猜测历史数据，也不会自动跳过失败迁移。

至少需要重点核对：

- `014-024`：订阅、回收站、RBAC、模型路由、幂等操作；
- `025-030`：持久队列、Agent/MCP、执行限流和视觉参数；
- `031-034`：计费结算、任务/生成通知和退款补偿；
- `035`：支付宝支付查单租约、重试、关单和状态字段；
- `036-039`：参考图模型能力、社区、Agent Skill 与持久 Agent Plan；
- `040`：浏览器动作 `waiting_client` 状态和活动索引；
- `041-043`：迁移账本、Agent 模型路由和媒体供应商目录；
- `044`：会员与长期积分包双计费商品、订单、退款和积分批次归属。
- `045–047`：执行速率、Agent 会话、Creative LLM 与提示词优化。
- `048–052`：画布 Agent、工作流、模板搜索、媒体轮询和持久任务 JSON 约束。
- `053–055`：会话软删除、全局 Agent 偏好和 Agent 文本模型路由。
- `056`：邀请配置、个人/通用邀请码、一次性兑换和积分奖励入账。
- `057`：生成定价规则增加自由生成/模板生成模式，并补充模式专属默认规则。

## Worker 安全启用

Worker 已放在 Compose 的 `worker` profile 中，普通 `docker compose up` 不会启动它。
确认迁移和验收完成后，才在维护窗口执行类似下面的显式启用：

```bash
RELEASE_VERSION=<已构建版本> JOB_WORKER_ENABLED=true \
  docker compose --profile worker up -d --no-build api web worker
docker compose ps
docker compose logs --tail=100 worker
```

`server/.env` 中以下开关仍需逐项确认，不能因为 Worker 启动就全部打开：

```env
METERED_SETTLEMENT_RECONCILIATION_ENABLED=false
SUBSCRIPTION_REFUND_RECONCILIATION_ENABLED=true
SUBSCRIPTION_PAYMENT_RECONCILIATION_ENABLED=true
CREATION_NOTIFICATION_ENABLED=false
```

完成对应迁移、沙箱测试、邮件测试后，才将单个开关改为 `true` 并观察日志。

## 支付正式验收最小集

- 正常电脑网站支付并收到异步通知；
- 会员商品和长期积分包分别完成一次小额支付，当前积分包不设过期时间且不改变会员等级；
- 浏览器返回丢失但异步通知到达；
- 异步通知丢失，由 `alipay.trade.query` 恢复；
- 重复通知和重复查单不重复开通会员或发放积分，两个订单表之间也禁止复用同一支付宝交易号；
- 签名、APPID、PID、订单号、金额不匹配均不入账；
- 长时间未支付订单调用 `alipay.trade.close`，确认关闭后才取消本地订单；
- 查询超时/未知状态会重试，不把不确定结果当作失败或成功；
- 退款状态未知时积分继续冻结，主动查询确认后才完成退款补偿。

退款补偿首版使用主动查询；`depositback.completed` 按产品决定暂不接入。
