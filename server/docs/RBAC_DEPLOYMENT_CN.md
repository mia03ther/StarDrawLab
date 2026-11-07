# StarDraw 三层权限上线清单

本清单用于 `root / admin / user` 权限版本。它不会自动执行迁移或重启服务。

## 权限矩阵

| 能力 | user | admin | root |
|---|---:|---:|---:|
| 使用个人内容、模板与生成服务 | 是 | 是 | 是 |
| 查看用户基础资料、会员、脱敏订单和聚合用量 | 否 | 是 | 是 |
| 封禁/恢复普通用户 | 否 | 是 | 是 |
| 管理/审核公开模板 | 否 | 是 | 是 |
| 创建、编辑、停用订阅套餐 | 否 | 是 | 是 |
| 授予/撤销 admin | 否 | 否 | 是 |
| 模型展示与模型路由配置 | 否 | 否 | 是 |
| 手工积分/会员调整、退款 | 否 | 否 | 是 |
| Provider、SMTP、支付宝密钥 | 否 | 否 | 仅服务端安全配置 |
| 查看/导出管理员审计日志 | 否 | 否 | 是 |
| 紧急只读查看指定私有内容 | 否 | 否 | 是（原因、审计） |

Agent 的 `Ask for approval / Approve for me / Full Access` 是另一套用户授权，不能改变上述角色，也不能跨用户访问数据。

## 上线前配置

1. 生产环境必须同时配置 `AUTHING_APP_HOST` 与 `AUTHING_APP_ID`。缺少任一项时新服务会拒绝启动，避免跳过 issuer 或 audience 校验。`ALLOW_DEV_AUTH_HEADERS` 必须保持 `false`。

2. 在 Authing 确认唯一 root 账号的用户 ID（JWT 的 `sub`），写入真实服务器 `.env`：

   ```dotenv
   ROOT_ADMIN_USER_ID=真实的Authing用户ID
   ```

3. 生成独立的资源授权密钥，不得复用 OSS、支付宝或 Provider 密钥：

   ```bash
   openssl rand -base64 48
   ```

   将结果仅写入真实服务器 `.env`：

   ```dotenv
   RESOURCE_ACCESS_SECRET=生成的随机值
   ```

4. 管理员和 root 只要求有效的 Authing 登录会话及数据库角色权限，不要求 Authing MFA。危险操作仍要求操作原因、确认短语（适用时）、幂等键和完整审计；root 固定身份仍由 `ROOT_ADMIN_USER_ID` 校验。

5. 确认代码和反向代理中不存在 `API_ADMIN_KEY`、`X-Admin-Key` 提权。旧变量即使仍在真实 `.env` 中也不会被代码读取，完成新版本验证后应轮换并删除旧值。

## 数据库迁移顺序

先做可恢复备份，再按顺序在维护流程中执行：

1. `018_rbac_audit.sql`
2. `019_content_recycle_bin.sql`
3. `020_resource_access_security.sql`
4. `021_model_catalog_routing.sql`
5. `022_metered_agent_operations.sql`
6. `023_administrator_operation_idempotency.sql`
7. `024_user_operation_idempotency.sql`
8. `025_persistent_jobs.sql`
9. `026_agent_tool_runtime.sql`
10. `027_workflow_runtime.sql`
11. `028_mcp_runtime.sql`
12. `029_execution_governor.sql`
13. `030_visual_parameter_catalog.sql`
14. `031_metered_agent_settlement_reconciliation.sql`

不得跳过顺序。`022` 是 Canvas Agent 与脚本优化逐次预占/结算积分的持久化状态，`023` 是角色、模型、模板、套餐和其他管理员写操作的幂等门卫，`024` 为用户模板、内容删除、回收站恢复和通知状态提供持久化幂等与事务边界，`025-030` 提供持久队列、Agent/MCP/工作流运行时、执行限额和视觉参数目录，`031` 提供 Agent 结果快照和结算补偿状态；任一缺失都不能切换新代码。代码部署、环境变量、认证配置和迁移必须在同一个受控发布窗口完成；否则数据库角色、计费状态或私有资源代理会处于未就绪状态。

