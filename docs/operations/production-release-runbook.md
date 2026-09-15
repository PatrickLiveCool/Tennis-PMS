# GreenPMS 生产发布与恢复 Runbook

本文描述仓库内已经实现的发布 harness。真实 COS、服务器安装和 GitHub Secrets 尚未配置，生产首发和生产验收尚未执行。首次实施范围需明确授权，可以在一个初始化窗口统一确认；下文命令是操作指南，不是已执行记录。

快速操作入口见 [生产发布快速开始](production-release-quickstart.md)。

## 1. 目标流程

```text
业务 PR 合并到 main
  -> Release Please 创建/更新版本 PR
  -> 合并版本 PR，自动创建精确 vX.Y.Z tag 和 Draft Release
  -> 发布非 Draft、非 Pre-release 的 GitHub Release
  -> release.published 触发 GreenPMS Release
  -> npm ci / release check / typecheck / test / build
  -> 干净 checkout 构建 linux/amd64 镜像并扫描
  -> Docker archive + zstd + manifest + SHA256SUMS + SPDX SBOM
  -> COS 不可覆盖上传并回读校验
  -> 受限 SSH -> 服务器临时下载、校验、docker load、Compose 切换
  -> Docker health + 本地 ready/version + 公网 ready/version
  -> state.json 提交 current/previous/rollbackFrom，返回健康回执
  -> Actions 使用 upload credentials 写 deployed.json
  -> retention 保留最近 5 个成功版本，服务器清理旧 image ID
```

GitHub Release 的 **Publish release** 是批准动作。只有一个 `production` Environment，允许 `main` 和 `v*`，不配置 reviewer 或 wait timer，因此 workflow 不会再暂停等待第二次批准。release、rollback 和定时 retention 共用 `greenpms-production` concurrency，避免上传、切换和清理并行破坏状态。

Release job 使用两个独立 checkout：`validate` 从受保护 `main` 解析并固定一个 harness commit，目标 tag 提供不可变应用源码。版本、构建上下文和 OCI revision 都从 tag 目录校验；后续 job 的打包、COS 和 SSH 编排脚本都 checkout 同一个 harness commit。这样修复发布基础设施后可以重放旧 tag，而不会修改旧 tag、读取运行中变化的 `main`，或把 `main` 的应用代码混入旧版本镜像。打包前会一次检查 COS、retention 和受限 SSH 的必需 Variables/Secrets，只输出缺少的配置名称，不输出任何值。

修复 harness 后必须从 Actions 页面用 **Run workflow** 创建新的手动重放。旧失败 run 的 **Re-run jobs** 固定使用旧 workflow 内容，不会读取刚合并到 `main` 的修复。

管理员负责一次性 bootstrap 和故障入口；发布人负责审核并合并 Release Please 版本 PR、发布 GitHub Release、观察 workflow 和执行 GitHub Actions 回退。GitHub Release 的 **Publish release**（`release.published`）是唯一批准点。

## 2. 发布身份和产物

Release Please 创建的 tag 必须严格匹配 `vX.Y.Z`，并指向 `main` 历史中的提交。Actions 同时核对 tag、package/lock、Release Please 生成的 `CHANGELOG` 条目和 `deploy/release-policy.json`。服务器不从 Git checkout 构建，生产 Compose 只接受明确的预构建 `GREENPMS_IMAGE`，固定容器名是 `qintopia-pms-app` 和 `qintopia-pms-wecom-worker`，Compose 项目名是 `green-pms`。

镜像使用不可变本地 tag：

```text
greenpms:vX.Y.Z-<40 位 Git revision>
```

镜像写入以下 OCI labels：version、完整 revision、source 和创建时间。manifest 同时记录 image identity、archive SHA-256、SBOM SHA-256、平台、迁移 baseline 和回退兼容性。服务器请求中的 manifest SHA 是外部校验锚点，不能只相信同一个下载包里的 checksum。

GitHub 不保存二进制构建产物：不使用 GHCR、`upload-artifact`、GitHub Release 附件或远端 BuildKit cache。runner 上的 archive、临时目录和 BuildKit cache 在 job 结束时清理；COS 是唯一长期构建产物存储。

## 3. COS 结构和权限

每个版本使用包含语义版本和完整 revision 的不可变前缀：

```text
greenpms/releases/vX.Y.Z/<40 位 revision>/
  greenpms-linux-amd64.docker.tar.zst
  manifest.json
  SHA256SUMS
  sbom.spdx.json
  deployed.json
```

