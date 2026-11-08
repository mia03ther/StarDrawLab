# StarDraw Lab

**把一张照片，变成你想拥有的实物设计。**

StarDraw Lab 是一个面向创作者的 AI 视觉创作实验室。它将「上传照片 → 选择风格 → 生成设计预览 → 保存分享 → 人工咨询定制」串成一条可验证的创作链路。

> 这是正在迭代的产品源码。线上服务依赖私有配置、对象存储、身份系统与模型供应商；请不要把任何生产密钥、用户数据或 `.env` 文件提交到仓库。

## What it does

- **照片风格化**：把真实照片变成插画、角色、商品视觉和场景图。
- **模板市场**：浏览、使用、创建与管理可复用的生成模板。
- **实物定制 MVP**：完成设计预览后，进入人工确认打样、工艺和报价的咨询链路。
- **作品与素材管理**：保存生成记录、管理图片与视频素材、导出可用资源。
- **创作工作台**：提供 AI 图片、视频、数字人和工作流能力；不同模型能力以实际供应商状态为准。

## Product flow

```text
上传照片 → 选择视觉风格 → 选择实物载体 → 生成设计 / 实物预览
                                        ↓
                              保存、分享或扫码咨询报价
```

目前 MVP 的核心是验证：用户是否愿意把自己的照片变成可被制作的设计。自动下单、供应链履约与完整报价系统不在此仓库的当前承诺范围内。

## Stack

- **Client**: React + Vite + Tailwind CSS
- **Server**: Node.js + Express
- **Data**: PostgreSQL
- **Runtime**: Docker Compose + Nginx
- **Storage / auth**: production deployments use configurable object storage and an OIDC-compatible identity provider

## Local setup

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- An object-storage-compatible development bucket or mock
- A development OIDC application

### Install

```bash
git clone https://github.com/mia03ther/StarDrawLab.git
cd StarDrawLab

cd server && npm ci
cd ../client && npm ci
```

Copy the supplied example configuration files and fill them with **development-only** values:

```bash
cp .env.example .env
cp server/.env.example server/.env
cp client/.env.example client/.env.local
```

Run the services in separate terminals:

```bash
cd server && npm run dev
cd client && npm run dev
```

The exact environment-variable set evolves with the provider adapters. Start from the example files in this repository; never copy a production `.env` into a local or public environment.

## Development principles

- Keep user data, authentication configuration and provider keys outside Git.
- Prefer provider adapters and explicit error states over pretending an unavailable model succeeded.
- Treat credit charging as a ledgered server-side operation; do not modify balances from the client.
- Preserve user works and point records during releases. Production deploys should build a new image, health-check it, then switch traffic with a known rollback image available.
- Respect `prefers-reduced-motion`; product motion should make status and hierarchy clearer, not get in the way.

## Contributing

1. Create a focused branch.
2. Keep changes small and explain the user-facing impact.
3. Run the relevant client/server checks before opening a pull request.
4. Do not submit credentials, customer data, generated private assets or deployment backups.

## Status

This is an active experimental product. The public source is useful for reviewing the interface and application architecture; model availability, video generation, payments and fulfilment depend on separately configured production services.

## License

See [LICENSE](LICENSE).