### 维护窗口前只读预检

执行迁移前，应在获准的只读数据库会话中确认历史 owner ID 与画布上传格式。以下查询只统计，不修改数据：

```sql
WITH historical_owners AS (
  SELECT user_id::text AS user_id FROM user_point_accounts
  UNION ALL SELECT user_id::text FROM creations
  UNION ALL SELECT user_id::text FROM canvases
  UNION ALL SELECT user_id::text FROM digital_human_roles
  UNION ALL SELECT owner_user_id::text FROM prompt_templates
)
SELECT
  COUNT(*) FILTER (WHERE user_id IS NULL) AS null_owner_ids,
  COUNT(*) FILTER (WHERE LENGTH(user_id) > 255) AS oversized_owner_ids
FROM historical_owners;

WITH canvas_objects AS (
  SELECT c.user_id,
         COALESCE(element->>'objectKey', element->>'object_key') AS object_key
  FROM canvases c
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(c.canvas_state->'elements') = 'array'
      THEN c.canvas_state->'elements' ELSE '[]'::jsonb END
  ) AS element
)
SELECT
  COUNT(*) FILTER (WHERE object_key IS NOT NULL) AS referenced_object_keys,
  COUNT(*) FILTER (
    WHERE object_key IS NOT NULL
      AND LENGTH(object_key) <= 255
      AND LEFT(object_key, LENGTH('quickai/' || user_id || '/')) = 'quickai/' || user_id || '/'
  ) AS safely_backfillable,
  COUNT(*) FILTER (
    WHERE object_key IS NOT NULL
      AND NOT (
        LENGTH(object_key) <= 255
        AND LEFT(object_key, LENGTH('quickai/' || user_id || '/')) = 'quickai/' || user_id || '/'
      )
  ) AS requires_manual_review
FROM canvas_objects;
```

`null_owner_ids`、`oversized_owner_ids` 和 `requires_manual_review` 必须在发布前解释清楚。旧服务写入需在 019 回填开始前停止，并保持到新代码切换完成，避免回填快照之后出现未登记的新上传。

## 首次验证

1. 使用固定 root 登录，确认 `/api/auth/me` 返回 `role: root`；`mfa_verified` 仅为兼容性信息，不作为管理员/root 访问条件。
2. 新建测试用户，由 root 临时授予 admin，确认旧 token 立即收到 `SESSION_REVOKED`，重新登录后才获得 admin。
3. 确认 admin 无法访问角色、积分、退款、模型路由和审计接口。
4. 封禁测试用户，确认旧会话立即失效，恢复后仍需重新登录。
5. 验证 Free 内容删除为硬删除，会员内容进入 14 天可见回收站；管理员删除进入用户不可见的后台回收站。
6. 验证私有 OSS 对象不能仅凭 object key 匿名访问，公开且审核通过的模板预览仍可匿名访问。
7. 验证 root 审计导出、模型变更、角色变更和紧急私有内容查看均产生审计记录，且密钥被脱敏；上述操作不应因缺少 MFA 被拒绝。
8. 验证历史图片/视频计费 Provider 已收敛为 `image_provider` / `sora`，新建模板可命中活动计费规则，且不会出现 `No active charge rule found`。
9. 使用相同 `X-Idempotency-Key` 重放用户模板保存、内容删除和回收站恢复请求，确认返回首次响应且不会重复写入；使用相同键但不同请求体时必须返回 `409 IDEMPOTENCY_KEY_REUSED`。

## 发布注意事项

- 迁移不会删除账号、订单、积分、订阅或支付记录。
- `administrator_audit_log` 由数据库触发器禁止更新和删除，保留期不得短于一年。
- 角色或封禁状态变化会更新 `auth_valid_after`，使旧 JWT 失效。
- root 由 `ROOT_ADMIN_USER_ID` 固定绑定，接口不能创建第二个 root，也不能降级或封禁固定 root。
- 不要在日志、工单、截图或 Git 中记录真实 `.env` 值。
