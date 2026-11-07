# awesome-gpt-image-2 模板市场导入

StarDraw 使用结构化源数据导入 `awesome-gpt-image-2`，不解析 README，也不把大量模板硬编码进数据库迁移。

当前固定源版本：

- 仓库：`https://github.com/freestylefly/awesome-gpt-image-2`
- Commit：`76fcd0e6b3961ef2b041547aac654f1efd1ef270`
- 案例：517 条（源仓库 README 曾显示 520，但 `data/cases.json` 实际为 517）
- 风格/工业模板：22 条
- 数据库 Skill：`gpt-image-2-style-library`

## 安全与幂等

- 迁移 038 必须先应用。
- 导入前检查 `gpt-image-2 -> image_provider` 路由及有效计费规则。
- 预览图片从本地固定版本上传到 StarDraw OSS，数据库不依赖 GitHub Raw。
- `(source_key, source_item_id)` 唯一约束保证可重复执行。
- 重跑只同步来源内容，不覆盖管理员设置的精选状态、会员门槛、公开状态或上下架状态。
- Skill 内容包含源 `SKILL.md` 与 style-library 参考文件，并记录 SHA-256。

## 命令

仅校验本地源文件，不连接数据库、不上传 OSS：

```bash
cd /opt/stardraw/server
npm run templates:validate:awesome-gpt-image-2
```

正式导入（应先备份 PostgreSQL 并确认迁移 038 已应用）：

```bash
cd /opt/stardraw/server
npm run templates:import:awesome-gpt-image-2
```

可通过 `AWESOME_GPT_IMAGE_2_REPOSITORY_ROOT` 指向另一个固定版本的本地仓库。升级源版本时应同时更新并审查 `AWESOME_GPT_IMAGE_2_SOURCE_COMMIT`。
