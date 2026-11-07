# StarDraw 认证平台替代评估

调研日期：2026-09-05  
范围：仅使用认证平台官方文档、官方仓库和 IETF/OAuth 标准规范。价格、套餐和云服务区域可能变化，本文不把当前页面价格视为永久承诺。

## 结论

推荐顺序：

1. **Logto 自托管或 Logto Cloud（先做 PoC）**：最贴合 StarDraw 的 SaaS/OIDC/邮箱密码/RBAC 需求；自托管可以把认证数据和邮件链路放在自己的服务器，邮箱后缀规则通过注册前 Hook 或业务层策略实现。需要先验证中国大陆服务器到 Logto Cloud、邮件服务和回调地址的可用性。
2. **Keycloak 自托管（企业稳健方案）**：协议、用户联邦、迁移和扩展能力最强，适合把身份基础设施完全掌握在服务器上；代价是运维、升级、主题和扩展开发成本明显更高。
3. **Supabase Auth（已有 Supabase 技术栈时才优先）**：邮箱密码和 JWT 很好用，数据库/触发器扩展方便；但“注册邮箱后缀白名单”通常需要 Hook 或业务层实现，且自托管认证不是只启动一个服务即可完成的轻量替换。
4. **ZITADEL 自托管**：OIDC、组织、多租户和自定义 Claim 很强，适合企业/组织模式；部署和概念模型比 StarDraw 当前需要的单应用用户注册更重。
5. **Clerk**：Web SDK 和用户体验优秀，接入速度快；但它是托管服务，数据区域、网络可用性、成本和供应商绑定需要先确认，不适合作为中国大陆生产环境的默认首选。

### 针对 StarDraw 的建议

短期不要直接替换线上 Authing。先做一个独立的认证适配器 PoC，目标是：注册、邮箱验证、密码登录、刷新/退出、OIDC JWT 验签、用户导入、邮箱后缀策略和现有 `root/admin/user` 映射全部跑通。PoC 首选 **Logto 自托管**；如果安全/合规要求是“身份系统必须是成熟的企业级基础设施”，选 **Keycloak**。

无论选择哪家，以下权限不能交给 IdP 的 UI 角色直接决定：积分、生成、模板、Agent 工具审批、支付和管理员审计。IdP 只负责认证身份和提供稳定的 `sub`；StarDraw PostgreSQL 继续保存本地用户、会员、角色、计费和审计关系。这样更换供应商时不会重写核心业务。

## 需求逐项比较

图例：

- **原生**：官方文档明确提供，不需要 StarDraw 自己补核心能力。
- **可实现**：官方提供 Hook/扩展/策略或标准接口，但仍需 StarDraw 配置或编码。
- **需自定义**：不能把它当作现成开关，需要自定义扩展或业务层拦截。

| 能力 | Supabase Auth | Clerk | Logto | ZITADEL | Keycloak / Authentik |
|---|---|---|---|---|---|
| 邮箱密码登录 | 原生 | 原生 | 原生 | 原生 | 原生/流程配置 |
| 邮箱验证 | 原生 | 原生 | 原生 | 原生 | 原生 Required Action/流程 |
| 注册邮箱后缀白名单/黑名单 | 可实现：Before User Created Hook 或服务端注册策略 | 可实现：实例配置/业务拦截；需按套餐和当前官方能力核验 | 可实现：注册体验与 Hook/业务层策略 | 可实现：注册流程/Action 或业务层 | 需自定义：Authenticator/Flow/Policy |
| OIDC/JWT | 原生 | 原生 | 原生 | 原生 | 原生 |
| 用户导入迁移 | 可实现：Admin API/自建导入脚本 | 原生/批量导入能力，按官方限制执行 | 可实现：Management API/导入脚本 | 可实现：管理 API/导入脚本 | 原生/联邦与用户存储迁移能力强 |
| Web SDK | 原生 JS 客户端 | 原生 React/JS 等 | 原生 JS/React 等 | 原生 OIDC/SDK 组合 | 通常用标准 OIDC 客户端库 |
| RBAC/自定义 Claims | 可实现：自有表、JWT Hook/自定义 Claim | 原生角色/权限与 Session Claims | 原生角色/权限与自定义 Claim | 原生组织角色与自定义 Claim | 原生角色映射/Protocol Mapper |
| 中国大陆部署/可用性 | Cloud 区域与网络需实测；可自托管 | 依赖海外托管服务，必须实测 | 可自托管；Cloud 需实测 | 可自托管；Cloud 需实测 | 可自托管，网络和运维由 StarDraw 负责 |
| 主要限制 | 自托管、邮件、Hook、数据库运维 | 托管绑定、区域、套餐和用量 | 自托管运维；部分 Cloud 能力/套餐限制 | 运维复杂度、组织模型和资源开销 | 运维、升级、扩展和初始配置成本 |

