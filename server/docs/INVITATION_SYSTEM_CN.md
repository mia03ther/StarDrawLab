# 邀请系统

邀请功能由数据库迁移 `056_invitation_system.sql` 提供。个人邀请码和通用邀请码都只保存邀请码本身及状态，奖励入账复用 `point_lots` 与 `point_ledger`。

## 用户流程

1. 用户进入 `/ai/invitations`，点击生成个人邀请链接并复制分享。
2. 新用户打开 `/invite?code=...`，页面先保存邀请码，再引导 Authing 登录或注册。
3. 登录完成后回到 `/invite`，服务端在一个事务中校验邀请码、校验该账号是否已经领取过奖励，并给双方分别入账。
4. 同一账号只能成功领取一次；重复请求不会重复增加积分。重新生成个人链接只会撤销旧链接，不影响已完成的邀请。

通用链接不绑定邀请人，因此只发放新用户奖励。管理员可以在 `/ai/admin/invitations` 配置奖励积分、有效期和启用状态，也可以生成、撤销、重新生成通用链接。

迁移首次安装时默认关闭且双方奖励均为 0；管理员配置并保存规则后，邀请奖励才会生效。

有效期填 `0` 表示奖励永不过期。其他正整数表示奖励批次的有效天数；过期时间写入积分批次，和会员月赠积分一样由积分服务统一处理。

## API

- `GET /api/invitations/me`：当前用户的个人链接和邀请统计。
- `POST /api/invitations/regenerate`：生成或重新生成个人链接。
- `POST /api/invitations/claim`：当前登录用户领取邀请码奖励。
- `GET/PUT /api/admin/invitations/settings`：管理员读取或更新规则。
- `GET /api/admin/invitations/common-links`：管理员查看通用链接。
- `POST /api/admin/invitations/common-links`：管理员生成通用链接。
- `DELETE /api/admin/invitations/common-links/:id`：撤销通用链接（保留历史记录）。
- `POST /api/admin/invitations/common-links/:id/regenerate`：撤销旧链接并生成新链接。

管理员接口使用现有 `invitation.manage` 权限、幂等键和审计日志。迁移应用前，`/ready` 会按 `REQUIRED_MIGRATION_VERSION=60` 将 API 判定为未就绪。
