# Tennis-Green-PMS 基础设施迁移记录

> 2026-09-23 接续：本文以下保留首次迁移时的历史范围与验证记录。当前已补齐 Tennis 专用 release/rollback/retention、受限 Demo 运行配置和单独迁移入口；默认不开启服务器部署，真实接管仍未执行。现行步骤和恢复方案见 [发布接管](tennis-release-onboarding.md)，版本 PR 见 [Release Please](release-please.md)。

源仓库：本机 Green PMS，核对提交 `9b9c6eed97f18f535b295a2910c47b8ab5412af9`。目标：`git@github.com:PatrickLiveCool/Tennis-PMS.git`，本机 `Tennis PMS`。用户后续指定此原始 GitHub 仓库作为目标，原 `qintopia-agent-studio/Tennis-Green-PMS` 地址未使用。

迁移分支：`codex/green-pms-infrastructure-migration`，开始时 HEAD 为 `c06d4a4`。目标已继承 Green PMS v1.4.3 基础设施，但住房发布 workflow 和危险数据库入口此前已停用；本次以已有文件逐项合并适配，不复制业务源码、业务数据库或源项目环境文件。

## 文件处理清单

下列同一行的每个文件均采用该行所列处理方式；仅新文件标为“新增”，原文件重命名另外列出。

| 文件 | 处理 | 依据与变化 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | 不迁移，保留目标原文件 | 保留 PostgreSQL 服务和全部现有检查，差异见下节。 |
| 源 `.github/workflows/release-please.yml`、`release.yml`、`retention.yml`、`rollback.yml` | 不激活 | 目标原有 `.github/upstream-workflows/*.disabled` 原样保留，不是本次新增；依然包含上游名称，不可直接启用。 |
| `.github/PULL_REQUEST_TEMPLATE.md`、`.github/main-protection.json` | 保留 | 与源文件字节相同。保护配置是上游记录，不代表目标远端已配置，不应用云端权限。 |
| `Dockerfile` | 调整 | Node 22 多阶段构建 Tennis 前端和编译后的 API；运行层只装生产依赖；OCI source 使用目标 GitHub URL。 |
| `.dockerignore` | 合并 | 排除 Tennis 构建结果、本地工作目录、worktree 和秘密；原有排除保留。 |
| `compose.yaml` | 合并 | 保留本地 Tennis PostgreSQL/test 初始化，增加显式 migrate 和 app。项目/卷使用 tennis-green-pms 名称，端口可覆盖。 |
| `compose.server.yaml` | 新增/适配 | 预构建镜像和外部数据库模板，不构建、不自动迁移；当前业务未接入生产支付，模板不能当成已可投产。 |
| `.env.example` | 合并 | 仅本地示例及服务器变量占位符，无真实秘密。 |
| `package.json`、`package-lock.json` | 合并 | 根包改为 tennis-green-pms；接入 release check、静态服务启动和验证命令；依赖版本不变。 |
| `.release-please-config.json` | 调整 | 更新根包标识和说明，workflow 保持停用。 |
| `deploy/entry.py`、`deploy/ssh-entry.py`、`deploy/install.sh` | 调整 | 独立 Tennis 用户、forced command、sudo、安装与状态路径。未执行真实安装。 |
| `deploy/release-policy.json`、`deploy/server-config.example.json` | 调整 | 应用标识、端口、健康及版本 URL、路径和 COS 桶占位符。 |
| `deploy/greenpms-deploy` → `deploy/tennis-green-pms-deploy` | 重命名/调整 | 固定受限服务器入口。 |
| `deploy/greenpms-deploy.sudoers` → `deploy/tennis-green-pms-deploy.sudoers` | 重命名/调整 | 独立部署身份。 |
| `deploy/greenpms-release-recovery.service` → `deploy/tennis-green-pms-release-recovery.service` | 重命名/调整 | 独立恢复服务。 |
| `deploy/greenpms-release-recovery.timer` → `deploy/tennis-green-pms-release-recovery.timer` | 重命名/调整 | 独立定时器；未安装或启用。 |
| `deploy/greenpms-release.logrotate` → `deploy/tennis-green-pms-release.logrotate` | 重命名/调整 | 独立审计日志目录。 |
| `scripts/backup.sh`、`scripts/restore.sh` | 调整 | 备份限 0600；恢复需 ALLOW_RESTORE、仅新库、禁止覆盖配置的 live 库并核对 Tennis 迁移历史。 |
| `scripts/build-runtime.mjs` | 调整 | 复用源项目编译流程，产出 Tennis 启动入口、dist-tennis 和 Tennis SQL 基线，保持发布器禁止业务 TS 源码进入镜像的检查。 |
| `scripts/check-release.mjs` | 调整 | Tennis 发布标识和说明标题，v1.4.3 上游历史标题仍可追溯。 |
| `scripts/tennis/database.mts` | 合并 | 保留本地默认保护，显式 opt-in 才允许容器/隔离验证地址；只调用已有 Tennis migrations。 |
| `scripts/tennis/server-entry.mts` | 新增 | 打包后的 Web/API 入口；不改业务服务。启动只读比较 SQL 校验和，不自动迁移。静态页与已有鉴权 API 分开处理，提供 /health 与 /version。 |
| `scripts/verify-tennis-postgres.sh` | 新增 | 为验证创建独立临时 PostgreSQL 容器和随机端口；不连接现有数据库，不执行 DROP。 |
| `scripts/verify-cold-start.sh` | 调整 | 验证空库拒绝、独立测试迁移、公开页面、鉴权 API 与健康检查。 |
| `scripts/verify-backup-restore.sh` | 调整 | 通过真实 backup/restore 脚本验证合成哨兵数据及禁止覆盖保护，目标库只存在于临时容器。 |
| `scripts/verify-compose-cold-start.sh` | 调整 | 空 env 文件、随机 Compose 项目/容器/端口、固定合成凭据，验证后清理本次资源。 |
| `scripts/release/common.py`、`cos.py`、`orchestrate.py`、`package.py`、`server.py`、`setup.py` | 调整 | 更新应用/镜像/COS/archive/路径，单 app 服务，/version 同时验证版本及 revision；保留不可变包、回退和范围受限的清理机制。 |
| `scripts/release/migration-baseline.mjs` | 调整 | 只读取 packages/db/src/tennis/migrations。 |
| `scripts/release/ai_config.py` | 调整 | TENNIS_AI_ENCRYPTION_KEY、Tennis 配置表及 runtime 模块检查；不复用住房密钥或供应商配置。 |
| `scripts/release/requirements.txt` | 保留 | 源、目标发布依赖一致。 |
| `scripts/release/tests/test_ai_config.py`、`test_cos.py`、`test_entry.py`、`test_fetch.py`、`test_install.py`、`test_migration_baseline.py`、`test_package.py`、`test_rollback.py`、`test_server.py`、`test_setup.py`、`test_workflows.py` | 合并/调整 | 适配 Tennis 身份、单服务和数据库路径；增加错误版本/revision 拒绝覆盖；停用 workflow 的 11 项测试明确跳过，其余继续验证。 |
| `docs/operations/production-release-quickstart.md`、`production-release-runbook.md` | 调整 | Tennis 路径、地址及模板状态；生产接入/权限规则是待确认草案。 |
| `docs/operations/ai-assistant.md` | 调整说明 | 住房页面和表说明保留为历史参考；说明 Tennis 密钥与业务文档，不将旧 AI 业务说明当成新功能。 |
| `docs/releases/README.md`、`docs/repository-contributing.md` | 调整 | 目标仓库、版本、PR 和验证说明。 |
| `docs/operations/tennis-green-pms-infrastructure.md` | 新增 | 本逐项迁移清单、环境配置、验证与限制。 |