`deployed.json` 只有服务器健康回执已经通过后才会创建。上传使用禁止覆盖语义；重试只接受内容完全相同的已有对象，不能覆盖不同内容。

创建 [setup.py](../../scripts/release/setup.py) 生成的三份 policy，并分别绑定三个 CAM 子用户：

| 身份 | 权限 | 用途 |
| --- | --- | --- |
| upload | release 对象的 `PutObject`、`GetObject`、`HeadObject`，以及受限 List 和版本控制状态读取 | 上传、回读四种产物，并写 `deployed.json` |
| retention | 成功判断所需的 release 对象读取、受限 List、版本控制状态读取和 `DeleteObject` | 唯一允许删除完整 release 前缀的身份 |
| reader | 四种构建产物的 `GetObject` | 服务器只读下载；无写入和删除 |

marker 是 orchestrator 的逻辑角色，使用 upload CAM 身份的 credentials；实际 CAM 身份仍只有 upload、retention、reader 三个，没有 `cam-marker.json`、marker 子用户或第四份 secret。retention 是唯一拥有 `DeleteObject` 的身份。

upload 与 marker 共用同一 CAM 身份；健康标记仍由受信仓库 workflow、服务器健康 receipt 和逻辑 MARKER client 共同门禁。

所有对象 resource 限制到：

```text
qcs::cos:<region>:uid/<appid>:<bucket>/greenpms/releases/*
```

List 使用 bucket resource 时必须带 `greenpms%2Freleases%2F` 的 prefix condition。不要授予其他桶、数据库备份、TencentDB 或其他项目权限。COS 桶必须是私有、TLS、服务端加密，并且从未启用版本控制；`Enabled` 和 `Suspended` 都拒绝，因为 delete marker 和历史 object version 会破坏当前的不可变/删除假设。Lifecycle 只用于终止过期未完成分片上传，不能代替数量 retention。

可选 `COS_ENDPOINT` 仅接受已允许的腾讯云 endpoint。使用 `cos.accelerate.myqcloud.com` 前必须先为桶开启全局加速；不设置时使用地域默认 endpoint。

## 4. 成功版本 retention

成功版本只统计同时满足以下条件的前缀：

- 版本和 revision 路径严格合法。
- archive、manifest、checksum、SBOM 和 `deployed.json` 全部存在。
- manifest、SHA-256、image identity、版本和 revision 互相绑定且有效。
- `deployed.json` 的版本、revision、imageId 和 manifest SHA 与 manifest 一致。

按 `deployed.json.deployedAt` 从早到晚排序，默认保留最新 5 个成功版本。超过 5 个时循环删除最早的安全版本；首次运行如果已有超过 5 个，也继续循环直到剩余 5 个。当前 `current`、`previous` 和 `rollbackFrom` 对应的 COS 前缀始终保护，所以被保护版本可能让实际数量暂时超过 5。删除按完整版本前缀逐个对象执行，marker 最后删除；任何删除失败都会进入失败结果，不能报告为完全成功。

无 `deployed.json` 的上传候选不计入 5 个成功版本。候选只有在整个候选对象集合都超过默认 7 天时才可作为过期候选删除；未知对象、缺失对象、损坏 manifest 或不完整成功状态不会计入成功版本。可验证但缺少 payload 的 marker 会进入 partial 清理分支，其他异常状态跳过并记录原因，不能误判为成功版本。

Retention 支持 `dry-run`，输出保留、保护、跳过、候选和待删除前缀但不修改 COS 或服务器。正式 retention 与部署共用 Actions concurrency 和服务器部署锁。删除失败不回退已经健康运行的新版本；重试 maintenance 即可，监控应发现 `deleteFailures`。

本地镜像按 image ID 去重，而不是按 semantic、commit、`latest` 或 `pre-*` 标签计数。只处理 GreenPMS 自己的标签；当前、previous 和任意容器引用都保护。不能删除的共享 image ID 保留并报告。绝不运行 `docker system prune` 或 `docker image prune -a`，绝不删除 volumes、TencentDB、数据库备份、其他项目镜像或容器。

## 5. 服务器切换和状态

