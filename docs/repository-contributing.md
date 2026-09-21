# Tennis-Green-PMS PR 与 main 保护

目标仓库为 `PatrickLiveCool/Tennis-PMS`。日常修改使用 `codex/` 功能分支，通过 PR 合入 main，不直接推送 main。

1. PR 标题使用 Conventional Commit，如 `chore(infra): adapt Green PMS infrastructure for Tennis`。
2. PR 正文包含“改动说明、验证结果、风险与回退”，准确记录失败、未执行和人工验收状态。
3. 保留现有 `PR format`、`Node and release checks` 及其全部步骤，包括 PostgreSQL 服务和 Tennis 集成测试。workflow 合并差异见 [迁移记录](operations/tennis-green-pms-infrastructure.md)。
4. 解决讨论及冲突，按目标仓库实际权限和保护规则合并。

`.github/main-protection.json` 与 PR 模板来自上游。保护文件中的审批人数、允许账号及 strict 设置只是上游记录，本次未核验或应用到目标 GitHub 仓库；不能据此断言当前管理员、审批要求或合并权限。任何保护规则变更须另行确认，不自动套用。

管理员如需核对远端，可执行以下只读查询：

```bash
gh api repos/PatrickLiveCool/Tennis-PMS/branches/main/protection
```

本地格式与代码验证：

```bash
node --test scripts/check-pr-tests.mjs
npm run typecheck
npm test
npm run build
```

发布工具的本地 fake harness 使用 Python 3.10+：`npm run test:release`。它不访问生产 COS 或 SSH。真实 Docker 验证见 [迁移记录](operations/tennis-green-pms-infrastructure.md)。源发布 workflow 保持停用，合并或发布 GitHub Release 不等于已上线。