保留 `apps/*`、`packages/*` workspace 路径和已有 `@qintopia/*` 内部包引用，避免重命名导致业务 import 变更。根包及外部运维标识已适配。源项目业务 seed、业务快照、住房迁移、住房 E2E/集成启动器不迁移或启用。既有 `scripts/tennis/server.mts`、`demo.mts` 和本地 URL 保护保留。

## CI 冲突：此部分暂停

| 项目 | 源 Green PMS | 目标 Tennis PMS | 本次结论 |
| --- | --- | --- | --- |
| 名称/并发组 | GreenPMS CI / greenpms-ci | Tennis PMS CI / tennis-pms-ci | 保留目标 |
| PR 格式、release check、typecheck、npm test、build | 已有 | 已有 | 全部保留 |
| PostgreSQL 服务和 tennis_test | 无 | 已有，端口 55439 | 不删除 |
| npm run test:integration | 无 | 已有 | 不删除、不缩小 |
| Python release harness | 已有 | 目标 CI 未接入 | 可本地运行；不擅自修改 workflow |
| release-please/release/retention/rollback | 已启用且依赖上游生产约定 | 仅 disabled 参考 | 继续停用，待单独审阅合并方案 |

没有修改 `.github/workflows/ci.yml`，没有推送、远端权限修改或创建 PR。不能直接把源 workflow 改名后启用；需要先确定保留现有完整 CI 的合并方案和目标生产配置。

## 运行与人工配置

本地 Compose 数据库保留 `tennis_dev` / `tennis_test`，兼容现有业务工具和 CI；服务器示例数据库为 `tennis_green_pms`。新的 Compose 项目/卷不会重用或删除旧 `tennis-pms-local` 卷，旧数据如需迁移须另行计划。本次不搬运数据。