服务器受限入口只接受已验证的版本、40 位 revision、固定 `greenpms/releases/` key 和 manifest SHA。SSH key 使用 `restrict`，固定 known_hosts，禁止 TTY、转发、任意 shell 和任意 Docker 命令。root-owned sudo wrapper 只允许 deploy、rollback 和 maintenance 固定入口；adopt、recover、`rollback-local` 和 `configure-ai` 只可由管理员本地执行。

一次部署持有 flock，并按以下顺序执行：

1. 读取并记录当前容器 image ID、state 和部署审计信息。
2. 在专用临时目录下载 archive、manifest、checksum 和 SBOM。
3. 先校验对象 SHA-256、manifest 身份、平台、OCI identity 和 SBOM，再执行 `docker load`。
4. 用不可变的版本/revision 镜像 tag 设置 `GREENPMS_IMAGE`，启动固定的 `green-pms` Compose 项目，同时切换 `qintopia-pms-app` 和 `qintopia-pms-wecom-worker`。
5. 等待 app Docker healthcheck，确认 worker 正在运行且使用同一个目标 image ID，并检查本地 `/health/ready`、`/api/v1/version` 以及两个公网健康地址。公网 version 必须与 manifest 版本一致。
6. 将新版本写入 `current`，部署前版本写入 `previous`；回退操作额外记录 `rollbackFrom`。manifest 的 `imageId` 是 Docker archive config digest；state 中的 `runtimeImageId` 是目标 Docker daemon 导入后实际引用的本地 ID。不同 image store 可能使用不同的本地 ID，因此容器切换和清理使用 `runtimeImageId`，归档完整性使用 `imageId`、archive SHA、OCI labels 和 rootfs diff IDs 共同校验。state 写入采用临时文件加原子替换，配置 hash 绑定 Compose 和外部 app.env。
7. 在锁仍保持期间返回健康 receipt。Actions 校验 receipt 后写入 `deployed.json`，运行 retention，最后让服务器根据 receipt 清理旧 image ID。
8. 所有成功和失败路径通过 trap 删除 archive、解压内容和下载临时目录。异常中断留下 transaction journal，由 recovery timer 在下一次持锁恢复。

服务器只保留当前运行 image 和一个快速回退 image，具体按唯一 image ID 判断。app 与 worker 必须引用同一个 current image；任一容器仍引用旧 image 时清理会拒绝删除。生产 `.env`、COS reader credentials、state、audit 和数据库仍在 release 外部；生产服务器不保存源码构建目录、镜像 archive 或 BuildKit cache。

## 6. 回退

### GitHub Actions 回退

`.github/workflows/rollback.yml` 只在 `main` 上手工运行，输入 `version` 必填，`revision` 只在同一版本存在歧义时填写。`orchestrate.py rollback-release` 会列举 GreenPMS release 前缀，并且只接受一份完整、checksum 正确、有有效 `deployed.json` 的成功版本；没有 marker 的候选、上传不完整的版本和损坏版本一律不能成为回退目标。

如果目标是已登记的 `previous`，服务器可复用本地镜像；更早目标由服务器从 COS 下载并通过同一套 bundle 校验后载入。整个过程仍执行版本、image identity、迁移兼容性、Docker health 和本地/公网 ready/version 门禁。成功后 marker 保持不可变，回退时间写入服务器 audit。

### 管理员应急入口

`rollback-local` 只使用 state 中登记的 previous，不访问 COS，不执行 retention。`recover` 用于处理 transaction journal；不能直接编辑 `state.json` 绕过锁或迁移检查。两者只在故障调查和明确授权后使用，日常回退应走 GitHub Actions。

## 7. 迁移兼容性

本流程不会自动执行数据库迁移。外部数据库是 TencentDB，不是部署清理对象。服务 readiness 要求完整迁移文件集合和哈希与当前基线匹配；manifest 的 `requiredMigrations` 和 `rollbackCompatibility` 也会参与门禁。

向前部署只允许在已核对的运行迁移基线与目标 manifest 完全相同时切换镜像。直接回退还要求当前和目标镜像都是 `same-migrations-only`；任一侧是 `forward-only` 就拒绝回退。缺失 baseline、文件名/哈希不一致或外部配置 hash 变化，都必须在切换前拒绝。保留旧镜像不等于数据库可以回退；需要前向修复、停写、备份恢复或数据库 owner 操作时，另开经过授权的迁移/恢复方案，不能把 owner credentials 给 GitHub Actions。

首次接管时必须先核对旧容器的精确 image ID、tag/revision、API 版本和容器内迁移文件哈希，使用附录 B 的 `migration-baseline.mjs` 只读生成 baseline。不能用 `latest`、缺失 labels 或仓库当前版本猜测旧镜像身份。

