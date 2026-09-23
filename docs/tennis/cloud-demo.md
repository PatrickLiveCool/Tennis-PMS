# 格林网球云端 Demo

这是单独的模拟演示环境：一个“格林网球”租户，省体校区和高新校区各 4 片球场，3 位合成会员、4 个演示登录账号。两个校区都有次日预约、课程和维护占场；余额、收付款与退款均为合成数据。后台 AI 的模型配置由平台账号在上线后填写。

真实商户支付和微信渠道尚未接入，`NODE_ENV=production` 继续拒绝模拟支付启动。本地 `tennis:demo` 保留两个租户以验证隔离；云端初始化使用独立入口，不复制本地数据库或公开固定密码。

> 本文记录旧 `tennis-demo` 首次初始化流程。已有云端数据接管到标准发布镜像时，必须改用 [首次接管方案](../operations/tennis-release-onboarding.md)，不重跑下文 seed，不删除旧容器/卷或轮换原 AI 密钥。

## 配置与部署

使用 `Dockerfile.demo` 构建固定提交的 `linux/amd64` 镜像，在本机完成构建再上传。`compose.demo.yaml` 不在服务器安装依赖或构建镜像。应用使用 384 MiB、数据库 256 MiB 内存上限，分别最多使用 512 MiB、384 MiB（包含 swap）；这些上限适用于少量演示，不是并发容量承诺。

数据库角色及库名固定 `tennis_demo`，仅容器网络可达，数据卷由独立 Compose 项目 `tennis-demo` 管理。网络 `172.30.42.0/24` 应先核对不与现有网络冲突。Nginx 在宿主机通过回环端口 4200 访问应用，应用仅信任网桥网关 `172.30.42.1` 的转发头。

将 `deploy/demo.env.example` 复制到服务器的 `/opt/tennis-demo/demo.env`，权限 0600，逐项填入生成的独立凭据。数据库密码建议使用十六进制随机串，以便安全嵌入 URL。四个演示账号密码各不相同且至少 20 字符。支付签名密钥至少 32 字符；AI 加密密钥为随机 32 字节的规范 Base64，和签名密钥分别生成。保留此加密密钥，后续重建应用也必须使用同一个值才能读取已保存的模型配置。

AI 加密密钥仅用于保护日后填写的模型凭据；未填写模型/API Key 不影响登录和业务 Demo 启动。不要把本机 AI API Key 装入镜像。

服务器需要上传固定版本镜像、PostgreSQL 16 镜像、Compose 文件与 env 文件。以下命令在 `/opt/tennis-demo` 执行，按顺序完成；迁移及初始化失败时不要启动应用：

```bash
docker compose --env-file demo.env -f compose.demo.yaml up -d --wait postgres
docker compose --env-file demo.env -f compose.demo.yaml --profile bootstrap run --rm migrate
docker compose --env-file demo.env -f compose.demo.yaml --profile bootstrap run --rm seed
docker compose --env-file demo.env -f compose.demo.yaml up -d --wait app
curl --fail http://127.0.0.1:4200/health
curl --fail http://127.0.0.1:4200/version
```

初始化同时检查环境变量、实际数据库名/角色和空库状态。所有合成业务数据位于一个事务内；中途失败全部回滚。成功后保存初始化 manifest，重复执行只核对既有身份和场地，不重置密码、余额或客户试用数据。`cloud_demo_initializations` 是专用于 Demo 的状态表，不加入正式业务迁移基线。

四个账号分别为 `demo.platform`（平台与 AI 配置）、`demo.green`（租户管理员）、`demo.staff`（前台）、`demo.customer`（客户）。云端密码由部署时生成的私有 env 提供；公开本地固定密码禁止用于此入口。

## 域名与 HTTPS

用户负责把 `tennis.qintopia.cn` 的 A 记录指向 `122.51.77.220`。先创建只提供 `/.well-known/acme-challenge/` 的 HTTP 站点，再通过既有 Certbot 账户签发证书；DNS 未生效时不发布应用。

证书就绪后安装 `deploy/nginx-tennis-demo.conf`。先备份现有目标文件，执行 `nginx -t` 通过后再 reload。该站点不覆盖住房 `pms.qintopia.cn`。Nginx 必须覆盖 `X-Forwarded-For` 为 `$remote_addr`，不能原样信任外部传入的 XFF。应用 Cookie 为 Secure、HttpOnly、SameSite=Strict，仅在 HTTPS 下使用。

证书采用 webroot `/var/www/letsencrypt`；保留 challenge 路由，并安装 Certbot deploy hook，在续期后通过 `nginx -t` 再 reload Nginx。不要重启共享 Nginx 来替代配置检查。

## 上线验证与恢复

上线时验证公网 `/health`、`/version`、页面和静态资源；平台/管理员/前台/客户登录；一个租户、两个校区、8 片球场；跨校区查看会员余额；新建模拟预约、钱包支付及退款。确认模型未配置时可登录，AI 配置入口可用；由用户自行填写模型配置后再进行其授权的真实联调。

同时复查住房 PMS 与主站仍可访问，查看新容器健康、实际内存和日志，核对无 OOM。小量受控 Demo 不要求先启用完整 COS/GitHub 自动发布流水线；源码仍应按项目约定通过 PR 合入。

本环境尚无对外可用的历史版本时，启动失败保留数据卷和日志，停止新应用并恢复此域名的维护响应。已存在健康版本时，保留旧镜像与 env；仅当迁移基线兼容才切回旧镜像。不能把删除数据卷当作回退，也不执行全机 Docker prune。升级前先备份专用 Demo 数据库；任何数据库恢复需明确核对数据损失范围。
