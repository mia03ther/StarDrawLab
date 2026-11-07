# 容器入口韧性与健康检查

本文说明 Web/API/Worker 的容器级健康信号和日志边界。配置变更本身不会修改生产
容器；只有构建新镜像并执行部署后才会生效。

## Nginx 与 Docker DNS

Web 镜像使用 Nginx 1.27。`client/nginx.conf` 在 HTTP 上下文配置 Docker DNS：

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
upstream stardraw_api {
    zone stardraw_api 64k;
    server api:5000 resolve;
}
```

共享 zone 让 Nginx Worker 能定期刷新 Compose 服务 `api` 的地址。API 容器被替换、
Docker 分配新 IP 后，Web 不应再长期保留旧地址。不要把 `api` 改成固定容器 IP。

端点语义：

- `/health`：API 进程存活；
- `/ready`：API 与必要基础设施已就绪，直接代理服务端真实 `/ready`；
- `/nginx-health`：只检查 Nginx，本机地址以外的请求返回 403。

由于真实 `/ready` 可能包含数据库 capability 等运维信息，公网入口应限制该路径，
只允许负载均衡器或受信监控系统访问。

## Worker 文件心跳

Worker 不提供 HTTP 服务。启动任务循环后，它原子更新
`/app/tmp/worker-health.json`；Compose 在同一容器内执行：

```bash
node workerHealthcheck.js
```

可配置项位于 `server/.env`：

```env
WORKER_HEALTH_FILE=/app/tmp/worker-health.json
WORKER_HEALTH_INTERVAL_MS=15000
WORKER_HEALTH_STALE_MS=60000
```

`WORKER_HEALTH_STALE_MS` 应显著大于写入间隔。健康文件只包含 PID、时间戳、Worker
ID、队列名、发布号和运行状态，不写数据库连接串、任务 payload 或供应商凭据。

## 日志隔离与轮转

- API 文件日志：`api_logs` 卷中的 `/app/logs/api`；
- Worker 文件日志：`worker_logs` 卷中的 `/app/logs/worker`；
- 三个服务的标准输出：Docker `json-file`，单文件 10 MiB，保留 5 个文件。

API 原有 `api_logs` 卷改挂到 API 专属目录，因此卷内历史文件不会因配置变更被删除。
Worker 使用新卷，避免两个 Winston 进程争用相同的 `app.log` 和 `error.log`。

## 不连接数据库的验证

```bash
cd /opt/stardraw
docker compose config --quiet

docker run --rm --entrypoint nginx \
  -v /opt/stardraw/client/nginx.conf:/etc/nginx/conf.d/default.conf:ro \
  all.nxfl.cc/nginx:1.27-alpine -t

cd /opt/stardraw/server
node --test tests/workerHealth.test.js
```

上述 Nginx 命令只启动临时校验容器并只读挂载配置，不会重启或修改生产容器。
