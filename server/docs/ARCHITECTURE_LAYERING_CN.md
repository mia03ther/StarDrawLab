# StarDraw 分层架构与可替换适配器

本文记录当前后端的分层约束。目标是让更换 Authing、模型供应商、对象存储、支付或队列时，变化集中在 Adapter/Infrastructure，而不是扩散到控制器和领域规则。

## 分层职责

| 层 | 允许依赖 | 主要职责 |
| --- | --- | --- |
| Domain | 标准库 | 纯规则、规范化、计费估算、权限决策、画布状态模型 |
| Application/Services | Domain、Ports | 用例编排、事务边界、幂等、审批、计费和审计 |
| Ports | 标准库 | 外部能力的最小接口，不出现 Express、PostgreSQL、SDK 类型或密钥 |
| Adapters/Infrastructure | Ports、具体 SDK/数据库 | PostgreSQL、Aliyun OSS、Alipay、MCP HTTP/OAuth、邮件和 Worker 的具体实现 |
| Controllers/Routes | Application、Composition Root | HTTP 输入输出、认证上下文映射、错误到状态码的转换 |

## 当前已经落地的 seam

- `PaymentGatewayPort` → `AlipayPaymentGateway`：订阅服务只依赖支付能力接口；电脑网站支付、周期签约、续费、退款和异步通知验签都经过同一个网关 seam。
- `ObjectStoragePort` → `OssObjectStorageAdapter`：图片、视频、音频、模板预览、头像、回收站清理和私有资源代理通过统一对象存储运行时访问。
- `ImageGenerationPort`、`VideoGenerationPort` → 当前图片、Sora 和 HeyGen Adapters：控制器只处理规范化后的媒体请求，不再直接依赖 Provider 函数或 Provider 特有的参数顺序。
- `CreativeAgentPort` → 当前全局/画布 Agent、数字人口播脚本和图片/视频提示词优化 Adapter：调用统一通过 Creative LLM 配置模块解析，当前服务端路由到 `gpt-5.6-sol`，供应商密钥不会进入浏览器。
- `IdentityProviderPort` → `AuthingIdentityProviderAdapter` / `OidcIdentityProviderAdapter`：HTTP 中间件只消费已验证 claims；具体供应商配置、JWKS 发现与缓存、RS256/issuer/audience 验证集中在 Adapter，并可由离线 fake 替换。`AUTH_PROVIDER` 默认是 `authing`，切换到 `oidc`/`logto` 不改变业务层。
- `identity_links`：认证供应商的 `(provider, issuer, subject)` 映射到稳定的 StarDraw `user_id`。认证供应商不能直接决定积分、会员、角色、作品或 root 身份；映射开关只有在迁移 058 已应用并完成账号映射后才能打开。
- `JobQueuePort` → PostgreSQL 持久队列：任务参数只保存 JSON 和对象 key；Worker 通过 executor registry 调度。
- `ExecutionGovernorPort`：付费/外部任务的并发、额度、租约和释放逻辑与具体队列解耦。
- `McpOAuthPort`、`McpTransportPort`、`McpRepositoryPort`、`CredentialVaultPort`：MCP OAuth、Streamable HTTP、加密凭证和 PostgreSQL 数据访问已分离。
- Agent 工具注册、审批和审计通过 Agent ports 与运行时组合根进入服务端。

## 依赖规则

1. Controller 不直接实例化 SDK、队列或 OAuth 客户端。
2. 业务服务不读取 `process.env` 来决定供应商协议细节；配置应在 Adapter 或 composition root 解析后以能力形式传入。
3. Port 方法参数使用业务值和稳定 DTO，不传递 SDK response、Express request/response 或数据库行对象。
4. 外部调用必须有超时、大小限制、错误分类和审计；支付成功只能由验签后的异步通知确认。
5. 所有可替换 Adapter 都必须能被内存 fake 替换。测试应穿过 Port seam，而不是依赖真实 OSS、支付宝或模型密钥。
6. 生产 composition root 不开启 mock；未配置的外部能力必须 fail closed。

## 当前仍待收口

- `aiController.js` 仍包含较多生成用例与 PostgreSQL 查询，下一步应提取 `GenerationApplicationService`，把事务、积分预占/结算和 Provider 调用从 HTTP 控制器继续下沉到应用层。
- `subscriptionService.js` 的账务事务仍直接使用 PostgreSQL；支付 SDK 已隔离，后续可提取订阅仓储端口，保持积分账本和订阅状态转换在应用层。
- 模型目录仍需进一步集中到 composition root；Authing/JWKS 和 SMTP 已分别通过 Identity Provider 与 Email seams 收口。更换供应商前必须补齐兼容 Adapter 和契约测试。

## 部署边界

本次分层改造没有执行数据库迁移、没有连接生产数据库、没有启动 Worker，也没有重启线上 API、Nginx 或 Docker。新迁移和以下开关仍须在维护窗口逐项验收后开启：

```env
JOB_WORKER_ENABLED=false
EXECUTION_GOVERNOR_ENABLED=false
METERED_SETTLEMENT_RECONCILIATION_ENABLED=false
SUBSCRIPTION_PURCHASES_ENABLED=false
ALIPAY_PERIODIC_ENABLED=false
```
