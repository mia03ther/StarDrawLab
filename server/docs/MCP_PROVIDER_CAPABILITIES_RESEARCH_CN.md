# Notion、GitHub、Figma MCP/OAuth 能力核对

核对日期：2026-08-06（Asia/Shanghai）  
范围：仅核对 provider 官方文档、官方仓库、MCP 官方规范，以及 provider 当前公开的 OAuth 元数据；未执行授权、客户端注册、Token 兑换或任何写入操作。

## 结论摘要

1. MCP 的 OAuth 规范适用于 HTTP 传输。MCP 客户端应通过 Protected Resource Metadata（RFC 9728）发现授权服务器，再通过 Authorization Server Metadata（RFC 8414）取得端点；必须使用 PKCE 和 `resource` 参数。STDIO 不应套用这套 HTTP OAuth 流程，而应从环境获取凭证。
2. DCR 不是所有 provider 的共同能力：Notion 明确支持；Figma 的授权服务器元数据发布了注册端点；GitHub 的 MCP Resource Metadata/授权服务器元数据没有发布注册端点，且 GitHub 官方接入流程要求 MCP Host 自行配置 GitHub App 或 OAuth App，应按“预注册/手工配置”处理。
3. Scope 没有通用的 `read`/`write` 约定。Notion 使用单一的 `default`；Figma 使用 `mcp:connect`；GitHub 公开一组 GitHub OAuth scopes，工具还会按所需 scope 过滤。Stardraw 不应跨 provider 复用 Scope allowlist。
4. 三者的远程 MCP 都应按独立 provider adapter 处理：Notion 同时有 Streamable HTTP 和旧式 SSE 兼容端点；Figma 远程端点是 Streamable HTTP；GitHub 远程端点为 HTTP/Streamable HTTP 风格，官方没有把远程 SSE 作为接入方式记录。

## MCP/OAuth 通用基线

### 授权发现与端点

MCP HTTP 授权规范规定：MCP Server 是 OAuth Resource Server，MCP Client 是 OAuth Client。客户端先处理 MCP Server 的 `401`/`WWW-Authenticate` 中的 `resource_metadata`，或访问 RFC 9728 Protected Resource Metadata；然后读取授权服务器的 RFC 8414 metadata。授权服务器可以与 MCP Server 同域，也可以是不同域。

来源：

