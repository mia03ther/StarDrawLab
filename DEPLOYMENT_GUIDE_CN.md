# StarDraw 阿里云部署完整指南

> 基于阿里云官方文档和 PM2 最佳实践优化的部署教程

---

## 目录

- [一、架构概览](#一架构概览)
- [二、准备工作](#二准备工作)
- [三、服务器配置](#三服务器配置)
- [四、Node.js 环境安装](#四nodejs-环境安装)
- [五、数据库配置](#五数据库配置)
- [六、OSS 存储配置](#六oss-存储配置)
- [七、应用部署](#七应用部署)
- [八、PM2 生产配置](#八pm2-生产配置)
- [九、Nginx 配置](#九nginx-配置)
- [十、SSL 证书配置](#十ssl-证书配置)
- [十一、监控与运维](#十一监控与运维)
- [十二、Docker 部署](#十二docker-部署)
- [十三、成本估算](#十三成本估算)
- [十四、常见问题](#十四常见问题)

---

## 一、架构概览

```
                           ┌─────────────────┐
                           │   用户请求      │
                           └────────┬────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │     阿里云 CDN（可选）        │
                    │     域名解析 + SSL            │
                    └───────────────┬───────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          ECS 服务器                                     │
│  ┌──────────────┐  ┌────────────────────────┐  ┌──────────────────┐   │
│  │    Nginx     │  │      PM2 Cluster       │  │   React 静态     │   │
│  │  (反向代理)  │──│  ┌────────┐ ┌────────┐ │  │    (前端)        │   │
│  │              │  │  │Node #1│ │Node #2│ │  │                  │   │
│  └──────┬───────┘  │  └────────┘ └────────┘ │  └──────────────────┘   │
│         │          └────────┬───────────────┘                         │
│         │                   │                                          │
└─────────│───────────────────│──────────────────────────────────────────┘
          │                   │
          ▼                   ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   Aliyun OSS     │  │  RDS PostgreSQL  │  │  AI Providers    │
│  (文件存储)      │  │    (数据库)      │  │ (图片/视频生成)  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

**关键技术栈：**
- 前端：React 19 + Vite 7 + Tailwind CSS 4
- 后端：Express 5 + PostgreSQL
- 进程管理：PM2 Cluster Mode
- 存储：Aliyun OSS + CDN
- 认证：Authing JWT

---

## 二、准备工作

### 2.1 所需账号

| 服务 | 用途 | 获取地址 |
|------|------|----------|
| 阿里云账号 | ECS、RDS、OSS | https://www.aliyun.com |
| Authing 账号 | 用户认证 | https://www.authing.cn |
| AI Provider | 图片/视频生成 | Nano Banana 2 / Sora2 |

### 2.2 域名准备

1. 购买域名（可通过阿里云或 Cloudflare）
2. 完成实名认证
3. 准备 SSL 证书（推荐 Let's Encrypt 免费证书）

---

## 三、服务器配置

### 3.1 ECS 实例选择

**推荐配置：**

| 项目 | 推荐值 | 说明 |
|------|--------|------|
| 实例规格 | ecs.c6.large (2vCPU 4GB) | 入门级，支持 PM2 cluster |
| 地域 | 华东1（杭州）或 华北2（北京） | 选择用户最近的地域 |
| 镜像 | **Ubuntu 22.04 LTS** | 推荐，Node.js 支持好 |
| 存储 | 40GB 高效云盘 | 系统盘 |
| 带宽 | 5Mbps | 按需调整 |

> ⚠️ **重要**：Alibaba Cloud Linux 2 和 CentOS 7.x 仅支持 Node.js 17.x 及以下版本，推荐使用 Ubuntu 22.04。

**月费用预估：** ~200-300 元

### 3.2 安全组配置

**入站规则：**

| 端口 | 协议 | 来源 | 说明 |
|------|------|------|------|
| 22 | TCP | 办公 IP | SSH 管理 |
| 80 | TCP | 0.0.0.0/0 | HTTP |
| 443 | TCP | 0.0.0.0/0 | HTTPS |
| 3000 | TCP | 127.0.0.1 | 开发测试（仅内部） |
| 5000 | TCP | 127.0.0.1 | API（仅内部） |

> 💡 **安全建议**：避免将 SSH 端口开放给所有 IP，建议仅放行办公网 IP。

### 3.3 连接服务器

```bash
# SSH 连接
ssh root@your-server-ip

# 创建普通用户（推荐）
adduser stardraw
usermod -aG sudo stardraw

# 切换用户
su - stardraw
```

---

## 四、Node.js 环境安装

### 4.1 使用 NVM 安装（推荐）

> 阿里云官方推荐使用 NVM 管理 Node.js 版本，相比包管理器安装，NVM 不受系统仓库版本限制，且支持多版本管理。

```bash
# 安装 Git
sudo apt update
sudo apt install -y git curl

# 使用 Gitee 镜像克隆 NVM（国内更快）
git clone https://gitee.com/mirrors/nvm.git ~/.nvm && cd ~/.nvm && git checkout `git describe --abbrev=0 --tags`

# 配置环境变量
sudo sh -c 'echo ". ~/.nvm/nvm.sh" >> /etc/profile'
source /etc/profile

# 设置阿里云镜像加速下载
export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node

# 查看可用版本
nvm list-remote

# 安装 Node.js 20 LTS（推荐）
nvm install v20.11.0
nvm use v20.11.0

# 设置默认版本
nvm alias default v20.11.0

# 验证安装
node --version  # v20.11.0
npm --version   # 10.x.x
```

### 4.2 安装全局工具

```bash
# 安装 PM2（进程管理）
npm install -g pm2

# 安装 pnpm（可选，更快的包管理器）
npm install -g pnpm

# 验证安装
pm2 --version  # 5.x.x
```

### 4.3 安装其他依赖

```bash
# 安装 Nginx
sudo apt install -y nginx

# 安装 PostgreSQL 客户端
sudo apt install -y postgresql-client

# 安装构建工具（某些 npm 包需要）
sudo apt install -y build-essential python3
```

---

## 五、数据库配置

### 5.1 创建 RDS PostgreSQL 实例

1. 登录阿里云控制台
2. 进入「云数据库 RDS」
3. 创建实例：
   - 引擎：PostgreSQL 14
   - 版本：PostgreSQL 14.x
   - 规格：2核4GB（入门）
   - 存储：20GB SSD
   - 地域：**与 ECS 同地域**（使用内网连接）

### 5.2 配置数据库连接

```bash
# 获取 RDS 内网地址
# 格式：rm-xxxxx.pg.rds.aliyuncs.com

# 设置白名单（添加 ECS 内网 IP）
# 在 RDS 控制台 -> 数据安全性 -> 白名单设置

# 创建数据库和用户
psql -h rm-xxxxx.pg.rds.aliyuncs.com -U postgres -d postgres
```

```sql
-- 执行以下 SQL
CREATE DATABASE stardraw;
CREATE USER stardraw_user WITH ENCRYPTED PASSWORD 'your_secure_password_here';
GRANT ALL PRIVILEGES ON DATABASE stardraw TO stardraw_user;

-- 连接到新数据库
\c stardraw
GRANT ALL ON SCHEMA public TO stardraw_user;

-- 退出
\q
```

### 5.3 执行数据库迁移

```bash
# 克隆项目
cd /var/www
sudo git clone https://github.com/rant-ha/stardraw.git
sudo chown -R stardraw:stardraw stardraw
cd stardraw

# 执行迁移脚本
psql -h rm-xxxxx.pg.rds.aliyuncs.com \
  -U stardraw_user \
  -d stardraw \
  -f server/migrations/001_full_schema.sql

# 验证表创建
psql -h rm-xxxxx.pg.rds.aliyuncs.com \
  -U stardraw_user \
  -d stardraw \
  -c "\dt"
```

---

## 六、OSS 存储配置

### 6.1 创建 OSS Bucket

1. 登录阿里云控制台
2. 进入「对象存储 OSS」
3. 创建 Bucket：
   - Bucket 名称：stardraw-files
   - 地域：**与 ECS 同地域**
   - 存储类型：标准存储
   - 读写权限：**私有**
   - 版本控制：不建议开启

### 6.2 配置内网端点（节省流量费）

```bash
# 内网端点格式：oss-cn-hangzhou-internal.aliyuncs.com
# 确保 ECS 和 OSS 在同一地域，使用内网端点免费

# 记录以下配置信息：
OSS_REGION=oss-cn-hangzhou
OSS_BUCKET=stardraw-files
OSS_ENDPOINT=oss-cn-hangzhou-internal.aliyuncs.com  # 内网端点
OSS_EXTERNAL_ENDPOINT=oss-cn-hangzhou.aliyuncs.com  # 公网端点（用户访问用）
```

### 6.3 创建 RAM 用户

1. 进入 RAM 控制台
2. 创建用户：
   - 用户名：stardraw-oss
   - 访问方式：编程访问
3. 记录 AccessKey ID 和 AccessKey Secret
4. 授权：AliyunOSSFullAccess（或自定义最小权限策略）

```json
// 自定义最小权限策略
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:DeleteObject",
        "oss:ListObjects"
      ],
      "Resource": [
        "acs:oss:*:*:stardraw-files",
        "acs:oss:*:*:stardraw-files/*"
      ]
    }
  ]
}
```

### 6.4 配置 CDN 加速（可选）

1. 在 OSS Bucket 设置中绑定自定义域名
2. 开启 CDN 加速
3. 配置 HTTPS 证书

---

## 七、应用部署

### 7.1 配置环境变量

```bash
# 创建后端配置
cd /var/www/stardraw/server
cp .env.example .env
nano .env
```

**`.env` 完整配置：**

```env
# ═══════════════════════════════════════════════
# 运行环境
# ═══════════════════════════════════════════════
NODE_ENV=production
PORT=5000

# ═══════════════════════════════════════════════
# 数据库连接（使用内网地址）
# ═══════════════════════════════════════════════
DATABASE_URL=postgres://stardraw_user:your_secure_password@rm-xxxxx.pg.rds.aliyuncs.com:5432/stardraw

# 内网访问可关闭 SSL（提升性能）
DB_SSL=false

# ═══════════════════════════════════════════════
# Authing 鉴权
# ═══════════════════════════════════════════════
AUTHING_APP_ID=your_authing_app_id
AUTHING_APP_HOST=https://your-app.authing.cn

# ═══════════════════════════════════════════════
# 阿里云 OSS（使用内网端点）
# ═══════════════════════════════════════════════
OSS_REGION=oss-cn-hangzhou
OSS_ENDPOINT=oss-cn-hangzhou-internal.aliyuncs.com
OSS_BUCKET=stardraw-files
OSS_ACCESS_KEY_ID=your_access_key_id
OSS_ACCESS_KEY_SECRET=your_access_key_secret

# 用户访问用公网域名（CDN 加速）
OSS_BASE_URL=https://cdn.your-domain.com

# ═══════════════════════════════════════════════
# AI Provider
# ═══════════════════════════════════════════════
IMAGE_PROVIDER_KEY=your_image_provider_key
IMAGE_PROVIDER_BASE_URL=https://www.newtoken.club/v1
IMAGE_PROVIDER_MODEL=nano-banana-2
IMAGE_PROVIDER_FALLBACK_MODEL=nana-banana-2
IMAGE_PROVIDER_MODELS=nana-banana-2,nana-banana-pro,gpt-image-2
IMAGE_PROVIDER_REFERENCE_IMAGE_MODELS=nana-banana-2,nana-banana-pro

SORA_API_KEY=your_sora_api_key
SORA_BASE_URL=https://www.newtoken.club
VIDEO_MODEL=veo-3-1

# ═══════════════════════════════════════════════
# 安全与日志
# ═══════════════════════════════════════════════
ALLOWED_ORIGINS=https://your-domain.com
LOG_DIR=/var/log/stardraw
LOG_LEVEL=info
APP_BASE_URL=https://your-domain.com
```

```bash
# 创建前端配置
cd /var/www/stardraw/client
cp .env.example .env.production
nano .env.production
```

**`.env.production` 配置：**

```env
VITE_AUTHING_APP_ID=your_authing_app_id
VITE_AUTHING_DOMAIN=https://your-app.authing.cn
VITE_AUTHING_REDIRECT_URI=https://your-domain.com/callback
VITE_AUTHING_LOGOUT_URI=https://your-domain.com/
VITE_BASE_URL=
```

### 7.2 安装依赖并构建

```bash
# 安装后端依赖
cd /var/www/stardraw/server
npm install --production

# 安装前端依赖并构建
cd /var/www/stardraw/client
npm install
npm run build

# 创建日志目录
sudo mkdir -p /var/log/stardraw
sudo chown -R stardraw:stardraw /var/log/stardraw
```

---

## 八、PM2 生产配置

### 8.1 创建 PM2 配置文件

> PM2 的 Cluster 模式可以利用多核 CPU，显著提升 Node.js 应用性能。

```bash
cd /var/www/stardraw
nano ecosystem.config.js
```

```javascript
// ecosystem.config.js - PM2 生产配置
module.exports = {
  apps: [{
    name: 'stardraw-api',
    cwd: '/var/www/stardraw/server',
    script: 'server.js',
    
    // Cluster 模式：利用多核 CPU
    // 推荐设置为 CPU 核心数 - 1，避免资源竞争
    instances: 'max',  // 或设置为具体数字，如 3（4核CPU）
    exec_mode: 'cluster',
    
    // 环境变量
    env_production: {
      NODE_ENV: 'production',
      PORT: 5000
    },
    
    // 日志配置
    error_file: '/var/log/stardraw/error.log',
    out_file: '/var/log/stardraw/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // 内存限制重启（防止内存泄漏）
    max_memory_restart: '500M',
    
    // 重启策略
    restart_delay: 3000,           // 重启延迟 3 秒
    exp_backoff_restart_delay: 100, // 指数退避
    max_restarts: 10,              // 最大重启次数
    min_uptime: '10s',             // 最小运行时间
    autorestart: true,
    
    // 监控
    watch: false,  // 生产环境关闭文件监控
    
    // 优雅关闭超时
    kill_timeout: 5000,
    wait_ready: true,  // 等待应用发送 ready 信号
    listen_timeout: 3000
  }]
};
```

### 8.2 启动服务

```bash
cd /var/www/stardraw

# 启动 PM2 服务
pm2 start ecosystem.config.js --env production

# 查看状态
pm2 list

# 查看详细信息
pm2 show stardraw-api

# 实时监控
pm2 monit

# 查看日志
pm2 logs stardraw-api
```

### 8.3 设置开机自启

```bash
# 生成启动脚本
pm2 startup

# 执行输出的命令，类似：
# sudo env PATH=$PATH:/home/stardraw/.nvm/versions/node/v20.11.0/bin \
#   /home/stardraw/.nvm/versions/node/v20.11.0/lib/node_modules/pm2/bin/pm2 \
#   startup systemd -u stardraw --hp /home/stardraw

# 保存进程列表
pm2 save

# 验证服务已添加
systemctl status pm2-stardraw
```

### 8.4 安装日志轮转

```bash
# 安装 pm2-logrotate 模块
pm2 install pm2-logrotate

# 配置日志轮转
pm2 set pm2-logrotate:max_size 10M        # 单文件最大 10MB
pm2 set pm2-logrotate:retain 30           # 保留 30 天
pm2 set pm2-logrotate:compress true       # 压缩旧日志
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD-HH-mm-ss

# 验证安装
pm2 list
```

### 8.5 常用 PM2 命令

```bash
# 重启（零停机，逐个重启）
pm2 reload stardraw-api

# 重启（全部重启，有短暂停机）
pm2 restart stardraw-api

# 停止
pm2 stop stardraw-api

# 删除
pm2 delete stardraw-api

# 查看日志
pm2 logs stardraw-api --lines 100

# 清空日志
pm2 flush

# 实时监控
pm2 monit

# 动态调整实例数
pm2 scale stardraw-api 4  # 调整为 4 个实例
pm2 scale stardraw-api +2 # 增加 2 个实例
```

---

## 九、Nginx 配置

### 9.1 创建站点配置

```bash
sudo nano /etc/nginx/sites-available/stardraw
```

```nginx
# HTTP 重定向到 HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com www.your-domain.com;
    
    # Let's Encrypt 验证路径
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    # 其他请求重定向到 HTTPS
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS 配置
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.com www.your-domain.com;

    # SSL 证书
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL 配置（Mozilla Intermediate 兼容性）
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # HSTS（强制 HTTPS）
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 前端静态文件
    root /var/www/stardraw/client/dist;
    index index.html;

    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/xml+rss application/atom+xml image/svg+xml;
    gzip_min_length 1024;
    gzip_disable "msie6";

    # 前端路由（SPA）
    location / {
        try_files $uri $uri/ /index.html;
    }

    # 静态资源缓存（Vite 带 hash）
    location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # API 反向代理
    location /api {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        
        # 代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # 超时配置（视频生成可能较慢）
        proxy_connect_timeout 60s;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        
        # 请求体大小限制
        client_max_body_size 50m;
    }

    # 健康检查（不记录日志）
    location /health {
        proxy_pass http://127.0.0.1:5000/health;
        access_log off;
    }

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

### 9.2 启用配置

```bash
# 创建软链接
sudo ln -s /etc/nginx/sites-available/stardraw /etc/nginx/sites-enabled/

# 删除默认配置
sudo rm /etc/nginx/sites-enabled/default

# 创建 certbot 目录
sudo mkdir -p /var/www/certbot

# 测试配置
sudo nginx -t

# 重载 Nginx
sudo systemctl reload nginx
```

---

## 十、SSL 证书配置

### 10.1 使用 Let's Encrypt（免费）

```bash
# 安装 Certbot
sudo apt install -y certbot python3-certbot-nginx

# 获取证书
sudo certbot --nginx -d your-domain.com -d www.your-domain.com

# 按提示操作：
# 1. 输入邮箱地址
# 2. 同意服务条款
# 3. 选择是否重定向 HTTP 到 HTTPS（选择 Yes）

# 测试自动续期
sudo certbot renew --dry-run

# 查看证书信息
sudo certbot certificates
```

### 10.2 手动续期

```bash
# 续期所有证书
sudo certbot renew

# 续期并重启 Nginx
sudo certbot renew --post-hook "systemctl reload nginx"
```

### 10.3 使用阿里云证书（可选）

1. 在阿里云 SSL 证书控制台申请证书
2. 下载 Nginx 格式证书
3. 上传到服务器：

```bash
# 创建证书目录
sudo mkdir -p /etc/nginx/ssl

# 上传证书文件（使用 scp 或其他方式）
sudo cp your-domain.com.pem /etc/nginx/ssl/
sudo cp your-domain.com.key /etc/nginx/ssl/

# 设置权限
sudo chmod 600 /etc/nginx/ssl/*

# 修改 Nginx 配置
ssl_certificate /etc/nginx/ssl/your-domain.com.pem;
ssl_certificate_key /etc/nginx/ssl/your-domain.com.key;

# 重载 Nginx
sudo systemctl reload nginx
```

---

## 十一、监控与运维

### 11.1 PM2 监控

```bash
# 查看实时状态
pm2 monit

# 查看进程详情
pm2 show stardraw-api

# 查看资源使用
pm2 list

# 查看日志
pm2 logs stardraw-api --lines 200

# 清空日志
pm2 flush
```

### 11.2 系统监控脚本

```bash
# 创建监控脚本
nano /home/stardraw/monitor.sh
```

```bash
#!/bin/bash
# monitor.sh - 系统监控脚本

LOG_FILE="/var/log/stardraw/monitor.log"
DATE=$(date '+%Y-%m-%d %H:%M:%S')

# CPU 使用率
CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print 100 - $1}')

# 内存使用率
MEM_USAGE=$(free -m | awk 'NR==2{printf "%.1f", $3*100/$2}')

# 磁盘使用率
DISK_USAGE=$(df -h / | awk 'NR==2{print $5}' | sed 's/%//')

# PM2 进程状态
PM2_STATUS=$(pm2 jlist | jq -r '.[] | select(.name=="stardraw-api") | .pm2_env.status')

# 记录日志
echo "[$DATE] CPU: ${CPU_USAGE}% | MEM: ${MEM_USAGE}% | DISK: ${DISK_USAGE}% | PM2: $PM2_STATUS" >> $LOG_FILE

# 告警阈值
if (( $(echo "$CPU_USAGE > 90" | bc -l) )); then
    echo "[$DATE] WARNING: CPU usage > 90%" >> $LOG_FILE
fi

if (( $(echo "$MEM_USAGE > 90" | bc -l) )); then
    echo "[$DATE] WARNING: Memory usage > 90%" >> $LOG_FILE
fi

if [ "$DISK_USAGE" -gt 90 ]; then
    echo "[$DATE] WARNING: Disk usage > 90%" >> $LOG_FILE
fi

if [ "$PM2_STATUS" != "online" ]; then
    echo "[$DATE] ERROR: PM2 process not online!" >> $LOG_FILE
    # 尝试重启
    pm2 restart stardraw-api
fi
```

```bash
chmod +x /home/stardraw/monitor.sh

# 添加定时任务（每 5 分钟）
crontab -e
# 添加：
*/5 * * * * /home/stardraw/monitor.sh
```

### 11.3 数据库备份

```bash
cd /opt/stardraw/server
npm run backup:postgres
```

该脚本启用 `set -euo pipefail`，直接让 PostgreSQL 16 容器生成 custom dump，先在容器内用
同版本 `pg_restore --list` 验证，再复制到 `/opt/stardraw/backups`，并生成 SHA-256 校验文件。
备份和校验文件权限均为 `0600`。不要使用没有 `pipefail` 的 `pg_dump | gzip` 作为唯一备份，
也不要在未完成异地副本与恢复演练前自动删除历史备份。

### 11.4 日志轮转

```bash
# 创建 logrotate 配置
sudo nano /etc/logrotate.d/stardraw
```

```
/var/log/stardraw/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 stardraw stardraw
    sharedscripts
    postrotate
        pm2 reloadLogs
    endscript
}
```

### 11.5 更新部署

```bash
cd /var/www/stardraw

# 拉取最新代码
git pull origin main

# 更新后端依赖
cd server
npm install --production

# 更新前端
cd ../client
npm install
npm run build

# 零停机重启
pm2 reload stardraw-api

# 验证
pm2 list
curl https://your-domain.com/health
```

---

## 十二、Docker 部署

### 12.1 安装 Docker

```bash
# 安装 Docker
curl -fsSL https://get.docker.com | sh

# 添加用户到 docker 组
sudo usermod -aG docker stardraw

# 安装 Docker Compose
sudo apt install -y docker-compose-plugin

# 验证
docker --version
docker compose version
```

### 12.2 使用 Docker Compose 部署

```bash
cd /var/www/stardraw

# 配置环境变量
cp server/.env.example server/.env
nano server/.env

cp client/.env.example client/.env.production
nano client/.env.production

# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

### 12.3 Docker 注意事项

> **重要**：Docker 环境下不建议使用 PM2，因为：
> - 容器编排工具（如 Kubernetes）已提供进程管理
> - 单容器运行多个进程违反容器化最佳实践
> - 使用 `pm2-runtime` 作为容器入口点即可

---

## 十三、成本估算

### 13.1 月度费用（按量付费）

| 服务 | 规格 | 月费用（约） | 优化建议 |
|------|------|-------------|---------|
| ECS | 2核4GB | ¥150-200 | 包年可省 30% |
| RDS PostgreSQL | 2核4GB 20GB | ¥200-300 | 内网访问节省流量 |
| OSS 存储 | 100GB | ¥10-20 | 使用内网端点免费 |
| CDN 流量 | 100GB | ¥20-30 | 开启缓存减少回源 |
| 域名 | .com | ¥50/年 | - |
| SSL 证书 | Let's Encrypt | 免费 | - |
| **合计** | - | **¥380-550/月** | - |

### 13.2 成本优化建议

1. **使用包年包月**：可节省 30-50%
2. **选择合适规格**：从最小规格开始，按需升级
3. **内网传输**：ECS、RDS、OSS 同地域，使用内网端点
4. **CDN 优化**：合理设置缓存策略，减少回源流量
5. **资源包**：购买 OSS 存储包、CDN 流量包

---

## 十四、常见问题

### Q1: PM2 进程不断重启

**原因**：可能是代码错误或内存不足

```bash
# 查看错误日志
pm2 logs stardraw-api --err

# 查看内存使用
pm2 show stardraw-api

# 调整内存限制
pm2 restart stardraw-api --max-memory-restart 300M
```

### Q2: 数据库连接失败

**检查项**：
1. RDS 白名单是否包含 ECS 内网 IP
2. 数据库用户名密码是否正确
3. 内网端点是否正确

```bash
# 测试连接
psql -h rm-xxxxx.pg.rds.aliyuncs.com -U stardraw_user -d stardraw
```

### Q3: OSS 上传失败

**检查项**：
1. AccessKey 是否正确
2. Bucket 权限设置
3. 内网端点格式

```bash
# 测试 OSS 连接
ossutil ls oss://stardraw-files/
```

### Q4: SSL 证书续期失败

```bash
# 手动续期
sudo certbot renew --force-renewal

# 检查证书状态
sudo certbot certificates

# 检查 Nginx 配置
sudo nginx -t
```

### Q5: Nginx 502 Bad Gateway

**原因**：后端服务未启动或端口不匹配

```bash
# 检查 PM2 状态
pm2 list

# 检查端口
netstat -tlnp | grep 5000

# 检查 Nginx 日志
sudo tail -f /var/log/nginx/error.log
```

---

## 附录：快速部署检查清单

### 服务器准备
- [ ] ECS 实例创建完成
- [ ] 安全组规则配置（22/80/443）
- [ ] SSH 密钥配置

### 环境安装
- [ ] Node.js 20 LTS 安装（NVM）
- [ ] PM2 全局安装
- [ ] Nginx 安装
- [ ] PostgreSQL 客户端安装

### 数据库配置
- [ ] RDS PostgreSQL 创建
- [ ] 数据库和用户创建
- [ ] 白名单配置
- [ ] 迁移脚本执行

### OSS 配置
- [ ] Bucket 创建
- [ ] RAM 用户和权限
- [ ] 内网端点配置

### 应用部署
- [ ] 代码克隆
- [ ] 环境变量配置
- [ ] 依赖安装
- [ ] 前端构建

### 服务启动
- [ ] PM2 启动和自启配置
- [ ] 日志轮转配置
- [ ] 备份脚本配置

### 网络配置
- [ ] Nginx 配置
- [ ] SSL 证书获取
- [ ] HTTPS 重定向测试

### 验证
- [ ] 健康检查通过
- [ ] API 接口测试
- [ ] 前端页面正常

---

**文档版本：** 2.0  
**更新日期：** 2026-04-12  
**参考来源：**
- [阿里云官方文档 - Node.js 部署](https://help.aliyun.com/zh/ecs/user-guide/manually-deploy-a-node-js-environment)
- [Better Stack - PM2 完整指南](https://betterstack.com/community/guides/scaling-nodejs/pm2-guide/)
- [PM2 官方文档](https://pm2.keymetrics.io/docs/usage/quick-start/)

**项目仓库：** https://github.com/rant-ha/stardraw
