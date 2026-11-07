# Authing、Brevo 与首个 root 配置说明

本文只说明配置步骤，不执行账号删除、Authing 写操作或生产部署。真实密码、SMTP key、
JWT 和主密钥不要发到聊天，也不要提交 Git。

## 1. 获取 `ROOT_ADMIN_USER_ID`

StarDraw 使用 Authing OIDC Token 的 `sub` 作为用户 ID，后端不会使用用户名或邮箱作为
root 身份。最稳妥的获取方式是：

1. 登录 Authing 控制台：<https://console.authing.cn/>。
2. 打开 StarDraw 对应的用户池/应用，在用户管理中搜索刚注册并完成邮箱验证的邮箱。
3. 打开该用户详情，复制用户详情中的 **User ID/用户 ID**，不要复制用户名、昵称或邮箱。
4. 在服务器 `server/.env` 填写：

   ```dotenv
   ROOT_ADMIN_USER_ID=Authing用户详情中的User_ID
   ```

也可以在登录后检查 OIDC ID Token 的 `sub`，但应只在本机解码，不要把 Token 上传到 jwt.io、
聊天或第三方网站。Authing 的 OIDC 文档入口：<https://docs.authing.cn/>。

StarDraw 启动时会把这个 ID 固定为唯一 root；如果数据库里已经存在另一个 root，启动会
失败，而不是自动覆盖。设置 root 后要重新登录一次，因为 root 初始化会刷新
`auth_valid_after`，旧 Token 会被视为已撤销。管理员和 root 的平台访问只需要有效登录和
数据库角色，不需要额外开通 Authing MFA。

## 2. Authing 注册与邮箱验证

当前前端只调用 Authing 托管登录页的 `loginWithRedirect()`，因此注册入口和邮箱验证策略
应在 Authing 应用/用户池配置中设置：

1. 开启邮箱注册或邮箱密码登录方式。
2. 开启注册后必须验证邮箱，未验证用户不能完成登录或不能获得有效登录会话。
3. 如果产品只允许邮箱账号，关闭用户名注册/用户名登录，避免用户继续创建无邮箱账号。
4. 配置 Authing 的邮件服务和发件人。若使用自定义 SMTP，Brevo 需要在 Authing 控制台
   另外配置一次；StarDraw 的 `SMTP_*` 变量不会改变 Authing 的验证码邮件。
5. 使用 root 账号完成一次真实登录测试，并确认其数据库角色为 `root`。

配置完成后，用新邮箱注册、点击验证邮件，再从 Authing 用户详情复制 User ID。

服务端还支持强制校验已签名访问令牌中的邮箱验证状态：

```env
AUTH_REQUIRE_VERIFIED_EMAIL=true
```

启用前先在浏览器登录后检查 Authing 访问令牌是否包含非空 `email`，以及
`email_verified=true`（部分 Authing 配置使用 `emailVerified=true`）。若 claim 尚未加入
Token，请先在 Authing 的 OIDC scope/Token 自定义配置中加入邮箱相关 claim；否则启用后
所有账号都会收到 `EMAIL_VERIFICATION_REQUIRED`，这是服务端的故障关闭行为。

## 3. Brevo 给 StarDraw 发邮件

Brevo 官方 SMTP Relay 主机为 `smtp-relay.brevo.com`。在 Brevo 控制台创建并验证发件人，
然后在 SMTP/API 设置中生成 **SMTP key**。`SMTP_PASSWORD` 填 SMTP key，不填 Brevo 登录
密码，也不填 API key。

推荐使用 587 + STARTTLS：

```dotenv
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=Brevo显示的SMTP登录名
SMTP_PASSWORD=Brevo生成的SMTP key
SMTP_FROM=StarDraw <Brevo中已经验证的发件人邮箱>
OPERATIONAL_ALERT_EMAILS=root@example.com,admin@example.com
APP_TIMEZONE=Asia/Shanghai
```

也可以使用 465：

```dotenv
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=465
SMTP_SECURE=true
```

发件人地址必须是 Brevo 已验证的 Sender，或者属于已经验证的域名。否则 Brevo 可能拒绝
投递或改写发件人。StarDraw 的 SMTP 适配器将 `SMTP_USER` 和 `SMTP_PASSWORD` 作为普通
SMTP AUTH 凭证传给 Nodemailer；实现见 `server/infrastructure/smtpEmailAdapter.js`。

官方入口：

- Brevo SMTP Relay 文档：<https://developers.brevo.com/docs/using-brevos-smtp-relay>
- Brevo 官方帮助中心：<https://help.brevo.com/>
- Authing 官方控制台：<https://console.authing.cn/>
- Authing 官方文档：<https://docs.authing.cn/>

## 4. 生成 `MCP_CREDENTIAL_MASTER_KEY`

在服务器终端执行以下命令，推荐使用 64 位 hex：

```bash
openssl rand -hex 32
```

把终端输出写入服务器 `server/.env`：

```dotenv
MCP_CREDENTIAL_MASTER_KEY=这里粘贴64位hex结果
MCP_OAUTH_REDIRECT_URI=https://你的域名/api/public/mcp/oauth/callback
MCP_OAUTH_SUCCESS_REDIRECT=https://你的域名/ai/account
MCP_OAUTH_ERROR_REDIRECT=https://你的域名/ai/account
```

该值必须是准确 32 字节，代码接受 64 位 hex 或 32 字节 base64。只生成一次并备份到服务端
Secret 管理处；MCP OAuth 凭证写入数据库后不要随意更换，否则已有 AES-256-GCM 密文无法
解密，用户需要重新授权。

## 5. 不删除旧用户

当前 StarDraw 已明确禁用账户删除接口，只允许删除单个内容。原因是用户 ID 会出现在
`user_profiles`、积分账本、订单、订阅、生成记录、私有模板、MCP 连接和审计数据中。
仅删除 Authing 身份会留下孤儿数据；删除数据库用户记录则可能破坏归属和审计链。

推荐流程是：

1. 新邮箱注册并完成邮箱验证；
2. 设置 `ROOT_ADMIN_USER_ID`；
3. 完成迁移和新版服务启动；
4. root 登录后将旧测试账号逐个暂停/封禁，保留其内容归属和审计记录；
5. 如确实需要彻底清理测试数据，另行制作明确账号清单、备份和归属迁移方案，不能批量
   删除所有用户。