- [MCP Authorization（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP Authorization Server Discovery](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#authorization-server-discovery)
- [RFC 9728：OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728.html)
- [RFC 8414：OAuth 2.0 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html)

### DCR、PKCE、Scope 与 Resource

MCP 规范将 RFC 7591 Dynamic Client Registration 定义为应支持的互操作能力（`SHOULD`，不是每个授权服务器都必须提供）。不支持 DCR 的授权服务器需要提供预注册 Client ID/凭证，或让用户/管理员手工录入。

客户端必须在授权请求和 Token 请求中都发送 RFC 8707 的 `resource`，且指向当前 MCP Server 的规范 URI；Token 请求必须使用 `Authorization: Bearer` 访问 MCP Server，不能把 Access Token 放在 URL query 中。授权码流程必须使用 PKCE；`S256` 是 Stardraw 的默认选择。

来源：

- [MCP Authorization：Dynamic Client Registration](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#dynamic-client-registration)
- [MCP Authorization：Resource Parameter Implementation](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#resource-parameter-implementation)
- [MCP Authorization：Authorization Code Protection](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#authorization-code-protection)
- [RFC 7591：Dynamic Client Registration Protocol](https://www.rfc-editor.org/rfc/rfc7591.html)
- [RFC 7636：PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)
- [RFC 8707：Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707.html)

### MCP 传输边界

当前 MCP 标准传输是 `stdio` 和 Streamable HTTP。HTTP 授权规范只覆盖 HTTP-based transports；规范明确建议 STDIO 不采用这套授权流程，而从环境获取凭证。Streamable HTTP 使用一个 MCP endpoint，客户端用 HTTP POST 发送 JSON-RPC，并应同时声明 `application/json` 与 `text/event-stream`；provider 是否另行提供 `/sse` 端点属于 provider-specific 能力，不等同于 MCP 通用要求。

来源：

- [MCP Transports（2025-06-18）](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Authorization：Purpose and Scope](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#purpose-and-scope)

## Provider 能力矩阵

| Provider | 远程 MCP 传输与 URL | 授权服务器 / Authorization Endpoint / Token Endpoint | Scope | DCR | provider-specific 限制 |
|---|---|---|---|---|---|
| Notion | Streamable HTTP（推荐）：`https://mcp.notion.com/mcp`；SSE 兼容：`https://mcp.notion.com/sse` | Issuer：`https://mcp.notion.com`；`https://mcp.notion.com/authorize`；`https://mcp.notion.com/token` | 实时 metadata 仅声明 `default` | 支持。官方自定义 Client 指南明确使用 RFC 7591；metadata 也发布 `https://mcp.notion.com/register` | 工作区和用户可访问内容决定实际权限；部分工具受 Notion AI/套餐限制；用户速率约 180 req/min、Search 约 30 req/min，且有工作区共享限制 |
| Figma | Streamable HTTP：`https://mcp.figma.com/mcp`；官方 `server.json` 也将 remote 类型声明为 `streamable-http` | Issuer：`https://api.figma.com`；`https://www.figma.com/oauth/mcp`；`https://api.figma.com/v1/oauth/token` | `mcp:connect` | 支持迹象明确：授权服务器 metadata 发布 `https://api.figma.com/v1/oauth/mcp/register`；上线前仍应以注册响应和 Figma 侧政策为准 | 只有 Figma MCP Catalog 中列出的客户端可连接，新客户端需 waitlist；权限继承 Figma 用户已有的查看/编辑权；访问受 plan/seat 和读工具限流影响；部分写入/生成工具为 remote-only 或只对特定客户端开放 |
| GitHub Remote MCP | `https://api.githubcopilot.com/mcp/`；官方 Remote Server 文档提供 `/readonly`、`/x/{toolset}` 等 URL 变体和等价 Header | Resource Metadata 指向 Issuer：`https://github.com/login/oauth`；授权：`https://github.com/login/oauth/authorize`；Token：`https://github.com/login/oauth/access_token` | Resource Metadata 声明：`repo`、`read:org`、`read:user`、`user:email`、`read:packages`、`write:packages`、`read:project`、`project`、`gist`、`notifications`、`workflow`、`codespace` | 未发现 DCR：Resource Metadata 没有 `registration_endpoint`，GitHub OAuth AS metadata 也没有；官方 Remote MCP README 要求每个 Host 自行配置 GitHub App 或 OAuth App | OAuth/PAT 是两条不同凭证路径；OAuth App 使用 scopes，GitHub App 使用更细粒度 permissions；工具按所需 OAuth scope 暴露/过滤；GitHub MCP Server 的只读模式、toolset、tool allowlist 和 insiders 是 server 配置，不是 OAuth Scope |

矩阵中的实时 metadata 来源：

- [Notion Protected Resource Metadata](https://mcp.notion.com/.well-known/oauth-protected-resource)
- [Notion Authorization Server Metadata](https://mcp.notion.com/.well-known/oauth-authorization-server)
- [Figma Protected Resource Metadata](https://mcp.figma.com/.well-known/oauth-protected-resource)
- [Figma Authorization Server Metadata](https://mcp.figma.com/.well-known/oauth-authorization-server)
- [GitHub MCP Protected Resource Metadata](https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/)
- [GitHub OAuth/OpenID Discovery（Issuer 下的官方 metadata）](https://github.com/login/oauth/.well-known/openid-configuration)

> 备注：GitHub 的 discovery 文档是 GitHub 当前公开的 Issuer metadata，主要声明 `openid`；MCP Resource Metadata 另外声明 GitHub MCP 所需的 OAuth scopes。不要把 `openid` 当成 GitHub MCP 的完整工具权限，也不要因为 GitHub 未发布 DCR endpoint 就把 GitHub OAuth App 当成 MCP 通用注册服务。

## Provider 细节与接入限制

### Notion

- 官方自定义 Client 指南要求 Authorization Code + PKCE、Token refresh 和安全凭证存储；并建议 Streamable HTTP 失败时回退到 SSE。
- OAuth 成功的 authorization-code exchange 会返回 Notion `user_id`、`workspace_id` 和 `email_domain`，可用于绑定 Stardraw 连接身份；refresh 响应不重复返回这些字段，应保存初次兑换结果。
- `scope=default` 不代表所有工作区工具都无条件可用。官方工具文档提供 `current_tool_access`，状态可能是 `available`、`available_with_limit`、`upgrade_required` 或 `not_enabled`。
- workspace owner 可在 Settings → Connections 管理 MCP Client；organization owner 可通过 Admin API 列出和撤销成员连接。连接删除在 Stardraw 侧仍需本地撤销并清理凭证。

来源：

- [Build an MCP client for Notion](https://developers.notion.com/guides/mcp/build-mcp-client)
- [Notion MCP 概览](https://developers.notion.com/guides/mcp/overview)
- [Supported tools / 工具可用性与限流](https://developers.notion.com/guides/mcp/mcp-supported-tools)
- [Notion MCP Admin API：List connections](https://developers.notion.com/reference/admin/list-mcp-client-connections)
- [Notion MCP Admin API：Revoke connection](https://developers.notion.com/reference/admin/revoke-mcp-client-connection)

### Figma

- 远程安装指南要求用户通过 Figma OAuth 登录；但官方限定只有 MCP Catalog 列出的客户端可以连接。Stardraw 具备通用 OAuth/MCP 能力，不等于已经获得 Figma Catalog 准入。
- 当前元数据声明 `code_challenge_methods_supported=["S256"]`、`token_endpoint_auth_methods_supported=["client_secret_basic","client_secret_post"]` 和 `require_state_parameter=true`。因此 adapter 不应假设 Figma 接受无 Client Secret 的 public-client 注册，也必须发送并校验 `state`，PKCE 仅使用 S256。
- 远程服务支持写入画布；官方工具页将 `use_figma`、`create_new_file`、`upload_assets` 等标为 remote-only。文件操作仍受用户对文件的查看/编辑权限约束。
- 官方列出的访问控制包含 plan/seat、每分钟以及每日/月度工具调用限制；部分写入工具不计入读取限流。Figma 还说明企业托管授权目前只支持 Claude + Okta Cross App Access（XAA），不能作为 Stardraw 的通用企业 OAuth 假设。

来源：

- [Figma MCP Server Introduction](https://developers.figma.com/docs/figma-mcp-server/)
- [Set up the remote server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
- [Figma official MCP server guide repository](https://github.com/figma/mcp-server-guide)
- [Figma official server.json](https://raw.githubusercontent.com/figma/mcp-server-guide/main/server.json)
- [Figma Tools and prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- [Figma Rate limits & access](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)

### GitHub

- 官方 Remote Server 文档的远程 endpoint 是 `https://api.githubcopilot.com/mcp/`，支持通过 URL path 或 Header 选择 toolset、单独开启只读模式（`/readonly` 或 `X-MCP-Readonly`），还支持 `X-MCP-Tools` 精确选择工具。
- 官方 README 明确：每个 MCP Host 都需要配置自己的 GitHub App 或 OAuth App 才能通过 OAuth 访问 Remote Server；PAT 是替代路径。远程 OAuth 的 Client 注册不是由 MCP Server 自动完成的，Host/provider 的配置流程是接入前置条件。
- 官方 GitHub MCP Server 本地 OAuth 文档只适用于 `stdio`；它使用 loopback authorization-code + PKCE，容器/无浏览器场景可回退 device-code。这个本地流程不能直接推导为 Stardraw 远程 HTTP OAuth 的流程。
- 官方 README 的工具列表带有 Required OAuth Scopes；本地 server 的 `--oauth-scopes` 会同时缩小 Token grant 和暴露的工具。远程 server 的 URL/Header toolset 过滤与 OAuth scopes 是两层独立的限制，Stardraw 应分别建模。
- GitHub Enterprise Server 不支持远程 server hosting；`ghe.com`/GitHub Enterprise 场景需要按官方说明使用对应 host 的自有 app/endpoint，不能硬编码 github.com 的 Issuer。

来源：

- [GitHub MCP Server README（Remote Server、OAuth/PAT、工具所需 scopes）](https://github.com/github/github-mcp-server)
- [GitHub MCP Remote Server 文档](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- [GitHub MCP Local OAuth Login（官方仓库）](https://github.com/github/github-mcp-server/blob/main/docs/oauth-login.md)
- [GitHub 官方 OAuth：创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [GitHub 官方 OAuth：授权 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub 官方 OAuth Scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)

## 对 Stardraw adapter 的直接约束

建议 provider 配置至少保存以下字段，并按 provider 校验，而不是只保存一个通用 `authorization_endpoint`：

| 字段 | Notion | Figma | GitHub Remote |
|---|---|---|---|
| canonical resource | `https://mcp.notion.com`（以 metadata 为准） | `https://mcp.figma.com/mcp` | `https://api.githubcopilot.com/mcp/` |
| authorization server issuer | `https://mcp.notion.com` | `https://api.figma.com` | `https://github.com/login/oauth` |
| registration mode | DCR；另支持 Client ID Metadata Document | DCR endpoint；需 client auth | pre-registered/manual app；无 DCR endpoint |
| allowed scopes | 精确 `default` | 精确 `mcp:connect` | 仅从 GitHub metadata/工具要求中选择；不要用 Notion/Figma scope |
| transport | Streamable HTTP，SSE fallback | Streamable HTTP | Remote HTTP/Streamable HTTP；本地 stdio 另行适配 |
| 限制状态 | workspace/tool plan、用户/工作区限流 | Catalog、plan/seat、权限和限流 | Host app、OAuth App vs GitHub App、toolset/read-only、GitHub 账号权限 |

实现时应保留以下安全边界：

- 按 `issuer + canonical resource + provider` 隔离 Client ID、Scope 和 Token；不能跨 provider 复用。
- 授权交易绑定 `state`、PKCE verifier、issuer、resource、redirect URI 和当前 Stardraw 用户，并在 callback 成功后一次性消费。
- Access Token 只放 `Authorization: Bearer`，不进入 URL、日志、Prompt 或工具参数；第三方 Token 不应被当作另一个 MCP Server 的 Token 透传。
- Figma 的 `mcp:connect`、Notion 的 `default`、GitHub 的 OAuth scopes 都只描述 provider 授权边界，不能替代 Stardraw 自己的 RBAC、工具白名单、审批和计费。
- 远程 endpoint、OAuth discovery 和 callback 的 HTTPS/SSRF/redirect URI 校验属于 Stardraw 自身安全责任；provider 的 DCR 能力不等于可以无条件接受任意客户端注册。

