# Tennis-Green-PMS 生产发布快速开始

> 当前状态：Tennis 专用 release、retention、rollback 已在 `.github/workflows` 实现，旧 upstream 文件仍停用。部署与清理只有仓库变量 `TENNIS_DEPLOY_ENABLED=true` 才执行；关闭时 Publish 仅验证/准备 COS 包。真实凭据、外部网球库和首次切换尚待执行，现行首次操作以 [Demo 接管方案](tennis-release-onboarding.md) 为准。应用明确运行模拟 Demo，不能把发布 Environment 名称 production 当成真实支付环境。工具链 Node22、Python3.12、Docker Compose v2。

这套流程已经写入仓库，但当前文档不代表真实 COS 或生产已经配置完成。首次接入尚未执行，本文也没有生产发布或生产验收记录。下文命令是待执行指南；不在终端、日志或归档中输出凭据。

## 日常发布

完成首次接管并显式打开部署开关后，日常流程如下：

1. 合并业务 PR 到 `main`。`Tennis PMS Release Please` 会自动创建或更新版本 PR；它自动更新 `package.json`、`package-lock.json`、`CHANGELOG.md`、`.release-please-manifest.json`、`deploy/release-policy.json` 的版本字段。无需本地执行版本命令或 Git tag 命令。
2. 检查自动版本 PR 的版本和 `CHANGELOG.md`。核对 `deploy/release-policy.json` 的回退限制；当前实际policy为 `forward-only`，不能假定普通版本已允许回退。改变policy不会执行SQL：跨SQL基线一律拒绝普通deploy，须按 [管理员重新接管](tennis-release-onboarding.md#后续跨-sql-基线的管理员重新接管) 完成独立窗口，再重放目标版本。合并版本 PR。
3. Release Please 自动创建不可变的 `vX.Y.Z` tag 和 Draft GitHub Release。确认说明和上线时机后，打开 GitHub Releases，点击 **Publish release**。
4. `release.published` 自动启动 **Tennis-Green-PMS Release**。它会验证 tag 指向 `main` 历史中的提交，运行测试和构建，生成 linux/amd64 镜像、archive、checksum、SBOM，上传并回读 COS，然后通过受限 SSH 自动更新服务器上的 Tennis app。
5. 不需要再点击 Environment 审批。GitHub Release 的 **Publish release**（`release.published`）就是本次生产发布的唯一批准点；只使用一个 `production` Environment，且不设置 reviewer 或 wait timer。

成功条件是 Release workflow 绿色、`/health` 通过，COS 版本目录出现 `deployed.json`。下载/校验、Compose 启动或健康检查失败时，服务器不写成功标记，启动或健康失败会尽力恢复部署前容器，也不执行成功版本 retention；如果健康检查已经通过而 marker、retention 或本地清理失败，新版本保持运行，marker 可能已经创建，workflow 报错后可重试，不自动回退。

同一 Release 重放时，Actions 从受保护的 `main` 解析并固定一个发布 harness commit，再把目标 tag checkout 到独立目录。应用源码和版本身份始终来自不可变 tag；所有 job 的打包、COS 和 SSH 工具来自同一个 harness commit，所以修复发布工具后可以重放旧 tag。Actions 随后查找该版本的完整且已校验 bundle，并复用不可变产物，不重新构建。若 COS 前缀只有部分文件或内容校验失败，流程会拒绝重建和覆盖；未知对象或损坏候选可能被清理跳过，不能假定7天后自动修复。按 [部分COS上传恢复](tennis-release-onboarding.md#部分-cos-上传失败的恢复) 审查可信原包补齐或限定残缺前缀恢复，不覆盖成功包。

基础设施修复合并后，在 Actions 页面使用 **Run workflow** 新建一次 `workflow_dispatch` 并填写已发布 tag。不要点击旧失败 run 的 **Re-run jobs**：GitHub 会沿用旧 run 固定的 workflow 内容，无法验证刚合并的修复。

## 回退

常规回退也不需要 SSH：

1. GitHub → Actions → **Tennis-Green-PMS Rollback** → **Run workflow**，分支选择 `main`。
2. `version` 填要回退到的版本，例如 `v1.2.4`；只有同一版本存在多个成功 revision 时才填写完整 40 位 `revision`。
3. 运行 workflow。它只接受 COS 中同时具备完整产物、有效 manifest、匹配 checksum 和有效 `deployed.json` 的成功版本，再执行已有迁移兼容性、镜像身份和健康检查。

这个 workflow 使用同一个 `production` Environment 和同一把部署 SSH key，没有第二次审批。向前部署要求服务器已核对的迁移基线与目标 manifest 完全相同；`forward-only` 会禁止从该版本直接回退，不会阻止基线相同的向前镜像切换。服务器上已有 `previous` 时可直接复用本地镜像，更早版本会从 COS 下载并校验。

## 一次性配置

首次接入分两人执行：管理员负责一次性 COS/CAM、GitHub 和服务器 bootstrap；发布人负责发布 GitHub Release、观察 workflow 和执行回退。两人的分工不增加第二个审批点。

### 1. 创建 COS 桶

本次共用 `greenpms-release-1305166808` / `ap-shanghai`，隔离 `tennis-green-pms/releases/` 前缀及CAM身份，不新建或修改住房发布前缀。桶须满足：

- 从未启用 COS 版本控制；`Enabled` 或 `Suspended` 都不能使用。
- 开启服务端加密，禁止公开访问。
- Lifecycle 只终止过期未完成分片上传，例如 1 天；不要给 `tennis-green-pms/releases/` 设置按天过期。
- 如果使用全局加速，先在 COS 为桶开启加速，再把 `COS_ENDPOINT` 设为 `cos.accelerate.myqcloud.com`。不设置时使用地域默认 endpoint。

在本地生成无密钥配置和三份 CAM policy。这个命令不访问 COS、不连接服务器：

```bash
rtk proxy python3 scripts/release/setup.py \
  --bucket YOUR_BUCKET \
  --region YOUR_REGION \
  --public-host YOUR_PMS_HOST \
  --output /tmp/tennis-green-pms-onboarding
```

输出是 `cam-upload.json`、`cam-retention.json`、`cam-reader.json` 和 `deploy.json`。目录已存在时脚本拒绝覆盖，换一个新的输出目录即可。

### 2. 创建三个 CAM 身份

将每个 JSON policy 绑定到一个独立的 CAM 编程访问子用户：

| 身份 | policy | 用途 |
| --- | --- | --- |
| upload | `cam-upload.json` | 上传、回读构建产物，也写 `deployed.json` |
| retention | `cam-retention.json` | 查看成功版本并删除旧版本，唯一拥有 `DeleteObject` 的身份 |
| reader | `cam-reader.json` | 服务器只读下载 archive、manifest、checksum 和 SBOM |

所有 resource 都限制在本桶的 `tennis-green-pms/releases/` 前缀。不要授予全 COS、数据库备份、TencentDB 或其他项目权限。marker 是代码中的逻辑 client，但使用 upload 身份的 credentials；没有第四个 marker 账号或 policy。

### 3. 配置 GitHub

在仓库 Settings → Secrets and variables → Actions 中配置四个必需 Repository variables；`COS_ENDPOINT` 可选：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Variable | `COS_BUCKET` | 完整 COS 桶名 |
| Variable | `COS_REGION` | COS 地域代码 |
| Variable | `DEPLOY_HOST` | 生产服务器地址 |
| Variable | `DEPLOY_USER` | `tennis-green-pms-deploy` |
| Variable（可选） | `COS_ENDPOINT` | 全局加速时为 `cos.accelerate.myqcloud.com` |

在 Repository secrets（不是 `production` Environment）中增加 `RELEASE_PLEASE_TOKEN`。它使用两位合并人之一的专用 Fine-grained PAT，仅授予本仓库的 Contents read/write 和 Pull requests read/write；它只用于 Release Please 创建版本 PR 并让 PR CI 正常触发，不授予 COS、SSH、数据库或其他仓库权限。

只创建一个名为 `production` 的 Environment。Deployment branches and tags 选择 `main` 和 `v*`，不设置 required reviewers 和 wait timer。将以下六个值放入这个 Environment 的 Secrets：

| 必需 Secret | 来源 |
| --- | --- |
| `UPLOAD_COS_SECRET_ID` | upload CAM 子用户 |
| `UPLOAD_COS_SECRET_KEY` | upload CAM 子用户 |
| `RETENTION_COS_SECRET_ID` | retention CAM 子用户 |
| `RETENTION_COS_SECRET_KEY` | retention CAM 子用户 |
| `DEPLOY_SSH_KEY` | 专用 deploy SSH 私钥 |
| `DEPLOY_KNOWN_HOSTS` | 已独立核验的服务器主机公钥 |

未来接入短期 STS 时，可增加 `UPLOAD_COS_TOKEN` 和 `RETENTION_COS_TOKEN`。长期 key 方案不要填写 token。reader credentials 不放 GitHub，而是只放服务器的 root-owned 配置。

### 4. 一次性安装服务器入口

使用管理员 SSH 连接完成一次 bootstrap；管理员 key 只用于安装，不作为 GitHub Actions 的 deploy key。按 [runbook 的一次性安装附录](production-release-runbook.md#附录-a一次性安装) 生成或复用唯一的专用 deploy key、创建 `DEPLOY_KNOWN_HOSTS`、执行 archive、`deploy/install.sh`、外部配置、初次 adoption 和 recovery timer 安装。安装器只接收 `--deploy-public-key`，不会执行应用发布、数据库操作或源码构建。完成后，正常发布、回退和 retention 都由 GitHub Actions 自动通过这把 key 完成，不再需要人工 SSH。

### 5. 首次接入窗口和检查

首次接入可以由一个明确授权的初始化窗口一次覆盖 COS/CAM/GitHub 配置、服务器入口和外部配置、当前版本 adoption、首个干净镜像替换及现场清理；任何凭据轮换、生产镜像替换和数据库/业务数据变更都必须明确包含在该窗口内，本流程不会自动修改数据库。若发现凭据需要轮换或镜像来源不明，按组织流程暂停使用、轮换凭据，并从干净 checkout 重新构建和核验镜像。

先运行本地 fake harness，不连接真实 COS、SSH 或生产 Docker：

```bash
rtk npm run test:release
rtk npm run release:check
```

真实首次发布前，用 GitHub Actions 的 Retention workflow 在 `main` 上运行 `dry_run`，确认只会检查 Tennis-Green-PMS 前缀。真实发布验收完成前，不要把工程完成误认为生产已验收。

## 人工介入点

一次性配置需要管理员介入；每次普通发布只需要推 tag、发布 GitHub Release，并观察 workflow。回退只需在 Actions 填版本并运行 workflow。服务器 SSH 仅用于首次安装、首次 adoption 或自动流程失败后的人工作业；日常更新、失败恢复、COS 成功标记、5 版本 retention 和本地镜像清理均自动完成。

详细的状态语义、失败处理、迁移限制、清理算法和一次性服务器命令见 [生产发布 runbook](production-release-runbook.md)。
