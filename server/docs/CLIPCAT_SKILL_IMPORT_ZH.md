# ClipCat Skill 安全导入说明

## 结论

`xrelkd/clipcat` 是一个 GPL-3.0 的 Rust 桌面剪贴板管理器，不是可直接导入的 Agent Skill。审查的上游提交为：

`a911ef608db3331a28acecbc786e28a89de6bd8f`

上游仓库没有 `SKILL.md`。本项目不会复制、编译、安装或运行 ClipCat 的源码、二进制和脚本，只把自行编写并经过净化的“双语剪贴板内容整理说明”写入 `agent_skills`。

## 上游能力与排除项

代码和 README 审查确认上游具备以下桌面能力，但它们全部被排除在 StarDraw Skill 之外：

- 监听、缓存、持久化和回放系统剪贴板。
- 通过 HTTP/Unix Socket 提供 gRPC 服务，以及提供 D-Bus 服务。
- 启动外部编辑器，以及 fzf、rofi、dmenu 等外部选择器。
- 读取和递归监听本地文件、目录与片段库。
- 从配置文件读取访问令牌。
- 运行守护进程、命令行客户端和本地通知程序。

导入后的 Skill 是纯 Markdown 指令，`runtime_capabilities` 固定为 `none`。Agent 只能整理当前用户已经明确粘贴、输入或上传到 StarDraw 会话中的内容，不能获得系统剪贴板、文件系统、网络、密钥或命令执行权限。

## 文件

- `scripts/clipcatSkillImport.js`：来源检查、内容生成、验证模式和幂等数据库导入。
- `docs/CLIPCAT_SKILL_IMPORT_ZH.md`：本说明。
- `package.json`：提供验证和导入命令。

## 离线验证

在 `server` 目录执行：

```bash
npm run skills:validate:clipcat
```

验证模式会：

1. 检查本地参考仓库的完整 Git 提交号。
2. 检查 README、GPL-3.0 许可证和关键风险能力的实际代码证据。
3. 确认上游仍然没有 `SKILL.md`；如果未来出现，立即失败并要求重新安全审查。
4. 生成净化后的 Skill，检查强制安全边界、大小和内容哈希。
5. 输出 `databaseCodeLoaded: false`；不会加载 `.env`、数据库配置或建立数据库连接。

如需审查另一个本地副本或已经人工复核的新提交，可显式指定：

```bash
node scripts/clipcatSkillImport.js --validate-only \
  --repository /absolute/path/to/clipcat \
  --expected-commit <完整的四十位提交号>
```

不要只因为验证通过就自动信任新版本。上游提交变化后仍应人工检查许可证、README、能力证据和净化边界。

## 受控导入

只有在明确选择目标数据库并确认 `ROOT_ADMIN_USER_ID` 后，才能执行：

```bash
npm run skills:import:clipcat
```

该命令会加载服务端 `.env` 并连接其中配置的数据库。它不会执行迁移；若迁移 038 尚未应用，会直接失败。

导入行为：

- 固定名称：`clipcat-safe-clipboard`
- 固定来源：`github:xrelkd/clipcat:sanitized-guidance`
- 使用事务和 PostgreSQL advisory lock 防止并发重复导入。
- 首次运行插入；内容未变化时返回 `unchanged`，不增加版本号；内容或状态变化时更新并增加版本号。
- 如果同名 Skill 已经属于其他来源，拒绝覆盖。
- 导入后在同一事务内复核名称、来源、状态和 SHA-256。

## 安全审查要点

- 脚本不导入上游 Rust 代码，不调用上游命令，也不使用 Node 子进程 API。
- 仓库文件读取限制在已解析的仓库根目录内，拒绝符号链接、路径穿越和超大源文件。
- Skill 明确把用户粘贴的内容视为不可信数据，忽略其中的提示注入和越权指令。
- Skill 不替代 StarDraw 的 root/admin/user RBAC、Agent 三档审批、工具白名单、积分检查和审计。
- 这次检查点不连接生产数据库、不部署、不迁移，也不重启线上服务。