| 变量 | 用途 |
| --- | --- |
| TENNIS_DATABASE_URL | 目标 PostgreSQL URL；服务器单独配置，不复制源库凭据 |
| TENNIS_GREEN_PMS_IMAGE | 服务器不可变预构建镜像，本地 deploy harness 使用 tennis-green-pms:vX.Y.Z-revision |
| TENNIS_WEB_ORIGINS | 明确允许的 Web origin |
| TENNIS_AI_ENCRYPTION_KEY | 可选 AI 配置密钥，规范 Base64 编码的 32 字节；持久保管，重启不随机更换。缺失时不注册依赖密钥的 AI 功能 |
| TENNIS_PAYMENT_SIGNING_KEY | 目前仅本地模拟支付使用，至少 32 字符；不代表真实微信支付接入 |
| TENNIS_ALLOW_SIMULATION | 本地显式 true；生产 false |
| TENNIS_ALLOW_NONLOCAL_DATABASE | 容器/隔离测试地址须显式 true；不意味着授权生产迁移 |
| TENNIS_POSTGRES_USER / PASSWORD / DB / HOST_PORT / IMAGE | 本地或独立验证 PostgreSQL；现有 init-databases.sql 使用 tennis_dev 作为 owner |
| TENNIS_APP_BIND / HOST_PORT | 默认仅绑定 127.0.0.1:4200 |
| TENNIS_HTTP_HOST / PORT | 进程监听地址，Compose 容器内 0.0.0.0:4200 |
| TENNIS_RELEASE_VERSION / REVISION | 镜像由 OCI build args 写入，供 /version 校验，勿在服务器覆盖 |

如将来启用源发布方案，还需人工配置 COS_BUCKET、COS_REGION、可选 COS_ENDPOINT、DEPLOY_HOST、DEPLOY_USER，以及 RELEASE_PLEASE_TOKEN、UPLOAD_COS_SECRET_ID/KEY、RETENTION_COS_SECRET_ID/KEY、DEPLOY_SSH_KEY、DEPLOY_KNOWN_HOSTS；只读 COS credentials 仅留服务器受限文件。当前不创建这些身份、秘密或 GitHub Environment，不应用上游分支保护配置。

目标业务仅有 `LocalMockPaymentGateway`，它禁止 production。新启动入口保留此保护，且无显式本地模拟授权时拒绝启动。生产支付适配器接入属于业务范围，未在基础设施迁移中实现。服务器 Compose 是预备模板，不代表生产可用。

## 验证与本机故障处理

本机旧 node_modules 导致 tsc/Vite 阻塞在文件读取（进程 CPU 为零，采样定位 uv_fs_read）；按现有锁文件隔离安装依赖后恢复。旧目录保存在忽略路径 `.local-workspace/node_modules-before-infrastructure-validation`，未删除或提交。未添加 BMad：仓库没有其 render_skill.py，按用户已授权范围直接采用仓库自带工具收尾。

本机 shell 默认 Node 24.21.0、Python 3.9；仓库/容器规定 Node 22，release harness 需 Python 3.10+。本次 Python 检查使用：
`PATH=/opt/homebrew/opt/python@3.12/libexec/bin:$PATH npm run test:release`。
Docker 与回环端口验证需在允许访问本机 socket/端口的环境执行，沙箱 EPERM 不当作业务失败。

| 命令 | 结果 |
| --- | --- |
| `node --test scripts/check-pr-tests.mjs` | 8/8 通过 |
| `npm run typecheck` | 通过；修复了新入口调用模拟适配器的错误参数 |
| `npm test` | 74 文件、1394 项通过；包含目标原先暂存业务改动的工作区 |
| `npm run build` | 通过；本机 Vite 和 Node 22 镜像均已构建 |
| `npm run release:check` | 通过 |
| `npm run test:release`（Python 3.12） | 114 项中 103 通过、11 项停用 workflow 契约明确跳过 |
| `npm run verify:cold-start` | 通过；空库拒绝、独立显式迁移、Web/API 验证 |
| `npm run verify:restore` | 通过；实际 backup/restore 往返和拒绝覆盖检查 |
| `npm run verify:compose` | 最终入口在独立 Node 22/PostgreSQL 16 项目中通过构建、迁移、健康、静态页及鉴权检查 |
| 两份 Compose `config --quiet`、ShellCheck、`git diff --check` | 通过；服务器配置只使用占位变量 |

所有数据库验证仅创建临时容器和合成数据，不执行生产操作。生产支付、云端 release/rollback/retention、GitHub 权限和业务人工验收均未执行。

## 尚待处理

- 现有 CI 与源 workflow 的冲突按用户要求暂停；远端保护、Environment 和发布权限未核验或修改。
- 真实支付适配器未接入，生产启动拒绝；云端发布、回退、retention、真实 AI 和生产恢复均未执行或验收。
- 保留异常 Git ref `refs/heads/feat/tennis-foundation 2`；它会使分支枚举警告或部分 fetch 失败，本次不清理用户 refs。
- 基础设施分支从已有 Tennis HEAD 创建，已有 12 个相对本机 origin/main 的提交；本次只提交基础设施，不把先前暂存业务内容带入。推送/PR 前需核对目标基线。