## 8. 失败处理

| 失败位置 | 自动结果 |
| --- | --- |
| tag、版本资料、测试或 build 失败 | 不上传、不连接生产、不部署 |
| COS 上传或回读失败 | workflow 失败，不启动服务器部署 |
| 下载、checksum、manifest、platform、SBOM 或 image identity 失败 | 不执行 `docker load`，删除临时文件，旧容器不变 |
| Compose 启动或健康检查失败 | 尽力恢复部署前容器；不写 `deployed.json`，不执行成功 retention |
| 恢复也失败 | 保留 journal 和故障证据，停止清理，管理员运行 recover |
| Actions 在健康 receipt 后失败 | 新容器保持健康；marker/retention 可通过重跑或 maintenance 幂等恢复 |
| COS 删除部分失败 | 新容器保持运行，报告删除失败，不强制回退 |
| 进程被 SIGKILL 或主机断电 | trap 可能无法执行；下一次 recovery timer 清理专用临时目录并按 journal 恢复 |

日志只输出版本、revision、前缀和状态等必要证据，不输出 COS credentials、SSH private key、数据库 URL、应用 env、STS token 或任何密码。若排障发现凭据疑似暴露，在明确授权的窗口内轮换，并从干净 checkout 重新构建和核验镜像；旧镜像的应急使用也需包含在授权范围内。

## 附录 A：一次性安装

以下命令是管理员在明确授权后执行的一次性 bootstrap，不是日常发布命令。管理员在本地 GreenPMS checkout 执行，并使用一个已有的管理员 SSH key。GitHub Actions 只使用一把专用 deploy key。

操作前将占位符替换为现场值：`$ADMIN_KEY` 是管理员私钥路径（例如 `$HOME/.ssh/<admin-key>`）；`$DEPLOY_KEY` 是唯一 deploy 私钥路径（例如 `$HOME/.ssh/greenpms-actions-deploy`）；`$ADMIN_ALIAS` 是管理员 SSH alias；`$REMOTE_STAGE` 是服务器临时目录；`$REMOTE_SETUP` 是服务器上的 root-owned 安装目录；`$LEGACY_CHECKOUT` 是服务器上旧 checkout 的绝对路径。以下 shell 片段假定这些变量已在管理员本地 shell 中设置。

先审核合并本分支，再从包含这些改动的干净 main checkout 打包。`git archive HEAD` 只包含已提交内容；不要从旧 tag 或尚未提交的工作区安装。

### A.1 生成 key、核验 host key、打包 harness

如果 `$DEPLOY_KEY` 或对应 `.pub` 已存在，先核验并复用，禁止覆盖；只有两个文件都不存在时才执行下面的 `ssh-keygen`，整个项目只生成一次这把 key。

```bash
rtk proxy ssh-keygen -t ed25519 -N '' \
  -C greenpms-actions-deploy \
  -f "$DEPLOY_KEY"
rtk git archive --format=tar.gz \
  --output=/tmp/greenpms-harness.tar.gz \
  HEAD deploy scripts/release compose.server.yaml
```

先通过腾讯云控制台或既有可信管理员通道核对服务器 host key。完成核对后，创建本地 SSH 配置别名；不要关闭 host key 检查：

```sshconfig
Host greenpms-admin
    HostName YOUR_SERVER_HOST
    User YOUR_ADMIN_USER
    IdentityFile ~/.ssh/<admin-key>
    IdentitiesOnly yes
    StrictHostKeyChecking yes
```

通过已经核验的管理员连接读取 host public key，并生成给 GitHub Secret 使用的完整 `known_hosts` 行。`YOUR_SERVER_HOST` 必须与 `DEPLOY_HOST` 完全一致；不要用未经人工核对的 `ssh-keyscan` 输出替代它：

```bash
rtk proxy ssh "$ADMIN_ALIAS" 'cat /etc/ssh/ssh_host_ed25519_key.pub' \
  > /tmp/greenpms-host-key.pub
rtk proxy awk -v host=YOUR_SERVER_HOST \
  '{print host, $1, $2}' /tmp/greenpms-host-key.pub \
  > /tmp/greenpms-known_hosts
```

