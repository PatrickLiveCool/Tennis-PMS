# Tennis PMS

网球项目的 PMS 业务核心与运营后台组件。源自 Green PMS v1.4.3（`47eb658a20aee5fc469a6ecbb17444999385da6a`），保留 fork 历史，独立于住房环境。

本地开发版本已提供多租户登录、场馆与球场配置、15 分钟排场、多片/多时段预订、分时定价、人民币储值与混合付款、人工退款改期、平台管理和后台 AI 助手。付款/退款明确使用本地模拟；微信渠道和真实商户尚未接入。智能体与 Runtime 在 PMS 外部，本组件提供受权限约束的业务接口、助手适配和人工接管。

- [MVP 与组件边界](docs/tennis/mvp.md)
- [当前实施与验证状态](docs/tennis/implementation-status.md)
- [开发与启动](docs/tennis/development.md)
- [本地演示与验收记录](docs/tennis/local-acceptance.md)
- [体验延续清单](docs/tennis/experience-continuity.md)
- [决策与验收清单](docs/tennis/decisions-and-acceptance.md)
- [外部智能体接口](docs/tennis/external-agent.md)

```bash
npm ci
npm run tennis:db:up
npm run tennis:db:migrate
npm run tennis:demo
npm run dev
```

需要 Node.js 22.x 与 Docker Compose。打开 `http://127.0.0.1:4273`；账号和随机演示密码见本地忽略文件 `.local-workspace/demo-credentials.json`。API 使用 4200，独立 PostgreSQL 使用 55439，均只绑定本机。演示数据为合成数据，重复执行演示脚本不会清库。

```bash
npm run typecheck
npm test
npm run test:integration
npm run build
```

构建输出 `apps/web/dist-tennis/index.html`；同时运行 API 后，可用 `npm run tennis:preview` 查看稳定构建。继承的住房重置、生产部署、发布与 E2E 入口已停用，历史文档和 Dockerfile 不可用于网球生产。

修改在功能分支上开发，经 PR 合入 main。Green PMS 的历史版本号 1.4.3 仅标记来源，尚未发布网球版本。真实微信、商户/退款联调、外部 Runtime、真实资料导入、客户人工验收及生产部署需分别完成，不以本地验证代替。
