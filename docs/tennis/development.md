# Tennis PMS 本地开发

这是网球项目 PMS 组件。当前开发包含独立网球认证/API、交易服务和运营界面；准确验证状态见 [实施状态](implementation-status.md)。Green PMS fork 的住房源码保留供定点复用；本地付款/退款为显式模拟，不能视作真实微信接入。

小量客户线上演示使用独立的 [格林网球云端 Demo](cloud-demo.md)：专用镜像、Compose、数据库、一个租户和两个校区。它使用独立凭据和 HTTPS，仍明确模拟支付，不替代真实生产接入。

## 首次运行

使用 Node.js 22.x、npm 和 Docker Compose v2+，在仓库根目录执行：

```bash
npm ci
npm run tennis:db:up
npm run tennis:db:migrate
npm run tennis:demo
npm run dev
```

浏览器打开 `http://127.0.0.1:4273`。API 只监听 `127.0.0.1:4200`，Web 通过同源代理访问。演示脚本可重复运行，仅用于独立本地开发库；创建两个模拟租户和平台、租户管理员、前台、客户账号。本地演示账号统一固定密码 `TennisPMS123!`，同时记录在忽略文件 `.local-workspace/demo-credentials.json`。日常验收使用前台 `demo.staff`；管理员 `demo.green`，客户 `demo.customer`，第二租户管理员 `demo.second`，平台运营 `demo.platform`。每次交付验收须附地址及当前所需账号密码。

已有本地演示账号可执行 `node --import tsx scripts/tennis/demo-credentials.mts` 同步固定密码；此命令只更新已识别的五个模拟账号密码，不重建场馆、订单、余额或权限。`npm run tennis:demo` 创建/重建演示数据时也沿用这些固定凭据。

验证命令：

```bash
npm run verify:tennis
```

本机已在忽略目录安装独立 Node.js 22.23.2；当前全局仍是 24。如不使用自己的版本管理器，可在本仓库根目录先执行：

```bash
export PATH="$PWD/.local-workspace/node22/node_modules/.bin:$PATH"
node --version
```

该 runtime 只在当前机器存在；新克隆仍需自行安装 Node.js 22。它不修改 package-lock，也不随 Git 提交。

无须复制或加载 Green PMS 的 `.env`。网球命令只读 TENNIS_DATABASE_URL / TENNIS_TEST_DATABASE_URL，默认值和 `.env.example` 一致；Node 命令不自动加载 `.env`，如需修改密码应显式导出对应变量。bootstrap 固定本机端口、库名、用户名，用于避免误连上游环境。Compose 的本地身份和密码固定在 compose.yaml 中，不适用于远端部署。

| 资源 | 位置/值 |
| --- | --- |
| PostgreSQL | 127.0.0.1:55439 |
| 开发库 | tennis_dev |
| 测试库 | tennis_test |
| Compose 项目 / 卷 | tennis-pms-local / tennis-pms-local_tennis-data |
| API / Web 端口 | 4200 / 4273，仅本机监听 |
| 网球迁移 | packages/db/src/tennis/migrations/ |
| 运行状态 | `docker compose ps` |
| 停止本地数据库 | `docker compose stop postgres`，保留数据卷 |

Compose 默认复用官方 PostgreSQL 16 的 DaoCloud 镜像；可通过 TENNIS_POSTGRES_IMAGE=postgres:16-alpine 选择 Docker Hub。

`tennis:db:up` 启动 PostgreSQL 并等待健康；首次初始化同时创建开发库和测试库。`tennis:db:migrate` 执行网球迁移，重复执行不会重建表。集成测试初始化测试库迁移、写入并清理本次合成记录，不清空现有数据。

## 验证与继承代码

- `npm run test:tennis`：区间、计价、钱包取整与连接守卫单测。
- `npm run test:integration`：仅网球 PostgreSQL 集成测试，不调用住房测试 runner。
- `npm run typecheck`、`npm test`：全库类型检查、纯单测。`npm run build` 现在只构建网球入口，输出 `apps/web/dist-tennis/`；`npm run tennis:preview` 可预览此构建（需同时运行网球 API）。
- `node --test scripts/check-pr-tests.mjs`：继承的 PR 格式验证。
- `npm run dev/start` 现在启动独立网球 API/Web；`db:reset/test:e2e/test:contract` 等住房入口仍停用。`npm run db:migrate` 已指向网球迁移。

旧生产 Compose 位于 `docs/upstream/compose.server.yaml.disabled`；发布、回滚和清理工作流位于 `.github/upstream-workflows/*.disabled`，GitHub 不执行这些归档文件。原部署工具与 Dockerfile 仍为住房参考，不能用于网球生产。网球生产部署尚未配置；本地改动需通过 PR 合入 main 后才影响远端工作流。

## 后续切片

集中答复已在 [开发决策清单](decisions-and-acceptance.md) 固化。智能体和 Runtime 位于 PMS 外部，接口见 [外部助手契约](external-agent.md)。F8 补充 [Gateway 接入](gateway.md)、[事件轮询](business-events.md) 和 [替代场馆](agent-discovery.md)；网球迁移现为001–022。本地 API 每 15 秒处理预约/改期占位到期；课程和维护占场仅员工可办。商户号、微信具体入口、外部 Runtime 与部署条件未具备，真实接入和人工验收仍须分别完成。

## 本机云盘读取限制

2026-09-18：正式目录出现 iCloud 文件占位读取等待。依赖已按原锁文件离线恢复；原依赖目录保存在 `.local-workspace/node_modules-before-f1`；387 个未修改的跟踪源码/配置从 Git index 恢复本地内容，全部原有工作区改动保留。临时验证副本位于 `/private/tmp/tennis-pms-goal-build`，用于同源码、同锁文件的本地检查，不是第二份产品仓库。修改通过明确文件列表同步正式仓库并核对内容；日志区分正式目录被中止的检查与临时副本的成功结果。


2026-09-19 收尾：正式目录的依赖、继承源码及 Git pack 曾再次显示 iCloud dataless 占位。旧依赖保留到 `.local-workspace/node_modules-before-f6`，以同锁文件的已验证依赖副本恢复；638 个无工作区改动的跟踪文件从 Git index 恢复，已改文件保留。网球新增文件用内容核对后原子写回，避免保留旧云盘元数据。随后正式仓库构建成功，API 与稳定构建预览已在正式目录启动；临时实例已停止。若机器再次自动腾出云盘文件，先让项目保持本地可用；这属于文件读取问题，不是执行审批。

本地备份目录不属于测试源码，Vitest 已显式排除 `.local-workspace` 和 `.worktrees`，避免扫描旧依赖/恢复副本。正式仓库最终检查已通过，见实施状态与日志。

2026-09-19 F7：iCloud 再次将正式目录源码变成 dataless 占位。本轮使用已有 `/private/tmp/tennis-pms-goal-build` 验证副本完成修改和测试，按 F7 文件清单同步正式目录并核对 SHA256，未整库覆盖。Web/API 暂从该已核对副本运行，以保持本地演示可用；不修改系统云盘设置，也不把文件读取等待当成执行审批。当前会话为 Full Access / approval never，普通开发、验证与本地服务动作不重复申请权限。