上述“价格/套餐”不在表中硬编码：各供应商会按 MAU、功能、邮件、组织、企业支持或部署方式变更。采购前应以官方定价页和目标区域的服务条款为准。

## 一、Supabase Auth

### 官方明确能力

Supabase Auth 支持邮箱密码注册/登录；托管项目默认可以启用邮箱确认，登录前可要求用户完成确认。Supabase 提供 JavaScript 客户端、Auth Admin API 和 JWT 机制。自定义 Access Token Hook 可以在签发 Token 时加入自定义 Claims；Before User Created Hook 可以在用户创建前拒绝请求。

### 邮箱后缀策略

这是 Supabase 的可实现能力，不应描述为一个必然存在的“邮箱域名开关”：在 Before User Created Hook 或 StarDraw 自己的注册 API 中解析邮箱域名，与配置表的 allow/deny 规则比较，拒绝不符合规则的注册。应使用规范化后的域名比较，不接受仅靠前端校验。

### 迁移与风险

可以通过 Admin API/服务端脚本批量创建用户，但密码哈希迁移格式、邮箱确认状态、旧用户 `sub` 映射需要按现有数据逐条验证。直接把 Authing 的 JWT `sub` 当作 Supabase UUID 会破坏 StarDraw 的外键关系，因此应建立 `identity_links(provider, subject, user_id)` 映射并分阶段迁移。

来源：

