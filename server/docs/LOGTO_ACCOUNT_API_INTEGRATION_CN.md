# 账户设置与身份服务集成说明

本文记录 StarDraw 对标准 OIDC Account API 的集成约定，依据 Logto 官方文档：

- [通过 Account Center UI 管理账户](https://docs.logto.io/end-user-flows/account-settings/by-account-center-ui)
- [通过 Account API 管理账户](https://docs.logto.io/end-user-flows/account-settings/by-account-api)

## 官方接口约定

Account API 使用不带业务 `resource` 的 access token，并将其放在 `Authorization: Bearer <token>` 请求头中。非官方 SDK 请求 `/oidc/token` 时，refresh grant 也不能携带业务 resource。

常用接口如下：

- `GET /api/my-account`：读取基本账户资料。
- `PATCH /api/my-account`：更新 `username`、`name`、`avatar`、`customData`。
- `PATCH /api/my-account/profile`：更新 `gender`、`birthdate`、`website` 等扩展资料。
- `POST /api/verifications/password`：验证当前密码并获得短期验证记录。
- `POST /api/my-account/password`：携带 `logto-verification-id` 更新新密码。
- `GET /api/my-account/mfa-verifications`、`GET /api/my-account/sessions`：读取安全状态。

字段权限由身份服务控制台的 Account API 设置决定。对应 scope 至少应覆盖实际使用的 `profile`、`email`、`phone`；读取会话和身份相关数据时还需要相应的 `sessions`、`identities` 权限。

## StarDraw 双 token 方案

StarDraw API 使用带 `VITE_OIDC_RESOURCE` 的 access token，服务端用它验证业务请求。该 token 不直接转发给 Account API。

登录时申请 `offline_access`，浏览器保存 refresh token。访问账户中心时，浏览器使用同一个 refresh token 另取一个不带 resource 的 Account API token，并通过 `X-Identity-Account-Token` 传给 StarDraw 的账户路由。普通业务请求仍只携带 `Authorization`。

旧 session 如果没有 refresh token，会暂时回退到业务 token，因此账户中心可能仍显示权限错误；退出并重新登录即可取得新的 Account API token。

## 配置检查

客户端生产构建需要：

```text
VITE_AUTH_PROVIDER=oidc
VITE_OIDC_ISSUER=https://auth.example.com/oidc
VITE_OIDC_RESOURCE=https://your-api-resource.example.com
VITE_OIDC_SCOPES=openid profile email phone identities urn:logto:scope:sessions offline_access
```

服务端需要：

```text
AUTH_PROVIDER=oidc
OIDC_ISSUER=https://auth.example.com/oidc
OIDC_AUDIENCE=your-api-resource-or-client-id
OIDC_ACCOUNT_API_URL=https://auth.example.com/api
```

不要在日志中记录 access token 或 refresh token。Account API 权限不足不应清除 StarDraw 的业务登录 session。