将 `/tmp/greenpms-known_hosts` 的整行内容填入 GitHub `DEPLOY_KNOWN_HOSTS`；它应是 `主机 ssh-ed25519 BASE64_PUBLIC_KEY`，不是只填 fingerprint。该文件不是私钥，但必须保留为单行并与 `DEPLOY_HOST` 相同。

验证管理员连接：

```bash
rtk proxy ssh "$ADMIN_ALIAS" 'true'
```

### A.2 安装 root-owned 入口

把 archive 和 deploy 公钥传到服务器，随后只安装 harness。服务器已有 Docker/Compose v2 时，只需补 Python venv 和 zstd；安装器会自行检查依赖、sshd 有效配置、sudoers 和文件所有权。

```bash
rtk proxy ssh "$ADMIN_ALIAS" "install -d -m 0700 '$REMOTE_STAGE'"
rtk proxy scp /tmp/greenpms-harness.tar.gz \
  "$ADMIN_ALIAS:$REMOTE_STAGE/greenpms-harness.tar.gz"
rtk proxy scp "$DEPLOY_KEY.pub" \
  "$ADMIN_ALIAS:$REMOTE_STAGE/greenpms-deploy.pub"
rtk proxy ssh "$ADMIN_ALIAS" "sudo install -d -m 0700 '$REMOTE_SETUP'"
rtk proxy ssh "$ADMIN_ALIAS" "sudo tar -xzf '$REMOTE_STAGE/greenpms-harness.tar.gz' -C '$REMOTE_SETUP'"
rtk proxy ssh "$ADMIN_ALIAS" "sudo install -m 0644 '$REMOTE_STAGE/greenpms-deploy.pub' '$REMOTE_SETUP/deploy.pub'"
rtk proxy ssh "$ADMIN_ALIAS" 'sudo apt-get update && sudo apt-get install -y python3-venv zstd'
rtk proxy ssh "$ADMIN_ALIAS" \
  "sudo bash '$REMOTE_SETUP/deploy/install.sh' --deploy-public-key '$REMOTE_SETUP/deploy.pub'"
```

`deploy/install.sh` 创建 `greenpms-deploy`、root-owned forced-command key、固定 sudo wrapper、独立 Python venv、Compose 副本、recovery service/timer 和 logrotate 配置。它不启动应用、不执行 Docker build/load、不执行 adoption、不启用 timer、不修改数据库，也不修改或重载 sshd。安装器不能被部署用户自己改写；如果已有受管文件内容不同，会停止并要求管理员复核。

确认以下结果后再继续：

- `/home/greenpms-deploy/.ssh/authorized_keys` 只有一把 `restrict` deploy key，用户不能修改。
- 部署用户不在 `docker` 或 `sudo` 组，不能获得交互 shell、转发或任意 Docker 命令。
- `/opt/greenpms-release`、`/etc/greenpms`、`/var/lib/greenpms-release` 和入口文件由 root 控制。
- `greenpms-release-recovery.timer` 此时仍未启用。

### A.3 安装外部配置

从第 1 步生成 `deploy.json` 后传到服务器。不要把应用 `.env` 或 reader secret 放进 archive、镜像或 GitHub。

```bash
rtk proxy scp /tmp/greenpms-onboarding/deploy.json \
  "$ADMIN_ALIAS:$REMOTE_STAGE/greenpms-deploy.json"
rtk proxy ssh "$ADMIN_ALIAS" \
  "sudo test ! -e /etc/greenpms/deploy.json && sudo install -m 0600 '$REMOTE_STAGE/greenpms-deploy.json' /etc/greenpms/deploy.json"
rtk proxy ssh "$ADMIN_ALIAS" \
  "sudo test ! -e /etc/greenpms/app.env && sudo install -m 0600 '$LEGACY_CHECKOUT/.env' /etc/greenpms/app.env"
rtk proxy ssh "$ADMIN_ALIAS" \
  'sudo test ! -e /etc/greenpms/cos-readonly.json && sudo install -m 0600 /dev/null /etc/greenpms/cos-readonly.json'
rtk proxy ssh -t "$ADMIN_ALIAS" 'sudoedit /etc/greenpms/cos-readonly.json'
```

`cos-readonly.json` 使用下面的 JSON 结构；没有 STS 时省略 `COS_TOKEN`，使用短期 STS 时才增加该字段：

```json
{
  "COS_SECRET_ID": "READER_SECRET_ID",
  "COS_SECRET_KEY": "READER_SECRET_KEY",
  "COS_TOKEN": "OPTIONAL_READER_STS_TOKEN"
}
```

