# Stardraw MCP OAuth 调研与分层设计

检索日期：2026-08-06

本文只记录 MCP 官方规范、IETF/RFC 和服务提供商官方文档中可以核验的事实，并将其转换为 Stardraw 的设计约束。本文不代表任何第三方服务已经批准 Stardraw 接入。

## 结论摘要

Stardraw 不能实现一个“填写 OAuth 地址就能连接所有 MCP”的万能入口。应采用：

1. MCP 标准授权核心：HTTP/Streamable HTTP、受保护资源元数据发现、授权服务器元数据发现、PKCE、`resource` 资源指示器、issuer 校验、最小 Scope。
2. 服务适配器：每个 MCP 服务单独声明连接方式、OAuth 兼容性、客户端注册方式、Scope、撤销方式、工具限制和外部准入状态。
3. 每用户账号连接：用户自己完成 OAuth；Token 按 `user_id + mcp_server_id + provider_account_id` 隔离，Agent 只能使用当前用户自己的连接。
4. 服务端凭证保管：Access Token/Refresh Token 只在服务端加密保存，绝不进入浏览器 LocalStorage、Agent Prompt、工具参数或日志。
5. 运行时安全：Stardraw 登录、MCP OAuth 连接、Agent 单次工具审批、RBAC/积分检查是四道独立关卡。

## 一、MCP 官方授权规范

### 1. 角色和传输

MCP 的 HTTP 授权规范把受保护 MCP Server 视为 OAuth Resource Server，把 MCP Client 视为 OAuth Client，授权服务器负责和资源所有者交互并签发 Token。授权规范针对 HTTP 传输；STDIO 不应套用这套 HTTP OAuth，而应从环境获取凭证。

来源：

