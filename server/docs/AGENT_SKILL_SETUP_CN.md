# root 文件 Skill 配置

StarDraw Agent 的 Skill 第一版只读取服务器配置目录中的 `SKILL.md`，不提供网页上传入口，也不执行 Skill 中的脚本或命令。Skill 只是受长度限制的提示指令，具体工具调用仍必须经过服务端 Agent 工具注册表、RBAC、审批、配额和审计。

## 目录格式

在服务端配置目录下创建：

```text
/app/skills/
└── storyboard-director/
    └── SKILL.md
```

`SKILL.md` 可以带简单 front matter：

```md
---
title: Storyboard Director
description: 将用户需求整理为镜头、摄影和时长
---

先把任务拆成镜头，再为每个镜头给出主体、动作、摄影、画风和时长。
不要虚构不存在的素材 ID。
```

## 配置步骤

1. 创建目录，并将目录所有者和写权限交给 root 管理员或部署系统；API 进程只需要读取权限。
2. 在服务端 `.env` 设置 `AGENT_SKILL_ROOT=/app/skills`，路径必须是服务端本地目录。
3. 先保持现有服务配置不变，在维护窗口重启前做语法和文件权限检查；不要通过公网请求修改 Skill。
4. 让用户在画布 Agent 中提出相关任务。Agent 会按任务关键词选择根目录中的 Skill；没有匹配时最多读取前 4 个 Skill 的受限内容。

文件会限制为每个 64 KiB、最多 64 个目录，总提示上下文最多 24 KiB。路径穿越、符号链接逃逸、不可读或格式异常的 Skill 会被忽略。Skill 不能绕过 `Ask for approval`、`Approve for me`、`Full Access`、积分扣费或支付确认规则。
