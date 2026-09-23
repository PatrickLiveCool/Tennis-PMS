# Tennis PMS 自动版本 PR

Release Please 接入代码位于 `.github/workflows/release-please.yml`。工作流合入 `main` 并配置仓库专用 `RELEASE_PLEASE_TOKEN` 后，合并业务 PR 会自动创建或更新版本 PR；合并版本 PR 后创建 `vX.Y.Z` 标签和 Draft GitHub Release。版本 PR 默认带有 `autorelease: pending` 标签。

2026-09-23 核对时，远端仅启用了 CI，仓库没有 Actions Secrets、版本标签或 Releases。本次补齐工作流、首版基线和 CI 契约检查；在凭据配置并实际运行成功前，不能标记为已启用或已发布。

## 首次启用

1. 在 GitHub 创建仅限 `PatrickLiveCool/Tennis-PMS` 的专用 Fine-grained PAT，Repository permissions 只需 **Contents: Read and write** 和 **Pull requests: Read and write**（Metadata read 为自动附带）。设置适当有效期并记录续期负责人。不复用 GreenPMS 凭据或本机日常登录 token。
2. 打开 [Tennis-PMS Actions Secrets](https://github.com/PatrickLiveCool/Tennis-PMS/settings/secrets/actions)，新建 Repository secret，名称为 `RELEASE_PLEASE_TOKEN`，值为上述 token。不要放在 `production` Environment，也不要把值发到聊天、写入源码或命令行参数。
3. 合并包含本工作流的接入 PR。该次 `main` push 即可触发。如果先合并、后添加 Secret，在 [Release Please 工作流](https://github.com/PatrickLiveCool/Tennis-PMS/actions/workflows/release-please.yml) 点击 **Run workflow**，分支选择 `main`。
4. 核对工作流成功、版本 PR 出现，并且该 PR 的 `PR format` 和 `Node and release checks` 全绿。这个检查点完成后才算自动版本 PR 链路接通。

维护者也可在凭据已配置且工作流已合入后执行：

```bash
gh workflow run release-please.yml --repo PatrickLiveCool/Tennis-PMS --ref main
gh run list --repo PatrickLiveCool/Tennis-PMS --workflow release-please.yml --limit 5
gh pr list --repo PatrickLiveCool/Tennis-PMS --state open
```

这里使用专用 token，是因为 `GITHUB_TOKEN` 创建的 PR 通常不会触发其他 `pull_request` 工作流，无法自动获得现有 PR CI。无需为此修改仓库默认工作流权限或开启 Actions 的 PR 审批选项。缺失 token 时，工作流会在调用 Release Please 前明确失败；不会静默跳过或回退到内置 token。

## 版本与 CI

- 继续使用继承的 `1.4.3` 作为版本起点，不补造上游标签或历史 Release。`bootstrap-sha` 指向 GreenPMS fork 基线 `47eb658a20aee5fc469a6ecbb17444999385da6a`，首次只扫描它之后的 Tennis 提交，后续发布由 Release Please 自身跟踪。
- 首次发布前需检查 CHANGELOG 和版本 PR 正文的比较链接：当前仓库没有 `v1.4.3` 标签，而固定版本的 Release Please 会以该版本号生成上一标签链接。首版 PR 最后一次自动更新后，将 `compare/v1.4.3...` 的起点改为上述 fork SHA；这不影响版本计算，也无需补造历史标签。首个 Tennis 标签生成后，后续版本使用真实标签比较。
- 自动同步根 `package.json`、`package-lock.json`、`CHANGELOG.md`、`.release-please-manifest.json` 和 `deploy/release-policy.json` 的版本。版本号由 Conventional Commits 计算，以生成的版本 PR 为准。
- 现有 CI 的类型检查、单测、构建、PostgreSQL 集成测试全部保留，额外执行版本工作流契约检查；自动 PR 的标题和正文满足现有格式规则。
- 新工作流仅在目标仓库的 `main` push 或手动运行时执行，使用独立并发组，固定 Release Please Action 提交。它不需要 COS、SSH 或 `production` Environment。

## 尚未接通的基础设施

| 环节 | 当前状态 |
| --- | --- |
| CI | 已在远端运行；本次追加版本工作流契约检查 |
| 自动版本 PR、标签与 Draft Release | 本次补齐代码；需要合入、配置专用 Secret，并取得真实运行证据 |
| Docker、Tennis 运行入口、备份恢复、发布工具 | 已适配并有本地验证，见迁移记录 |
| COS 自动打包上传与服务器发布 | `release.yml.disabled` 仍为参考；目标环境、独立凭据和端到端发布未完成 |
| 云端版本回退与保留清理 | `rollback.yml.disabled`、`retention.yml.disabled` 仍为参考；未做目标环境演练 |

因此，“基础设施完整迁移”仍未完成。自动版本 PR 可以独立接通，不依赖真实支付、COS 或服务器上线；云端 Demo 的独立部署方式见 [云端 Demo](../tennis/cloud-demo.md)。生产接入另见 [发布快速开始](production-release-quickstart.md)，其草案不能当作已生效配置。

## 故障与回退

- 提示 `Missing repository secret RELEASE_PLEASE_TOKEN`：在上述仓库 Secret 页面配置，再从 `main` 新运行一次工作流。
- API 返回 401/403：核对 token 有效期、所属仓库和两项写权限；日志或工单只记录错误与 Secret 名，不记录值。
- 工作流成功但没有新 PR：先查看是否已有待合并版本 PR、前一版本 PR 是否还待创建 Release，以及是否存在可发布的新提交。
- 需要停用时，通过 PR 移除或停用新增工作流即可。保留已有标签、Release 和业务 CI；停用不等于回退已发布版本。

依据：[Release Please 的 PR CI 触发说明](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs)、[首版 bootstrap 说明](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md#bootstrapping)。
