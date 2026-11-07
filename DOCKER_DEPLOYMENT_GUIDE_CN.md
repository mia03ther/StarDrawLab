# StarDraw 阿里云 Docker 部署完整指南

> 本指南将带领您使用 Docker + Docker Compose 将 StarDraw 项目极简、优雅地部署到阿里云服务器（ECS）上。这是最推荐的部署方式，能够最大程度保证环境一致性，降低运维成本。

---

## 目录

- [一、准备工作](#一准备工作)
- [二、服务器（ECS）基础配置](#二服务器ecs基础配置)
- [三、安装 Docker 与 Git](#三安装-docker-与-git)
- [四、配置数据库 (RDS / 自建)](#四配置数据库-rds--自建)
- [五、获取代码与配置环境变量](#五获取代码与配置环境变量)
- [六、一键启动服务](#六一键启动服务)
- [七、配置 HTTPS 与域名 (可选但强烈推荐)](#七配置-https-与域名-可选但强烈推荐)
- [八、日常运维与更新](#八日常运维与更新)

---

## 一、准备工作

在开始之前，请确保您已经拥有：
1. **阿里云账号**：用于购买和管理云资源。
2. **域名（可选）**：用于让用户通过网站名称（如 `www.your-domain.com`）访问。如果仅用于测试，可以使用 IP 地址。
3. **Authing 账号**：用于本项目的用户认证。
4. **AI 服务商 API Key**：如 Nano Banana 2 或 Sora 等。
5. **阿里云 OSS**：用于存储生成的图片和视频（需要 Bucket 名称、Endpoint 和 AccessKey）。

---

## 二、服务器（ECS）基础配置

### 2.1 购买或配置 ECS 实例

* **操作系统**：强烈推荐选择 **Ubuntu 22.04 LTS** 或 **Ubuntu 24.04 LTS**。
* **实例规格**：推荐至少 2核 4G（如 `ecs.e-c1m2.large`），以确保 Node.js 和 Docker 运行流畅。
* **网络**：分配公网 IPv4 地址。

### 2.2 配置安全组

在阿里云 ECS 控制台 -> 安全组 -> 配置规则，确保放行以下入方向端口：
* **22** (TCP): 用于 SSH 远程连接。
* **80** (TCP): 用于 HTTP 访问（前端容器将绑定此端口）。
* **443** (TCP): 用于 HTTPS 访问（如果您打算配置 SSL）。
* *(注意：无需放行后端的 5000 端口，因为 Nginx 容器已经通过内部网络代理了 API 请求)*

### 2.3 SSH 连接到服务器

打开您的终端（或使用阿里云控制台的 Web 终端），连接到您的服务器：

```bash
ssh root@<您的服务器公网IP>
```

---

## 三、安装 Docker 与 Git

连接到服务器后，首先更新系统并安装必备工具。

### 3.1 安装基础工具

```bash
apt update && apt upgrade -y
apt install -y git curl vim
```

> **💡 新手提示：**
> 在运行 `apt upgrade -y` 期间，您可能会看到一个粉红色的全屏弹窗，标题为 **"Daemons using outdated libraries"** (正在使用过期库的守护进程)。
> 这是 Ubuntu 系统的正常提示，询问您是否重启某些系统服务以应用更新。您只需**直接按键盘上的 Enter (回车) 键**，选择默认的 `<Ok>` 即可安全继续。

### 3.2 官方脚本一键安装 Docker

使用 Docker 官方的一键安装脚本，自动安装 Docker Engine 和 Docker Compose 插件。

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
```

**验证安装是否成功：**
```bash
docker --version
docker compose version
```
如果能看到相应的版本号输出，说明安装成功。

*(可选) 设置 Docker 开机自启：*
```bash
systemctl enable docker
systemctl start docker
```

---

## 四、配置数据库 (RDS / 自建)

StarDraw 依赖 PostgreSQL 数据库。您有两种选择：

### 选择 A：使用阿里云 RDS PostgreSQL (推荐生产环境)
本项目生产基线要求使用 **PostgreSQL 16** 及以上版本。

**详细配置步骤：**
1. **购买实例**：在阿里云控制台购买 [RDS PostgreSQL 实例](https://rds.console.aliyun.com/rds/pg)。
   - **版本选择**：**PostgreSQL 16**。
   - **地域选择**：务必与您的 ECS 实例在**同一地域**（例如都在“华东1 杭州”），以便使用免费的内网连接。
   - **规格选择**：推荐至少 2核4G，SSD云盘。
2. **设置白名单**：
   - 在 RDS 控制台找到刚创建的实例，点击“数据安全性” -> “白名单设置”。
   - 将您的 ECS 实例的 **内网 IP** 添加到白名单中，或者直接添加 `0.0.0.0/0`（如果后续仅通过内网访问并配置了安全组）。
3. **创建账号和数据库**：
   - 点击“账号管理”，创建一个**高权限账号**（如 `stardraw_user`），并记住密码。
   - 点击“数据库管理”，创建一个名为 `stardraw` 的数据库，并授权给刚才创建的账号。
4. **获取内网地址**：
   - 在“数据库连接”页面，找到 **内网地址**（例如 `rm-xxxxxx.pg.rds.aliyuncs.com`）和端口（默认 `5432`）。

### 选择 B：在服务器上通过 Docker 自建 PostgreSQL (适合测试/小规模使用)
如果您想节省成本，可以直接在同一台服务器上运行一个 Postgres 16 容器。

运行以下命令快速启动一个 PostgreSQL 容器：
```bash
docker run -d \
  --name stardraw-postgres \
  --restart unless-stopped \
  -e POSTGRES_USER=stardraw_user \
  -e POSTGRES_PASSWORD=your_secure_password \
  -e POSTGRES_DB=stardraw \
  -p 5432:5432 \
  -v /opt/stardraw-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```
*此时，您的数据库连接 URL 为：`postgres://stardraw_user:your_secure_password@<服务器内网IP>:5432/stardraw`*

### 初始化数据库表结构
需要将项目的建表 SQL 导入到数据库中。您可以先克隆项目（见第五步），然后使用 `psql` 工具或在本地使用客户端连接执行 `server/migrations/001_full_schema.sql`。

---

## 五、获取代码与配置环境变量

### 5.1 克隆项目代码

将项目放置在 `/opt` 目录下：

```bash
cd /opt
git clone https://github.com/rant-ha/stardraw.git
cd stardraw
```

### 5.2 配置后端环境变量 (`server/.env`)

复制示例文件并编辑：

```bash
cd server
cp .env.example .env
vim .env
```

填入真实的配置信息。关键配置项如下：

```env
NODE_ENV=production
PORT=5000

# 数据库连接 (如果是阿里云 RDS，请使用内网地址)
DATABASE_URL=postgres://stardraw_user:your_password@your-db-host:5432/stardraw
DB_SSL=false

# Authing 配置
AUTHING_APP_ID=您的Authing应用ID
AUTHING_APP_HOST=https://your-app.authing.cn

# 阿里云 OSS (如果 ECS 和 OSS 同一地域，强烈推荐使用内网 Endpoint 节省流量费)
OSS_REGION=oss-cn-hangzhou
OSS_ENDPOINT=oss-cn-hangzhou-internal.aliyuncs.com
OSS_BUCKET=您的Bucket名称
OSS_ACCESS_KEY_ID=您的AK
OSS_ACCESS_KEY_SECRET=您的SK
OSS_BASE_URL=https://您的Bucket公网域名 # 用户访问图片的地址

# AI 服务商配置
IMAGE_PROVIDER_KEY=...
IMAGE_PROVIDER_BASE_URL=...
IMAGE_PROVIDER_MODEL=...

# 允许跨域的源 (填您的公网 IP 或域名)
ALLOWED_ORIGINS=http://<您的服务器IP>
APP_BASE_URL=http://<您的服务器IP>
```

### 5.3 配置 Docker 根目录环境变量 (非常重要！)

Docker Compose 启动和前端构建时，需要从**项目根目录**读取 `.env` 文件获取 Authing 等变量。

返回项目根目录：

```bash
cd /opt/stardraw
cp .env.example .env
vim .env
```

将以下关于前端构建的 Authing 变量填入真实的配置：

```env
# 必须正确填写，否则前端打包后无法拉起登录页！
VITE_AUTHING_APP_ID=您的Authing应用ID
VITE_AUTHING_DOMAIN=https://your-app.authing.cn

# 登录后的回调地址 (填您的服务器公网 IP 或您将绑定的域名)
VITE_AUTHING_REDIRECT_URI=http://<您的服务器公网IP>/callback
# 登出后的跳转地址
VITE_AUTHING_LOGOUT_URI=http://<您的服务器公网IP>/
```
*(注意：根目录下后端的变量如果您已经在 `server/.env` 中配置过，这里可以保持注释状态，因为 docker-compose.yml 已经显式引入了 `server/.env`。)*

---

## 六、一键启动服务

一切配置就绪后，退回项目根目录（`/opt/stardraw`），执行 Docker Compose 启动命令：

```bash
cd /opt/stardraw

# 构建镜像并在后台启动容器
docker compose up -d --build
```

Docker 会自动：
1. 根据 `client/Dockerfile` 下载 Node.js 环境，编译前端 React 代码，并打包到一个 Nginx 容器中。
2. 根据 `server/Dockerfile` 构建后端 Express 运行环境。
3. 将后端 Nginx 的 `/api` 请求自动转发给后端 API 容器。
4. 挂载日志和临时文件目录。

**检查运行状态：**
```bash
docker compose ps
```
您应该看到 `quickai_api` 和 `quickai_web` 两个容器处于 `Up` 状态。

**测试访问：**
打开浏览器，访问 `http://<您的服务器公网IP>`，如果能看到页面，说明部署成功！

---

## 七、配置 HTTPS 与域名 (可选但强烈推荐)

对于生产环境，强烈建议绑定域名并开启 HTTPS。

### 方法一：使用阿里云控制台及负载均衡 (ALB)
如果您使用了阿里云的应用型负载均衡 (ALB)，可以直接在 ALB 上配置 SSL 证书和域名，后端指向 ECS 的 80 端口即可。

### 方法二：在服务器前端再加一层 Nginx 或 Caddy 处理 HTTPS
如果您希望直接在服务器上处理，推荐使用轻量级的 **Caddy** 服务器作为最外层的反向代理，它会自动为您申请和续期 SSL 证书。

1. **安装 Caddy**:
```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install caddy
```

2. **修改 Docker Compose 端口映射**:
为了不与 Caddy 冲突，我们需要将 Docker 中的 web 容器端口改到本地的某个端口（如 8080）。
修改 `docker-compose.yml`：
```yaml
  web:
    # ...
    ports:
      - "127.0.0.1:8080:80" # 修改这里
```
然后应用更改：`docker compose up -d`

3. **配置 Caddyfile**:
```bash
vim /etc/caddy/Caddyfile
```
将其内容替换为（将 `your-domain.com` 换成您已解析到 ECS 的真实域名）：
```caddyfile
your-domain.com {
    reverse_proxy localhost:8080
}
```

4. **重启 Caddy**:
```bash
systemctl restart caddy
```
此时，Caddy 会自动去申请 Let's Encrypt 证书，您就可以通过 `https://your-domain.com` 访问了。*(注意别忘了修改前后端 `.env` 文件中的回调 URL 为 `https://`)*

---

## 八、日常运维与更新

### 8.1 查看日志

后端 API 的详细业务日志被挂载在宿主机的 Docker 目录，但您也可以直接通过 Docker 命令查看：

```bash
cd /opt/stardraw

# 查看所有容器日志并跟踪输出
docker compose logs -f

# 仅查看后端 API 日志
docker compose logs -f api
```

### 8.2 更新代码与重启服务

当您修改了代码或从 GitHub 拉取了最新更新后，只需执行以下命令即可平滑更新：

```bash
cd /opt/stardraw

# 1. 拉取最新代码
git pull origin main

# 2. 重新构建并重启服务 (仅重建有改动的服务)
docker compose up -d --build
```

### 8.3 清理无用资源

长时间运行 Docker 可能会积累无用的旧镜像和构建缓存。您可以定期运行以下命令清理磁盘：

```bash
docker system prune -a --volumes
```
*(注意：这会删除所有未使用的镜像、容器和卷，请确认数据已备份或安全)*
