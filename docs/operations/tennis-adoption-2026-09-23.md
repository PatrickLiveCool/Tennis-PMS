# Tennis 首次接管执行记录（2026-09-23）

本记录区分实际执行与尚未完成的人工业务验收。用户已授权腾讯云 CLI 操作、资源准备后立即停写切换，以及开启 COS 全球加速并接受加速流量费用。应用仍为模拟支付 Demo。

## 已落地资源

| 资源 | 实际配置 |
| --- | --- |
| 版本 | `v1.5.0` / `597e947c1a833109523ec30849d84227560e30bc` |
| 入口 | `https://tennis.qintopia.cn`，原主机与域名不变 |
| 应用 | `tennis-green-pms-app`，Compose project `tennis-green-pms`，绑定 `127.0.0.1:4200` |
| COS | 独立桶 `tennis-pms-release-1305166808`，`ap-shanghai`；私有、SSE-COS、版本控制未开启 |
| COS 加速 | 已启用；GitHub `COS_ENDPOINT=cos.accelerate.myqcloud.com`；服务器读包仍用同地域端点 |
| CAM | `tennis-release-upload`、`tennis-release-retention`、`tennis-release-reader`，各只挂对应前缀策略，不启用控制台登录 |
| 数据库 | 共享 PostgreSQL 实例 `postgres-nvcjbn1g`，独立 `tennis_demo` 库和同名 owner；PG18.4 |
| 分析角色 | `tennis_ai_analytics_reader`，NOLOGIN、非超级用户、无 CREATEDB/CREATEROLE |
| GitHub | `production` 已配置 6 个 Environment secrets；原 `RELEASE_PLEASE_TOKEN` 未改 |
| 发布入口 | 专用 SSH 密钥、可信 known_hosts、forced-command 和受限 sudo；配置由 root 管理，秘密文件 0600 |

账号凭据不在本文、Git 或聊天中。GitHub 仅持上传/清理身份，服务器仅持 COS reader 身份。日常应用与迁移仍共用库 owner，并未实现两者的 DDL 权限分离。

## 发布包及数据验证

首次普通链路上传长时间未完成，取消后确认目标前缀无完整对象；启用获授权的全球加速后，[构建和上传运行 35830471996](https://github.com/PatrickLiveCool/Tennis-PMS/actions/runs/35830471996) 成功，部署阶段按关闭开关跳过。

正式包包含镜像压缩包、manifest、SHA256SUMS、SBOM，路径：

```text
tennis-green-pms/releases/v1.5.0/597e947c1a833109523ec30849d84227560e30bc/
```

- Manifest SHA256：`8b73da15d3af46240c2cd17ab9687f1456b9758ba5d9dafda085bd5f74e884b3`。
- 服务器运行镜像 ID：`sha256:5882e3aa7662e1efc6b12f1477455abd7e8e71e6a535ce3ad7c991d870a2a817`。
- 服务器独立核验包校验和、归档、OCI 身份、加载后 rootfs；未在共用服务器构建镜像。
- 先完成预恢复；停写后重新生成 `final-028.dump`，再重建仅本次预恢复使用的目标库并恢复最终备份。旧源库未删除。
- 源库与目标库 70 张表的行数和排序后完整行签名一致；原 AI 密钥实际解密 1 条配置成功。没有重跑 seed。
- 独立执行迁移后，30 项 migration name/checksum 全部与正式 manifest 一致。AI 问题记录表与分析导出视图已存在。
- Docker、本机、公网健康和版本验证通过；应用限制 384 MiB / 1 CPU，初始检查无 OOM、无重启。
- 平台、管理员、员工、客户四类旧账号登录成功；平台 AI 配置仍有密钥；场馆、场地、客户及抽样钱包读取通过；验收登录会话已注销。

线上验证没有新建订单、充值或退款，也没有调用收费模型。因此不将上述结果称为完整预约/模拟支付/退改或真实 AI 供应商人工验收；这部分仍需业务走查。

## 恢复证据与保留边界

服务器 `/root/tennis-cutover/` 保存预备份、最终备份及校验和、旧 Compose/env 归档、原 Nginx 配置、数据核对签名和验收脚本。目录 root-only；备份不放在 COS 发布清理目录。另已保存一份本机 0600 恢复归档，位于忽略目录 `.local-workspace/tennis-dedicated-bucket/cutover-recovery-private.tgz`，与应用服务器分开保留；其中含敏感配置，不上传 Git 或公开共享。

用户另行批准旧应用退役后，`tennis-demo-app-1` 已删除；旧 `tennis-demo-postgres-1` 和 `tennis-demo_tennis-demo-data` 保留。旧镜像已完整导出到本机受限文件 `old-demo-image.tar.gz`，核验归档与镜像标签，SHA256 为 `ab035d2bbe701cfb956b866e5d2e61331f2913ae6dbf3f93068335211245794a`。服务器旧镜像已由发布工具清理，审计记录确认删除，当前只保留正式 Tennis 镜像。没有执行全机 prune，也没有删除 GreenPMS 资源。

维护预览在开关仍为 false 时完成：COS 无删除候选；当前镜像和旧容器引用镜像均保留。手工本地调用 SSH 时，known_hosts 路径必须避免空格，或正确使用 OpenSSH 配置引用；本次将其复制到受限临时目录后完成预览，GitHub runner 路径不受影响。

旧数据库和最终备份只代表停写时刻。新库恢复业务写入后，不得直接切回旧库；跨 SQL 基线需要独立恢复/前向修复窗口。正式版本策略是 `forward-only`。

## 正式接管状态

[正式重放运行 35831275476](https://github.com/PatrickLiveCool/Tennis-PMS/actions/runs/35831275476) 完成正式 manifest 登记和 COS `deployed.json` 写入；两者版本、提交和 manifest 校验值一致，无未完成事务。仓库 `TENNIS_DEPLOY_ENABLED=true`，恢复 timer 已启用并首次执行成功。

维护窗口为北京时间 15:18–15:27；公网首页恢复 HTTP 200，健康接口为 MOCK，版本为 1.5.0。手工下载的镜像压缩包和临时迁移 env 已删除。服务器仍余约 14 GiB。

该运行最后的清理检查失败：已停止的旧 Demo 容器保护旧镜像，工具按设计保留并报告外部引用。应用接管成功与流水线整体成功应分开判断。用户随后明确批准退役旧应用容器并清理旧镜像，已先完成本机旧镜像归档，再移除停止的旧应用容器，重跑失败的部署阶段后，运行整体成功；07:32:18 UTC 的清理审计确认旧镜像删除。

## 后续发布

合并业务 PR → 合并 autorelease PR → 核对 Draft Release → Publish release → 校验、上传、受限部署、健康检查及保留清理。

日常发布不会新增独立数据库容器。临时下载文件由发布工具清理，应用日志上限为 3 × 5 MB；旧镜像按引用保护规则清理。备份、数据库和其他项目文件不归该规则清理，磁盘仍需容量监控；旧 Demo 应用已退役，旧数据库容器与数据卷作为恢复材料仍保留。
