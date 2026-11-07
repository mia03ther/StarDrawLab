# StarDraw 本地开发（2026年10月30日更新）

源码在 `D:\StarDrawLab`。前端 http://127.0.0.1:5173/；API健康 http://127.0.0.1:5000/health；数据库就绪 http://127.0.0.1:5000/ready。这些地址只在本机访问，尚未发布公网测试站。

双击同目录的 `开启本地后端.cmd` 启动数据库、测试登录、模拟接口、API、任务Worker和前端；已运行服务会复用。也可执行：

```powershell
cd D:\StarDrawLab\server
npm.cmd run dev:local
```

前端源文件在 `client/src`，保存即可热更新。前端配置在项目根 `.env.local`，后端在 `server/.env`。Vite设置了envDir，因此不要把前端配置放到client/.env。启动日志在 `.local/logs`。

打开前端后点击进入，在本地测试登录页选择“以本地测试账号继续”。测试身份为 `local_dev_admin`，仍使用PKCE及签名令牌，权限由开发数据库决定。图片和文字回复是有明确标识的模拟；初始100000积分仅为测试数据，重复启动不会补回已消费积分。

数据库只监听127.0.0.1:54329，库名stardraw_local。测试身份服务使用4300，模拟接口使用4311，API使用5000。数据库、随机开发凭据、签名私钥、本地生成文件和日志都在 `.local`，已被Git忽略；真实线上用户记录、生产数据库连接及OSS密钥没有复制进来。

已验证：后端health/ready均200；签名登录、无令牌401拒绝、角色、积分与模型读取正常；一次模拟图片生成完成，并实际写入本地文件、扣除1个测试积分。前端88项测试及开发环境20项测试全部通过，前端构建通过。

```powershell
cd D:\StarDrawLab\server
npm.cmd run test:local
```

当前未接真实模型、生产OSS和支付。视频没有可播放测试样例，路由默认停用，不伪报成功；大文件磁盘暂存上传、视频截图和复杂Agent自动编排尚未支持。生产403等业务Bug没有因配置完成而自动修复，本次未上线。

本地分支为local-dev/20261028。服务器源码快照提交68f329f，标签backup/server-source-20261028；Windows测试路径修复e0a5c3f。原main历史保留，没有推送远程仓库。原始备份为同目录stardraw-server-original-20261028.tar.gz，779个归档文件逐项校验通过。schema-only SQL不含用户数据，也不等于完整数据库备份。

后续真实联调应另行配置测试模型、测试OSS及身份应用，不能把这套本地.env替换线上环境。详情见同目录《StarDraw改进与数据影响说明-20261030.md》。

PostgreSQL16便携运行时来自[官方Windows下载说明推荐的EDB二进制包](https://www.postgresql.org/download/windows/)，未注册Windows系统服务。