`app.env` 继续使用现有生产配置；先确认来源是当前配置，再执行复制命令。不要在终端、日志或聊天中输出配置内容。确认 `SEED_DEMO_DATA=false`、`IMPORT_2026_REFERENCE_CATALOG=false`，数据库仍指向外部 TencentDB。

同一个 root-owned `app.env` 还必须保存 `PMS_WECOM_SOURCE_ID`、`PMS_WECOM_CORP_ID`、`PMS_WECOM_APP_SECRET` 和 `PMS_WECOM_WORKER_DATABASE_URL`。生产 Compose 固定启用同步 worker，并且只把这四项注入 worker；Web app 不接收企业微信 secret 或 worker 数据库账号。缺少任一项时 Compose 必须在切换容器前失败。

### A.4 核对当前状态并启用恢复

以下只读命令用于记录旧容器的精确身份；它们不读取应用 secret：

```bash
rtk proxy ssh "$ADMIN_ALIAS" "git -C '$LEGACY_CHECKOUT' rev-parse HEAD"
rtk proxy ssh "$ADMIN_ALIAS" "git -C '$LEGACY_CHECKOUT' describe --tags --exact-match HEAD"
rtk proxy ssh "$ADMIN_ALIAS" 'sudo docker inspect --format "{{.Image}}" qintopia-pms-app'
rtk proxy ssh "$ADMIN_ALIAS" 'curl --fail --silent http://127.0.0.1:4100/api/v1/version'
rtk proxy ssh "$ADMIN_ALIAS" 'curl --fail --silent http://127.0.0.1:4100/health/ready'
```

将输出保存为 `OLD_TAG`、`OLD_REVISION`、`OLD_IMAGE_ID`，并以真实输出替换下面命令中的占位符。旧镜像可能没有有效 OCI labels，不能据此猜测身份。

## 附录 B：初次 adoption 和迁移 baseline

确认旧 tag 对应的 Git revision 后，在本地干净 checkout 生成 Git baseline；再从运行容器读取相同 SQL 文件的名字和 SHA-256。脚本只读取文件，不执行 SQL：

```bash
rtk git rev-parse 'OLD_TAG^{commit}'
rtk proxy test "$(rtk proxy git rev-parse 'OLD_TAG^{commit}')" = "OLD_REVISION"
rtk proxy node scripts/release/migration-baseline.mjs \
  --git OLD_REVISION > /tmp/greenpms-old-git-migrations.json
rtk proxy ssh "$ADMIN_ALIAS" \
  'sudo docker exec -i qintopia-pms-app node --input-type=module - --image' \
  < scripts/release/migration-baseline.mjs \
  > /tmp/greenpms-old-image-migrations.json
rtk proxy diff -u \
  /tmp/greenpms-old-git-migrations.json \
  /tmp/greenpms-old-image-migrations.json
```

`diff` 必须无输出。若不一致，停止接入并查明旧镜像来源；不要用当前仓库 baseline 覆盖运行镜像事实。将已核实的 image baseline 传入 root-owned 配置并执行一次 adoption：

```bash
rtk proxy scp /tmp/greenpms-old-image-migrations.json \
  "$ADMIN_ALIAS:$REMOTE_STAGE/greenpms-migrations.json"
rtk proxy ssh "$ADMIN_ALIAS" \
  "sudo install -m 0600 '$REMOTE_STAGE/greenpms-migrations.json' /etc/greenpms/verified-migrations.json"
rtk proxy ssh "$ADMIN_ALIAS" \
  'sudo /usr/local/sbin/greenpms-deploy adopt OLD_TAG OLD_REVISION OLD_IMAGE_ID /etc/greenpms/verified-migrations.json'
rtk proxy ssh "$ADMIN_ALIAS" \
  'sudo systemctl enable --now greenpms-release-recovery.timer'
```

`adopt` 只登记当前容器为 `current`，不替换镜像、不迁移数据库、不创建 COS marker。成功后应看到 current 是旧版本、previous 为空，并且本地/公网健康检查通过。之后应用和 harness 配置若发生变化，自动发布会因 configuration hash 不匹配而停止，需要管理员在变更窗口重新核对，不能直接改 state 绕过。

## 附录 C：GitHub 和首发检查

在 GitHub Settings → Secrets and variables → Actions 中配置：

