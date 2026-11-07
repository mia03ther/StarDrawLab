# MCP 运行时配置说明

当前实现只支持服务端 HTTP/Streamable HTTP MCP。不会读取用户自定义的任意 MCP 地址：root 先登记服务，管理员再启用具体工具，用户从自己的 OAuth 账号授权连接。

## 1. 服务端密钥和回调

在服务端 Secret 中配置：

```dotenv
MCP_CREDENTIAL_MASTER_KEY=<openssl rand -base64 32 的结果>
MCP_OAUTH_REDIRECT_URI=https://你的域名/api/public/mcp/oauth/callback
MCP_OAUTH_SUCCESS_REDIRECT=https://你的域名/ai/account
MCP_OAUTH_ERROR_REDIRECT=https://你的域名/ai/account
```

`MCP_CREDENTIAL_MASTER_KEY` 必须是准确 32 字节的 base64 或 64 位 hex 值。它不能写进 PostgreSQL、前端构建变量或 Git。数据库只保存 AES-256-GCM 密文。

回调地址必须在第三方 MCP/OAuth 应用后台登记，并与环境变量完全一致。修改回调域名后要同时更新第三方应用登记值。

可选的传输限制：

```dotenv
MCP_PROTOCOL_VERSION=2025-06-18
MCP_HTTP_TIMEOUT_MS=15000
MCP_MAX_RESPONSE_BYTES=524288
```

## 2. root 登记 MCP 服务

root 登录后调用。先查看 provider 能力矩阵：

```text
GET /api/root/mcp/providers
```

Notion 当前支持 Streamable HTTP（官方也保留 SSE 兼容端点），默认 OAuth scope 为
`default`；GitHub Remote MCP 当前按预注册/手工配置处理，不允许使用动态客户端注册；Figma
使用 `mcp:connect`，但当前仍为 `catalog_pending`，不能启用。详细的一手来源见
`server/docs/MCP_PROVIDER_CAPABILITIES_RESEARCH_CN.md`。

root 登录后调用：

```text
POST /api/root/mcp/servers
```

必须提供 `serverKey`、`displayName`、`canonicalUrl`、`providerAdapter`。provider adapter 白名单为 `notion`、`github`、`figma`，transport 数据字段保留 `streamable_http` 和 `sse`；当前版本只允许启用 `streamable_http`，SSE 为后续适配器预留。

生产环境只接受 HTTPS，并且会在 DNS 解析后再次拦截回环、私网、链路本地、保留和多播地址。`allowedDomains` 为空时自动使用 canonical URL 的主机名。

Figma 会被强制保存为 `catalog_pending` 且不能启用，等待外部客户端准入确认后再增加专门的开关。

root 配置 OAuth client：

```text
POST /api/root/mcp/servers/:serverKey/oauth-clients
```

请求体包含 `issuer`、`clientId`、`registrationMode`（可用值由 provider capability 决定），以及可选的 `clientSecret` 和 `metadata`。Notion 可使用 DCR/Client ID Metadata；GitHub 必须使用预注册或手工模式；Figma 虽有官方注册元数据，但在 StarDraw 完成 Catalog 准入前仍不能启用。client secret 只在服务端加密后落库，响应不会返回密文或明文。

## 3. 管理员启用工具

管理员或 root 登录后先查看服务：

```text
GET /api/admin/mcp/servers
GET /api/admin/mcp/servers/:serverKey/tools
```

然后通过以下接口登记/更新工具白名单：

```text
PUT /api/admin/mcp/servers/:serverKey/tools/:toolName
```

工具只有 `enabled=true`、所属 MCP server 也处于 `status=enabled` 且 `enabled=true` 时才可以被调用。管理员还可以设置操作类别、允许的用户角色、输入 schema 和 `approvalPolicy`。这些工具仍然受 Agent 的 Ask for approval / Approve for me / Full Access 策略约束。

## 4. 用户连接和 Agent 调用

登录用户可使用：

```text
GET  /api/mcp/servers
GET  /api/mcp/connections
POST /api/mcp/connections/start
GET  /api/mcp/connections/:connectionId/tools
POST /api/mcp/connections/:connectionId/revoke
```

OAuth callback 是公开路由，但不依赖登录态；一次性 state 在 PostgreSQL 中绑定用户、server、issuer、redirect URI 和 PKCE verifier，因此回调不会因浏览器跨站跳转而失去用户绑定。

Agent 调用 `mcp.call.external` 时只提交 `connectionId`、工具名和参数。服务端忽略客户端提供的 endpoint/token，从当前用户的连接记录读取并解密 token，校验工具白名单后才向该 MCP server 发起请求。参数只保存 SHA-256 摘要，不保存原文。

root 可查看调用审计：

```text
GET /api/root/mcp/audit
```

普通管理员和用户不能查看这份调用审计。

## 5. 上线顺序

迁移 `028_mcp_runtime.sql` 必须在维护窗口人工审阅并执行；应用不会自动执行迁移。确认数据库结构完成、Secret 已配置、root 登记并启用 Notion/GitHub、管理员至少启用一个工具后，再安排 MCP 功能开关和回归验收。当前开发验证没有连接真实数据库，也没有向外部 MCP 发起请求。