- [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

对 Stardraw 的影响：

- Stardraw 网页 SaaS 的服务端 Worker 是远程 MCP Client/Host，应实现 HTTP/Streamable HTTP；未来 Electron Bridge 的本地 stdio 是另一条适配器，不与远程 OAuth 代码混在一起。
- 用户的 Stardraw 登录 Session 不能当作第三方 MCP Token。

### 2. 发现流程

最新 MCP 规范要求 MCP Server 提供 OAuth 2.0 Protected Resource Metadata（RFC 9728），其中包含 `authorization_servers`。客户端还必须处理 MCP Server 返回的 `401` 和 `WWW-Authenticate` 中的 `resource_metadata`，并在没有该 Header 时尝试规范的 well-known 地址。

随后客户端根据授权服务器 Issuer 发现 OAuth Authorization Server Metadata（RFC 8414）或 OpenID Connect Discovery，并且必须验证发现文档中的 `issuer` 与请求使用的 Issuer 完全一致。

来源：

- [MCP Authorization Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)
- [RFC 9728 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728.html)
- [RFC 8414 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html)

对 Stardraw 的影响：

- 不允许管理员只配置一个任意 `authorization_endpoint` 就直接跳转；先发现、校验并缓存元数据。
- 发现结果要记录服务 URL、Issuer、元数据版本和缓存时间；服务变更时不能复用另一授权服务器签发的 Client ID 或 Token。
- 所有服务端发现请求必须经过 SSRF 防护，生产环境默认只允许 HTTPS。

### 3. 客户端注册

最新规范支持三种客户端注册方式，并建议按以下优先级：

1. 已预注册客户端；
2. OAuth Client ID Metadata Document；
3. Dynamic Client Registration（DCR，RFC 7591，主要作为旧服务兼容方案）；
4. 让管理员手动录入注册信息。

最新规范将 DCR 标记为兼容性方案，新的实现应优先考虑 Client ID Metadata Documents。不同授权服务器的 Client ID 必须按 Issuer 隔离保存，不能跨授权服务器复用。

来源：

- [MCP Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- [RFC 7591 Dynamic Client Registration](https://www.rfc-editor.org/rfc/rfc7591.html)
- [OAuth Client ID Metadata Document draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)

对 Stardraw 的影响：

- 数据模型要支持 `pre_registered`、`client_id_metadata`、`dynamic_registration` 和 `manual` 四种模式。
- Client 凭证和用户 Token 都必须绑定 `issuer` 与 `mcp_server_id`。
- 不能把 DCR 当成无条件安全：若 Stardraw 作为 OAuth 代理，还必须做自己的用户同意和 Redirect URI 校验。

### 4. PKCE、Issuer 和 Resource

OAuth 2.1/安全最佳实践要求授权码流程使用 PKCE，优先使用 `S256`。每次授权事务都要生成新的高熵 verifier/challenge。Stardraw 同时连接多个授权服务器时，必须防御 mix-up attack：记录预期 Issuer，并验证回调中的 `iss`。

MCP 客户端必须使用 RFC 8707 Resource Indicators：`resource` 必须出现在授权请求和 Token 请求中，并且指向当前 MCP Server 的规范 URI。Token 不能拿给另一个 MCP Server 使用。

来源：

- [MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)
- [RFC 8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 9207 Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207.html)
- [RFC 9700 OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)

对 Stardraw 的影响：

- `state`、PKCE verifier、Issuer、Resource、Redirect URI 和当前用户必须绑定同一个短期、一次性 OAuth transaction。
- 回调成功后立即删除 transaction，禁止重复兑换 code。
- 不允许在 URL query、日志、Prompt 或 MCP tool 参数中传递 Access Token。

### 5. Token 生命周期

OAuth 安全最佳实践要求限制 Token 权限和受众；Refresh Token 对公开客户端必须 sender-constrained 或使用 rotation。实际实现中，Stardraw 应支持 Access Token 自动刷新、Refresh Token 原子替换、并发刷新 single-flight、`invalid_grant`/重放时禁用连接并要求重新授权。

撤销由 RFC 7009 定义；具体 MCP 服务可能提供或不提供撤销端点，因此连接删除必须同时标记本地连接 revoked，若服务元数据声明撤销端点则调用它。

来源：

- [RFC 9700 OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)
- [RFC 7009 Token Revocation](https://www.rfc-editor.org/rfc/rfc7009.html)
- [RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html)

## 二、官方服务的兼容性差异

### Figma

Figma 官方文档确认：

- 提供 Remote MCP Server 和 Desktop MCP Server，Remote 是大多数用户推荐的方式；
- 用户通过 Figma OAuth 登录；
- Figma 内容权限继承用户在 Figma 中已有的查看/编辑权限；
- 当前只有 Figma MCP Catalog 中列出的客户端可以连接；新客户端需要加入等待名单；
- 调用次数受 Figma 计划、席位类型和每分钟/每日/月度限制影响；
- Figma 还提供企业管理授权能力，但目前文档说明只对特定客户端和 Okta XAA 场景可用。

来源：

- [Figma MCP Introduction](https://developers.figma.com/docs/figma-mcp-server/)
- [Figma Remote Server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [Figma Rate Limits & Access](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)

对 Stardraw 的影响：

- Figma 不能仅凭 Stardraw 实现标准 OAuth 就承诺上线；必须先确认 Stardraw 是否进入 Figma MCP Catalog。
- Figma 连接需要展示“连接用户、Figma 账号、Scope/工具、Figma 侧限流”状态。
- Figma 的限流不是 Stardraw 积分：两者必须分别记录，Figma 429 要进入重试/暂停状态，不能误记为成功。

### Notion

Notion 官方文档明确提供自定义 MCP Client 指南：

- Remote MCP endpoint 为 `https://mcp.notion.com/mcp`，推荐 Streamable HTTP；
- 同时提供 SSE endpoint 作为兼容方案；
- 支持 OAuth Authorization Code + PKCE、Token refresh 和安全凭证存储；
- 文档提供 Protected Resource Metadata → Authorization Server Metadata 的发现流程；
- Notion MCP 支持 Dynamic Client Registration；
- Workspace owner 可以管理 MCP Client 连接，组织管理员可以通过 Admin API 查看和撤销成员连接。

来源：

- [Notion MCP Overview](https://developers.notion.com/guides/mcp/overview)
- [Notion Build an MCP Client](https://developers.notion.com/guides/mcp/build-mcp-client)
- [Notion Connect to MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)

注意：Notion 页面中的部分 RFC 编号可能滞后于 MCP 最新规范；实现应以 MCP 最新规范与 RFC 9728 为准，同时保留对 Notion 实际 endpoint 的兼容。

### GitHub

GitHub 官方 MCP Server 文档确认：

- Remote endpoint 为 `https://api.githubcopilot.com/mcp/`；
- Remote MCP 支持 OAuth 或 PAT；
- 使用 OAuth 时，每个 MCP Host 需要配置自己的 GitHub App 或 OAuth App；
- 工具集可以按 URL 或 Header 限制，并支持只读工具集；
- 本地 stdio Server 的 OAuth 是另一套 loopback/device-code 流程，官方实现可以把 Token 仅保存在内存中；
- Token Scope 会影响暴露的工具，最小 Scope 会减少工具权限。

来源：

- [GitHub MCP Server README](https://github.com/github/github-mcp-server)
- [GitHub Remote Server](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- [GitHub Local Server OAuth Login](https://github.com/github/github-mcp-server/blob/main/docs/oauth-login.md)

对 Stardraw 的影响：

- 不能把 GitHub PAT 当作通用 MCP OAuth 方案；第一版优先 OAuth，PAT 若将来支持也必须走独立的安全凭证类型。
- 工具集/只读模式可以映射到 Stardraw 的服务端工具白名单和 Agent 审批等级。

## 三、Stardraw 分层设计

目标是替换 Authing、模型供应商、MCP 服务或队列时，核心业务层不被重写。

### Domain 层

只放业务规则和值对象，不导入 Authing SDK、MCP SDK、HTTP 客户端、PostgreSQL 或 Express：

- `UserIdentity`、`Tenant/User`、角色和会员规则；
- `AgentPermissionMode`、`ToolCall`、`ApprovalDecision`；
- `Workflow`、`WorkflowNode`、`WorkflowRun`、`NodeRun`；
- `McpServer`、`McpTool`、`McpConnection` 的状态和值对象；
- `PointReservation`、`UsageCharge`；
- OAuth transaction 的状态机和过期规则。

Domain 只定义“什么状态允许转移”和“什么动作需要审批/扣费”，不定义如何调用外部服务。

### Application 层

编排用例和事务边界：

- `ConnectMcpAccount`、`HandleOAuthCallback`、`RefreshMcpConnection`、`RevokeMcpConnection`；
- `DiscoverMcpAuthorization`；
- `CreateAgentPlan`、`ApproveToolCall`、`ExecuteToolCall`；
- `CreateWorkflowRun`、`RunNextReadyNode`、`RetryNode`、`PauseWorkflow`；
- `ReservePoints`、`SettleUsage`、`ReleaseReservation`；
- `EnqueueJob`、`LeaseJob`、`CompleteJob`。

应用层只依赖端口接口，并通过 Unit of Work/事务接口保证任务、审批、计费和审计的一致性。

### Ports 层

建议定义稳定的接口：

- `IdentityProviderPort`：Authing 只是一个 adapter，未来可以替换为自建 OIDC/其他 IdP；
- `McpOAuthPort`：发现、注册、授权 URL、换 Token、刷新、撤销；
- `McpTransportPort`：initialize、tools/list、tools/call，隐藏 Streamable HTTP/SSE 差异；
- `McpProviderAdapterPort`：Figma/Notion/GitHub 的兼容策略、Scope 和能力限制；
- `CredentialVaultPort`：加密保存和读取用户连接凭证；
- `JobQueuePort`：PostgreSQL 是第一版 adapter，未来 Redis/BullMQ 是替换 adapter；
- `ModelProviderPort`：各图片/视频/Agent 上游适配器；
- `RepositoryPort`：用户、连接、工作流、任务、审计、积分仓储；
- `RealtimeEventPort`：SSE/WebSocket 发布进度；
- `AuditPort`、`RateLimitPort`、`EgressPolicyPort`、`MailerPort`。

### Adapters/Infrastructure 层

- Express route 只做认证、输入校验、调用 Application service 和格式化响应；
- Controller 不直接调用 Provider 或 SQL；
- PostgreSQL repository 负责 SQL 和迁移；
- Authing、图片/视频供应商、MCP SDK、OAuth library、SMTP、OSS、PostgreSQL job worker 都属于 adapter/infrastructure；
- Figma/Notion/GitHub adapter 只实现差异，不污染通用 OAuth 核心。

## 四、建议的数据模型

不保存第三方 Token 明文，建议至少包含：

### `mcp_servers`

保存 root 注册的服务：canonical URL、display name、enabled、approval status、provider adapter key、allowed domains、transport capabilities、OAuth discovery cache、管理员备注。

### `mcp_server_tools`

保存服务端发现/管理员批准的工具：server ID、tool name、description hash、read/write/destructive classification、allowed roles、agent permission policy、point policy、enabled。

### `mcp_connections`

按用户隔离：user ID、MCP server ID、authorization server issuer、provider account ID、encrypted access token、encrypted refresh token、token expiry、granted scopes、resource URI、status、last refresh、revoked time、last error。

唯一约束建议为 `user_id + mcp_server_id + provider_account_id`，不允许不同用户共用连接记录。

### `mcp_oauth_transactions`

短期一次性记录：user ID、server ID、issuer、resource、redirect URI、state hash、加密 PKCE verifier、client registration reference、expires at、used at、failure reason。OAuth code、state、verifier 和 Token 不进入日志。

### `oauth_client_registrations`

按 `issuer + mcp_server_id` 保存 pre-registered/CIMD/DCR 的客户端状态。Client Secret 只保存 Secret reference 或加密密文，不能让普通管理员或用户读取。

## 五、建议的用户授权流程

1. 用户在 Stardraw 的“连接 MCP 服务”页面点击连接；
2. 服务端确认该服务已被 root 注册、启用并通过外部准入；
3. 服务端以 canonical MCP URL 做 Protected Resource Metadata 发现；
4. 校验 HTTPS、Issuer、Redirect、私网 IP、DNS 解析和重定向链；
5. 按 pre-registration → Client ID Metadata Document → DCR → 手动配置的顺序选择客户端注册；
6. 生成一次性 `state` 和 PKCE `S256`，绑定当前用户、服务、Issuer、Resource 和 Redirect URI；
7. 浏览器跳转第三方授权页，用户查看并同意实际 Scope；
8. 回调先验证 state、issuer、redirect、code transaction，再换 Token；
9. 加密保存连接，返回给前端的只有 provider account、Scope、过期时间和连接状态；
10. Agent 调用时根据当前用户和 MCP connection 取凭证，刷新时加行锁/single-flight；
11. MCP 请求只发送 `Authorization: Bearer` 到对应 Resource，不把 Token 转发给其他 API；
12. 用户断开或管理员禁用时停止刷新和调用，并在服务支持时调用撤销端点。

## 六、必须落实的安全约束

- Stardraw 登录、MCP OAuth、Agent 审批、RBAC/积分必须独立验证；
- `Ask for approval` 不能只靠浏览器 confirm，必须服务端签发一次性审批凭证；
- `Full Access` 不能扩大 OAuth Scope，Scope 增加必须重新经过用户授权；
- Redirect URI 精确匹配，禁止通配符和开放跳转；
- `state` 高熵、短期、一次性，并且只在 MCP 自有 consent 通过后创建第三方授权状态；
- 必须校验 `iss`、`resource` 和 Token audience；
- 禁止 Token passthrough；Stardraw Token、MCP Token 和下游供应商 Token 分离；
- 生产 MCP metadata、authorization、token 和 revoke URL 只允许 HTTPS；开发环境的 loopback 必须显式允许；
- 阻止私网、回环、链路本地、云元数据地址；校验每一跳 redirect；防 DNS rebinding；最好经过受控 egress proxy；
- Scope 最小化；工具列表要与 Token Scope 和管理员白名单交集后暴露；
- Refresh Token 加密、轮换、并发 single-flight；`invalid_grant` 或重放时禁用连接；
- 日志禁止写入 code、state、verifier、Access/Refresh Token、Authorization/Cookie；
- 所有 MCP 工具调用记录用户、connection、server、tool、参数摘要、审批、状态、耗时、错误和计费结果；
- SSE resume ID、Session ID、workflow ID 只用于恢复/关联，不能代替身份认证；
- 每个用户的 MCP 连接、授权账号、限流和审计完全隔离。

主要安全来源：

- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- [MCP Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [RFC 9700 OAuth 2.0 Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)
- [RFC 8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 9207 Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207.html)
- [RFC 9728 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728.html)
- [RFC 7009 Token Revocation](https://www.rfc-editor.org/rfc/rfc7009.html)

## 七、针对 Stardraw 的建议决策

第一版不实现用户自定义任意 MCP，也不把 Figma 当作标准 OAuth 成功就必然可用的服务。建议先实现：

1. 通用 OAuth/MCP 端口和服务端加密凭证库；
2. root 注册服务和工具白名单；
3. Notion 作为第一个验证 Streamable HTTP + OAuth + PKCE 的远程 MCP；
4. GitHub 在注册并配置 Stardraw 自有 OAuth App 后接入；
5. Figma 等待 Figma MCP Catalog/客户端准入确认后再开放；
6. 每个 provider adapter 用兼容性状态标记 `supported`、`requires_pre_registration`、`catalog_pending`、`unsupported`，前端据此显示，而不是让用户盲目授权；
7. Electron Bridge 后续只新增 stdio adapter，不重写 OAuth 核心和 Agent 工具策略。

以上是研究结论，不执行任何线上迁移或外部服务授权。MCP OAuth provider 的最终接入名单、Figma 准入和各 provider 的具体 Scope 仍需逐个确认后再实现。