- [Password-based Auth](https://supabase.com/docs/guides/auth/passwords)
- [Email confirmations](https://supabase.com/docs/guides/auth/auth-email)
- [Before User Created Hook](https://supabase.com/docs/guides/auth/auth-hooks)
- [Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks#custom-access-token-hook)
- [Auth Admin API](https://supabase.com/docs/reference/javascript/auth-admin-createuser)
- [Self-hosting Auth](https://supabase.com/docs/guides/self-hosting/self-hosted-auth)
- [Supabase pricing](https://supabase.com/pricing)

## 二、Clerk

### 官方明确能力

Clerk 提供托管式用户管理、邮箱验证、密码登录、React/Web SDK、Session Token 和 JWT 模板；其用户元数据、组织、角色和权限能力适合快速构建 Web SaaS。后端应使用官方 Backend API/SDK 验证 Session/JWT，而不是信任浏览器传来的用户字段。

### 邮箱后缀策略

Clerk 的邮箱域名 Allowlist/Blocklist 以及组织域名能力要区分使用场景：组织域名通常用于企业组织/邀请/SSO，并不等于“所有普通注册都只允许这些后缀”。StarDraw 需要的是普通注册阶段的硬限制，因此应在启用前用目标实例和套餐实测；没有稳定、明确的注册前策略时，在 StarDraw 服务端再次执行后缀校验。

### 迁移与风险

Clerk 的迁移可以使用官方导入/Backend API 能力，但密码哈希算法、用户导入字段、邮箱验证状态和导入量限制必须以目标实例文档为准。最大风险是托管依赖和区域/网络；一旦前端大量使用 Clerk 专属组件和数据结构，未来迁移到自托管 OIDC 的成本会增加。StarDraw 应仅把 Clerk 放在 `IdentityProviderPort` adapter 内。

来源：

- [Clerk email verification](https://clerk.com/docs/guides/configure/auth-strategies/email-verification)
- [Clerk password authentication](https://clerk.com/docs/guides/configure/auth-strategies/password)
- [Clerk session tokens](https://clerk.com/docs/guides/sessions/session-tokens)
- [Clerk organizations](https://clerk.com/docs/organizations/overview)
- [Clerk user import](https://clerk.com/docs/users/user-import)
- [Clerk React quickstart](https://clerk.com/docs/quickstarts/react)
- [Clerk pricing](https://clerk.com/pricing)

## 三、Logto

### 官方明确能力

Logto 面向 Web 应用提供邮箱注册/登录、邮箱验证、密码策略、OIDC/OAuth、标准 JWT、管理 API、角色/权限和多应用配置；官方同时提供 Cloud 与开源自托管路径。它的产品模型比较接近“一个身份服务负责认证，多应用通过 OIDC 接入”。

### 邮箱后缀策略

Logto 的注册体验、用户注册 Hook/自定义逻辑和管理 API可以支持域名规则，但 StarDraw 仍应在服务端保留最终校验。推荐把规则放入 StarDraw 的 `auth_signup_policies` 表，并在注册前 adapter 中执行；这样管理员修改规则不依赖某个供应商控制台的套餐开关。

### 迁移与风险

Logto 的用户、应用和组织可通过管理 API 操作；密码哈希导入是否能无缝保留，必须按 Authing 导出格式进行 PoC，不能假设所有 IdP 的哈希可互认。若无法迁移密码哈希，应保留 Authing 作为临时身份源，让用户首次登录后设置新密码，或发送一次性重置链接。自托管降低区域和供应商锁定风险，但需要自行维护数据库、升级、备份、邮件和高可用。

来源：

- [Logto email and password sign-in](https://docs.logto.io/experience/username-password-sign-in)
- [Logto email verification](https://docs.logto.io/experience/verify-email)
- [Logto OIDC](https://docs.logto.io/developers/oidc)
- [Logto roles and permissions](https://docs.logto.io/authorization/roles)
- [Logto web SDK](https://docs.logto.io/quick-starts/vanilla-js)
- [Logto Management API](https://openapi.logto.io/)
- [Logto self-hosting](https://docs.logto.io/self-hosting)
- [Logto pricing](https://logto.io/pricing)

## 四、ZITADEL

### 官方明确能力

ZITADEL 是 OIDC/OAuth 身份平台，支持密码、邮箱验证、组织、项目角色、自定义 Claim/Metadata、管理 API 和自托管。其组织模型适合企业客户、成员和多租户隔离，JWT 中的角色/组织信息也可以由资源服务器校验。

### 邮箱后缀策略

ZITADEL 的域名和组织能力主要解决组织域名、登录方式和企业身份场景。StarDraw 的“注册后缀白名单/黑名单”仍建议做成注册流程中的 Action/外层业务策略；不能只配置组织域名就认为普通用户注册已被限制。

### 迁移与风险

管理 API 适合迁移用户和组织，但旧密码哈希兼容性、用户 ID 保留、邮箱验证状态和组织映射必须单独验证。ZITADEL 的组织/项目/角色概念较丰富，若 StarDraw 只需要单租户三角色，会增加理解和运维成本；若将来做团队空间，它的优势会变得明显。

来源：

- [ZITADEL password login](https://zitadel.com/docs/guides/start/quickstart)
- [ZITADEL OIDC](https://zitadel.com/docs/apis/openidoauth)
- [ZITADEL actions and custom claims](https://zitadel.com/docs/guides/integrate/actions/overview)
- [ZITADEL organizations](https://zitadel.com/docs/guides/manage/organizations)
- [ZITADEL user management API](https://zitadel.com/docs/apis/resources/user_service_v2)
- [ZITADEL self-hosting](https://zitadel.com/docs/self-hosting/deploy)
- [ZITADEL pricing](https://zitadel.com/pricing)

## 五、Keycloak 与 Authentik 自建

### Keycloak

Keycloak 是成熟的开源身份与访问管理服务器，原生支持 OIDC、OAuth 2.0、SAML、用户联邦、LDAP、角色、Group、Protocol Mapper、Required Action（包括验证邮箱）以及管理 API。普通注册邮箱后缀限制通常要通过自定义 Authenticator、事件监听器或注册入口业务校验来实现；Realm 的邮件验证配置本身不会自动成为后缀白名单。

Keycloak 的优势是标准化、可控、迁移和企业集成能力强；缺点是 Java 服务资源占用、Realm/Client/Role 配置复杂、升级和扩展维护都由 StarDraw 负责。对于公网生产，必须把管理控制台、数据库备份、密钥轮换、集群会话和邮件可靠性纳入运维。

来源：

- [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/)
- [Keycloak securing applications with OpenID Connect](https://www.keycloak.org/securing-apps/oidc-layers)
- [Keycloak user profile](https://www.keycloak.org/docs/latest/server_admin/#user-profile)
- [Keycloak required actions](https://www.keycloak.org/docs/latest/server_admin/#_required-actions)
- [Keycloak protocol mappers](https://www.keycloak.org/docs/latest/server_admin/#_protocol-mappers)
- [Keycloak user storage federation](https://www.keycloak.org/docs/latest/server_admin/#_user-storage-federation)
- [Keycloak source repository](https://github.com/keycloak/keycloak)

### Authentik

Authentik 是开源身份平台，使用 Flows、Policies、Stages、Outposts、OIDC Provider 和用户目录构建登录流程。邮箱验证、密码登录和条件策略可以组合实现；邮箱后缀限制一般需要把条件策略放进注册 Flow，而不是仅靠前端。它适合偏运维/基础设施型 SSO，但 StarDraw 需要自行评估其用户导入、密码哈希兼容、升级和高并发生产经验。

来源：

- [Authentik Password stage](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/password/)
- [Authentik email verification](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/email/)
- [Authentik policies](https://docs.goauthentik.io/add-secure-apps/flows-stages/flow-policies/)
- [Authentik OAuth2/OIDC provider](https://docs.goauthentik.io/add-secure-apps/providers/proxy/)
- [Authentik source repository](https://github.com/goauthentik/authentik)

## 迁移设计与风险

### 不变的核心契约

建议保持以下端口和内部字段稳定：

```text
IdentityProviderPort
  verifyAccessToken(token) -> { subject, email, emailVerified, claims }
  getAuthorizationUrl(transaction) -> url
  exchangeCode(transaction, code) -> identity
  refresh(refreshToken) -> identity
  revoke(refreshToken) -> void
  importUser(input) -> identity
```

数据库不要把 Authing 字段名扩散到业务表。保留：

- `users.id`：StarDraw 内部用户 ID；
- `identity_links.provider + subject + user_id`：供应商与本地账号映射；
- `users.email`、`email_verified_at`：业务快照，不作为 JWT 唯一身份；
- `user_roles`：继续由 StarDraw 管理 `root/admin/user`；
- `auth_valid_after`/会话撤销字段：继续由 StarDraw 控制封禁、角色变更后的旧会话失效。

### 推荐迁移顺序

1. 只读盘点 Authing 用户、邮箱验证状态、重复邮箱、禁用状态和现有 `sub` 引用；不删除旧用户。
2. 增加新 adapter 和 `identity_links` 映射，先用新平台创建一个隔离的测试应用。
3. 配置服务端邮箱后缀 allow/deny 规则，前端只做提示，服务端做最终拒绝。
4. 用测试用户验证 OIDC discovery、JWKS 轮换、issuer/audience 校验、邮箱验证、密码重置、退出登录和过期 Token。
5. 导入用户资料。能迁移密码哈希则保留密码；不能迁移则采用首次登录绑定或强制重置，不在数据库保存明文密码。
6. 双读/灰度验证本地角色、会员、积分、模板、Agent 和支付回调，不让 IdP 角色直接覆盖 StarDraw 角色。
7. 保留 Authing 回滚窗口，确认新平台登录、刷新、退出和账号关联稳定后再切换默认 issuer。
8. 最后再下线 Authing 应用；下线前保留审计、映射和可恢复备份。

### 关键风险

- **密码哈希不可迁移**：最常见的切换阻塞点。必须先拿脱敏的哈希格式做兼容性验证。
- **subject 变化**：新平台通常不会复用 Authing `sub`；不做映射会造成新账号、会员/积分丢失或越权风险。
- **邮箱未验证状态变化**：不能把“用户存在”当作“邮箱已验证”，否则会绕过注册和找回密码策略。
- **JWT 验签误配**：必须校验 `iss`、`aud`、签名算法、JWKS、过期时间和必要 Claim，并支持密钥轮换。
- **后缀限制只做在前端**：攻击者可直接调用注册接口绕过；规则必须在服务端或 IdP 注册前策略执行。
- **中国大陆可用性**：自托管不等于自动合规或自动可达，仍需实测 DNS、TLS、邮件投递、回调、备份、备案和跨境依赖；云厂商区域、条款和数据驻留需由运营方确认。
- **SDK 锁定**：避免在业务页面大量使用供应商专属用户对象、组件和 hooks；统一放在 adapter、AuthContext 和少量页面边界内。

## 最小 PoC 验收清单

- 允许的邮箱后缀注册成功；禁止后缀由服务端拒绝；大小写、空格和国际化域名规则明确。
- 未验证邮箱不能进入 StarDraw 受保护功能；验证链接过期、重复使用和重放均正确处理。
- 密码登录、密码重置、退出、刷新和旧 Token 失效行为正确。
- JWKS 轮换后仍可验签；错误 `iss`、`aud`、签名和过期 Token 均拒绝。
- Authing 账号映射到同一个 StarDraw `user_id`，原会员、积分、模板、历史记录不变。
- `user/admin/root` 本地权限不因 IdP 普通 Claim 被越权覆盖；root 仍由 StarDraw 固定配置绑定。
- 管理员修改邮箱后缀规则立即影响新注册，不能影响现有已验证用户，除非另有明确封禁流程。
- 日志、审计、邮件和密码重置链接不泄露 Token、密码、client secret 或完整邀请凭证。

## 最终建议

若首要问题是“Authing 不能方便地限制邮箱后缀、且希望网页 SaaS 易于维护”，先选 **Logto 自托管 PoC**。它保留标准 OIDC/JWT，Web 接入直观，又能把认证部署、邮件和网络可用性掌握在 StarDraw 的基础设施内。若 PoC 发现用户导入/密码哈希、邮件或高可用运维成本不合适，第二选择是 **Keycloak 自托管**，它更重但标准和扩展边界最稳。

不建议当前直接选 Clerk 作为中国大陆公网生产的默认身份源，也不建议为了邮箱后缀这个单一需求立刻迁移到 Supabase 或 ZITADEL。Supabase 适合已有 Supabase 数据平台的团队；ZITADEL 适合明确需要组织/企业多租户的下一阶段。无论最终选谁，先完成隔离 PoC 和可回滚迁移，不能在生产环境直接替换 issuer 或删除 Authing 用户。
