# Tennis PMS 项目约定

本仓库是整个 Tennis 项目的 PMS 组件。来源 Green PMS v1.4.3，commit 47eb658a20aee5fc469a6ecbb17444999385da6a；保留 fork 历史，不改原 Green PMS 仓库。

## 业务依据与边界

- 以用户最新确认决定、`docs/tennis/mvp.md` 与对应网球实施规格为准；住房历史规格、验收计划、发布文档仅供参考，不能自动成为网球需求。
- 库存基线见 `docs/tennis/foundation.md`，租户切片见 `docs/tennis/tenant-foundation.md`，资产与定价见 `docs/tennis/catalog-pricing.md`，交易及资金见 `docs/tennis/booking-transactions.md`、`docs/tennis/wallet-payments.md`；完成状态见 `docs/tennis/implementation-status.md`。集中答复已记录在 `docs/tennis/decisions-and-acceptance.md`：人民币余额、混合支付但不透支、报价 5 分钟、占位 10 分钟、授权人工退改/待收款等已确认，不反复询问。本金/赠送分开记账，退款回原来源及构成。
- 智能体和 Runtime 由 PMS 外部实现，本次不开发其运行时。PMS 提供受权限约束的业务接口、事件、人工接管与后台助手适配；AI 模型/Base URL 只由我方平台配置。库存、付款事实与权限不由 LLM 判定。当前已有独立网球登录、员工/客户 HTTP API 与短期 Bearer 授权的外部工具；微信渠道身份映射、真实商户和外部 Runtime 联调仍待接入。
- 保持客户、员工、后台同一库存/订单。保留原上游实现供定点复用，不先建设多行业通用平台。

## GreenPMS 体验延续

- 用户要求在满足网球业务的前提下尽量保留 GreenPMS 的视觉、信息密度、导航及操作习惯；后台 AI 助手必须保留，不能作为 MVP 精简项删除。依据 `docs/tennis/experience-continuity.md` 随各业务切片落实。
- 优先复用现有样式和组件，不另换设计体系。房态到排场、按天到时段是业务适配；住房权益和账务不能仅改名继承。历史截图仅供风格参考；AI 助手按用户 2026-09-21 要求对齐当日最新 GreenPMS v1.7.2，网球权限与业务规则仍以本项目规格为准，核对记录见 `docs/tennis/assistant-parity-2026-09-21.md`。
- UI 必须说人话（用户 2026-09-22 再次明确）：先写工作人员/客户要做的事和当前结果，不把机器语言、技术机制、业务边界声明平铺在界面。常驻只留核心字段、金额、状态和下一步；重复或显然的说明删除，有用的补充解释放在相关标题/字段旁的信息图标、悬浮提示或展开区。提示统一支持悬浮、键盘聚焦和手机点击。真实错误、未决结果、收付款/退款后果及模拟状态必须直接可见，不能为了简洁藏起来；具体格式错误提示保留。沿用 GreenPMS 的视觉与操作习惯。
- 保留返回位置、条件允许时的输入恢复、客户预填、提交结果恢复及手机可用性；身份／租户／场馆变化时隔离缓存、草稿和 AI 上下文。原助手只读查询和入口引导不能冒充已完成网球写操作，AI 配置作用域也须按多租户权限适配。

## 开发与验证

- 本项目本地人工验收及真实模型联调默认使用 `https://qintopia.ccwu.cc/v1`、模型 `deepseek_v4`（用户于 2026-09-21 指定）。API Key 保存在本机忽略目录 `.local-workspace/ai-test-defaults.json`，用本地 AI 密钥加密、文件权限 0600；不得写入 Git、报告或测试快照。`npm run tennis:api` 自动带入本地配置；纯单测和数据库集成测试继续使用合成模型响应，不默认产生远端调用。

- 每次交付本地验收时，答复必须同时给出可点击的验收地址、用户名和密码，不能只让用户自行查看凭据文件。常用前台 `demo.staff`、管理员 `demo.green`；本地演示账号统一固定密码 `TennisPMS123!`，重建演示数据不随机更换。仅适用于独立本地演示环境。

- 先核对 Git 根目录、分支与工作区。默认复用本目录，在功能分支工作；仅确需隔离时创建额外工作目录并说明用途、收尾条件。保留他人改动。
- 修改通过 PR 合入 main，不直接推送 main。PR 包含“改动说明、验证结果、风险与回退”。`node --test scripts/check-pr-tests.mjs` 验证格式规则。继承的 `.github/main-protection.json` 是上游记录，不能视为已经核验 Tennis-PMS 远端保护；不得擅自按上游文档改远端权限。
- A 级：资金、计价、库存、并发事务、生命周期、权限。按适用规格 → 实施 → 自动验证 → 人工验收，分别记录状态；已授权范围不逐步请求批准。
- B 级 UI 与普通工程改动做匹配范围的检查；不要重复已有规格或不必要地扩大验证。
- 使用 npm workspaces 和 package-lock。网球命令与环境见 `docs/tennis/development.md`。执行 `npm run typecheck`、`npm test`、`npm run build`，库存改动增加 `npm run test:integration`。

## 环境隔离

- 网球仅用独立 Compose、数据库和迁移；不得将住房 `.env`、数据、支付凭据复制到本项目。
- 历史 `packages/db/src/migrations`、`tests/helpers`、E2E、备份/清理/发布脚本仍含住房默认地址。不要直接运行；根 npm 相应入口已停用或重定向。新网球代码位于 `packages/db/src/tennis`。
- `.github/upstream-workflows` 与 `docs/upstream` 仍是停用参考，不能直接启用。Tennis 专用 release/rollback/retention 已在 `.github/workflows` 实现；只有仓库变量 `TENNIS_DEPLOY_ENABLED=true` 才连接服务器。真实首次接管尚待执行，按 `docs/operations/tennis-release-onboarding.md` 操作，不改住房环境。
- 不运行会重置住房数据库的集成/E2E。网球测试只连接 tennis_test，不 DROP 库或清空 schema，仅清理本次合成记录。
- 不把构建成功、提交成功、占用基础测试通过标成完整 MVP 或人工验收通过。