| 类型 | 名称 |
| --- | --- |
| Variable | `COS_BUCKET` |
| Variable | `COS_REGION` |
| Variable | `DEPLOY_HOST` |
| Variable | `DEPLOY_USER` |
| Variable（可选） | `COS_ENDPOINT` |
| Secret | `UPLOAD_COS_SECRET_ID` |
| Secret | `UPLOAD_COS_SECRET_KEY` |
| Secret | `RETENTION_COS_SECRET_ID` |
| Secret | `RETENTION_COS_SECRET_KEY` |
| Secret | `DEPLOY_SSH_KEY` |
| Secret | `DEPLOY_KNOWN_HOSTS` |
| Secret（可选） | `UPLOAD_COS_TOKEN` |
| Secret（可选） | `RETENTION_COS_TOKEN` |

另外，在 Repository secrets（不是 `production` Environment）配置 `RELEASE_PLEASE_TOKEN`。它是只用于 Release Please 创建版本 PR 和触发 PR CI 的本仓库 Fine-grained PAT，权限为本仓库 Contents read/write、Pull requests read/write；不包含 COS、SSH、数据库或其他仓库权限。

只创建 `production` Environment，允许 tag `v*` 和 branch `main`，不设置 reviewers/wait timer。Environment 的 branch/tag 限制不是身份授权的替代品；CAM policy 仍必须只允许 GreenPMS 前缀。

首次真实发布前完成：

1. `rtk npm run test:release`、`rtk npm run release:check`、`rtk npm run typecheck`、`rtk npm test` 和 `rtk npm run build`。
2. GitHub Retention 在 `main` 上以 `dry_run=true` 运行，确认只列出 GreenPMS 前缀且保护 current/previous。
3. 若初始化检查发现凭据需要轮换或旧镜像来源不明，将其纳入授权窗口，按组织流程轮换凭据并从干净 checkout 重建和核验镜像；清理源码、临时 build 目录、归档和 BuildKit cache 时逐项确认归属，绝不全局 prune。
4. 合并 Release Please 生成的版本 PR，确认它创建了新的未发布严格版本 tag 和 Draft GitHub Release；发布该 Release。Publish 是批准动作，之后不再等待 Environment 审批。
5. 首发通过后人工检查公网 ready/version、登录和房态读取、Docker health、COS marker、retention 结果和服务器 audit。人工验收通过前，状态只记为“工程完成，待生产验收”。

## 附录 D：故障入口和验证

管理员只在自动恢复失败或需要核对现场时使用：

```bash
rtk proxy ssh "$ADMIN_ALIAS" \
  'sudo systemctl status greenpms-release-recovery.timer --no-pager'
rtk proxy ssh "$ADMIN_ALIAS" \
  'sudo journalctl -u greenpms-release-recovery.service -n 50 --no-pager'
rtk proxy ssh "$ADMIN_ALIAS" \
  'sudo /usr/local/sbin/greenpms-deploy recover'
rtk proxy ssh "$ADMIN_ALIAS" \
  'sudo /usr/local/sbin/greenpms-deploy rollback-local'
```

`recover` 处理未完成 transaction journal；`rollback-local` 使用已登记的 previous。两者都不能绕过迁移兼容性、配置 hash、镜像引用和健康检查。优先使用 GitHub Rollback workflow，因为它会先从 COS 解析完整成功版本并保留审计。

本地 fake harness 验证 COS、Docker、SSH 接口和失败场景；它不替代目标服务器的 sshd、sudo、Docker Compose 和一次真实 COS/CAM 现场验收。残余风险包括：拥有服务器管理员 Docker 权限的人仍可绕过此入口；archive 禁止文件扫描不是对所有未知秘密的数学证明；保留镜像不提供数据库回退能力；真实网络 endpoint、CAM 条件和腾讯云套餐需要现场确认。

官方契约参考：[COS 禁止覆盖上传](https://cloud.tencent.com/document/product/436/7749)、[COS 版本控制](https://cloud.tencent.com/document/product/436/19889)、[COS List 前缀权限](https://cloud.tencent.com/document/product/436/71307)、[GitHub Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)。

## AI 密钥保护初始化

既有实例缺少 AI 加密配置时，使用管理员 `configure-ai` 事务入口，操作和恢复见 [AI 助手部署说明](ai-assistant.md#既有生产实例补齐密钥保护)。该入口只处理 AI 密钥初始化，不接受任意配置覆盖或密钥轮换；现有配置 hash 防护仍生效。
