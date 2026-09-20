# Tennis-Green-PMS 版本与发布约定

根 `package.json` 的 `version` 是 Tennis-Green-PMS 应用版本唯一来源，根锁文件必须同步。历史 Green PMS 版本只用于说明 fork 基线，不代表 Tennis 版本已经发布。

每个发布版本使用不可复用的 `vX.Y.Z` 标签和 GitHub Release。发布校验由 `npm run release:check` 执行，校验包版本、锁文件、CHANGELOG 和 `deploy/release-policy.json`。生产发布前还必须完成目标仓库的镜像仓库、数据库、域名、密钥和权限配置；本仓库不会在开发验证中执行生产发布、数据库迁移或云端权限变更。

当前可验证的本地链路是：

```bash
npm run release:check
npm run build
npm run verify:cold-start
npm run verify:compose
```

生产 Compose 只接收不可变的 `TENNIS_GREEN_PMS_IMAGE` 和外部 `TENNIS_DATABASE_URL`，健康检查使用 `/health`。服务器配置模板中的 `CHANGE_ME` 和 `REPLACE_WITH_*` 必须由管理员在目标环境单独填写，不能提交到仓库。
