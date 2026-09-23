# Tennis 发布接入与现有 Demo 首次接管

2026-09-23：本文件保留首次接管操作顺序与恢复契约。真实资源、迁移及验证记录见 [首次接管执行记录](tennis-adoption-2026-09-23.md)。后续执行必须先查现场状态，不能重跑创建账号、建库或首次数据恢复。

## 资源与隔离

| 对象 | 现状 / 目标 |
| --- | --- |
| 共用主机 | `122.51.77.220`，Tennis 仅绑定 `127.0.0.1:4200`，HTTPS 反代保持现有入口 |
| 独立 COS | `tennis-pms-release-1305166808` / `ap-shanghai`；私有、SSE-COS、全球加速；只允许 `tennis-green-pms/releases/` |
| 旧项目 | `tennis-demo`；app `tennis-demo-app-1`；DB `tennis-demo-postgres-1`（PG16.14） |
| 旧数据 | volume `tennis-demo_tennis-demo-data`；镜像 `tennis-demo:c80696a`（以现场完整 tag/ID 为准）；全部保留至验证和单独清理确认后 |
| 目标项目 | `tennis-green-pms`；容器 `tennis-green-pms-app`；配置 `/etc/tennis-green-pms/`；状态 `/var/lib/tennis-green-pms-release/` |
| 受限发布身份 | `tennis-green-pms-deploy`，forced-command + 固定 sudo entry；不能任意执行 shell / 迁移 / seed |
| 外部数据库 | 现有实例 `10.80.0.15`（PG18.4），新建独立 `tennis_demo` 库和 `tennis_demo` 登录角色；已创建并完成数据迁移 |

住房库 `qintopia_pms_prod` 和账号 `qintopia_runtime` 不得作为网球目标或迁移管理员；后者本来没有 CREATEDB/CREATEROLE。日常网球角色保持 NOSUPERUSER NOCREATEDB NOCREATEROLE，不给应用永久集群管理权限。服务器 59G、已用 44G、余 14G 是本轮快照，不是窗口容量保证；上线前核算旧镜像、目标解压包、备份、数据库空间并留余量，禁止全机 prune。

## 在本地准备，不写云端

```bash
python3 scripts/release/setup.py \
  --bucket tennis-pms-release-1305166808 --region ap-shanghai \
  --public-host tennis.qintopia.cn \
  --output .local-workspace/tennis-onboarding-NEW
```

`--public-host` 使用已核对的现有 Demo HTTPS 主机名，不修改 DNS。生成目录必须不存在。产物为 `deploy.json` 与 upload / retention / reader 三份 CAM policy，不含密钥。当前独立桶材料位于忽略目录 `.local-workspace/tennis-dedicated-bucket`；旧 `.local-workspace/tennis-onboarding-20260923` 指向共用桶，不再用于安装。

沿用同一个 `production` GitHub Environment（这里是发布环境名称，应用仍然是模拟 Demo）。仓库变量 `TENNIS_DEPLOY_ENABLED` 初始保持未设置或 `false`。关闭时 Release 可以验证并上传 COS，但不进入 deploy job；rollback 和 retention（包括定时任务）也不会连接服务器。此开关是**仓库变量**，不能只设置在 Environment，因为 job 的 if 在读取 Environment 前求值。

首次接管所需配置（已配置，后续按实际变更维护）：

- 仓库/Environment 变量：`COS_BUCKET=tennis-pms-release-1305166808`、`COS_REGION=ap-shanghai`、`DEPLOY_HOST=122.51.77.220`、`DEPLOY_USER=tennis-green-pms-deploy`；本环境已设置 `COS_ENDPOINT=cos.accelerate.myqcloud.com`，全球加速费用按实际用量计费。
- Secrets：独立 `UPLOAD_COS_SECRET_ID/KEY`、`RETENTION_COS_SECRET_ID/KEY`（临时凭据另带 TOKEN）、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。服务器只保存独立 reader 凭据，不能保存 upload/retention 身份。Release Please 继续使用现有 `RELEASE_PLEASE_TOKEN`。
- 核验桶从未开启 versioning，CAM 的 list 条件和对象权限只覆盖 Tennis 前缀，现有住房策略不变。SSH host key 由管理员从可信渠道核对，不能用未经核验的 ssh-keyscan 替代信任。
- 首次只发布已合并 main 的正式 tag，保持部署关闭；Release workflow 运行测试、网球 PG18 集成（原业务 CI 保留 PG16，覆盖两个主版本）、构建并上传四个不可变文件。部分 COS 包会 fail closed，不覆盖、不临时篡改 tag。

`deploy/install.sh --dry-run --deploy-public-key <公钥文件>` 仅在满足脚本依赖的目标 Linux 环境审查安装计划；正式安装命令仍由管理员窗口执行。安装器不写 app/COS 配置、不启用 recovery timer、不启动容器、不执行 adopt。以下命令是操作方法；实际执行证据以首次接管执行记录为准，不据此重复操作。

## 冻结版本、备份和预恢复

1. 记录旧容器完整 image ID、tag、Compose 文件路径、只读 `/version`、业务停写方法和 Nginx 配置。把旧 Compose、env、原 AI 加密密钥和支付签名密钥备份在 root-only 目录（0700/0600），不得输出到终端、聊天或 Git。**原 AI 密钥必须保留**，否则数据库密文不可解密。不要执行 cloud-demo-init / seed，也不要复用住房 env。
2. 取得目标 Release 的 `manifest.json`、SHA256SUMS、SBOM、压缩镜像，按 `cos.py fetch` 验证完整 bundle，再解压并由 `package.inspect_archive` 校验归档身份，才执行 docker load。使用 main 的受信 harness，源码身份来自目标 tag；不在共用服务器构建。目标镜像参数均来自 manifest，不手写版本冒充目标。
3. 比较旧 `public.tennis_schema_migrations` 的 name/checksum 与 manifest。现场旧基线为 001–028，本轮与源码逐项一致；当前目标包含 029/030，实际窗口以冻结 tag 的 manifest 为准。SQL 增加或 checksum 不同必须独立迁移，不能依靠普通 deploy/rollback。
4. 在 root-only 备份目录执行旧库逻辑备份；旧库仍可写的首轮备份仅用于预演，不是最终切换依据：

```bash
umask 077
mkdir -p /root/tennis-cutover
chmod 700 /root/tennis-cutover
docker exec tennis-demo-postgres-1 pg_dump -U tennis_demo -d tennis_demo -Fc \
  > /root/tennis-cutover/preflight-028.dump
sha256sum /root/tennis-cutover/preflight-028.dump > /root/tennis-cutover/preflight-028.dump.sha256
```

5. 外部实例 DBA 先确认目标库不存在、无业务表、无同名冲突角色。用受限 `.pg_service.conf` / `.pgpass` 或受限文件提供管理员身份，不把 URL/密码写进命令历史。创建独立 `tennis_demo LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`，密码只经受限输入；创建 owner 为 tennis_demo 的 `tennis_demo` 空库。库级撤销 PUBLIC CONNECT 并只授予网球需要的角色，不更改住房数据库或现有账号。
6. 确认 `btree_gist` 可用，由库 owner tennis_demo 在恢复中创建可信扩展，避免管理员抢先创建导致恢复扩展 COMMENT 的 owner 冲突；030 需要 `tennis_ai_analytics_reader`，DBA 预建 **NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE** 角色，避免给应用 CREATEROLE。先审查 030 的 GRANT 与既有同名角色；有冲突则停止，不能覆盖未知角色。迁移以库 owner tennis_demo 执行，DBA仅提前准备可用性与全局角色，恢复扩展及迁移对象保持tennis_demo所有权。
7. 通过 PG18 客户端恢复到**新建的空 tennis_demo 库**。示例 service `tennis_external_admin` 应指向该库，不是住房库：

```bash
pg_restore --dbname='service=tennis_external_admin' --role=tennis_demo \
  --no-owner --no-privileges --single-transaction --exit-on-error \
  /root/tennis-cutover/preflight-028.dump
```

不用 `--clean`，恢复遇到既有业务数据、扩展错误或角色错误即停止。逐表比较旧业务行数、关键订单/余额/本金赠送/占用、迁移 name+checksum，以及 AI 密文能否用原密钥解密（仅输出成功/失败，不输出密钥或明文）。先在隔离预恢复环境完成；正式库若已做预恢复，最终恢复必须由 DBA 明确处理这个仅用于预恢复的目标副本，绝不能把最终 dump 追加到非空库。

## 停写、最终同步与目标镜像接管

1. 进入已确认维护窗口，先在 HTTPS 入口展示维护并阻止普通用户业务访问，同时保留 `/health`、`/version` 只读路径和限定管理员验收访问；不能用全站503阻断公网健康门禁。管理员验收在恢复普通用户入口前进行。再停止 `tennis-demo-app-1`，等待在途请求结束；旧 DB 继续运行。停 app 也停止后台过期任务，避免只挡网页却仍写库。记录停写时间，确认无其他外部写入者。
2. 重做最终 `pg_dump -Fc` 和 checksum，单独命名 `final-028.dump`；保留预恢复证据、最终备份与旧 volume。把最终备份恢复到 DBA 确认的**空目标库**，按上节重做表行数、迁移历史、关键资金和 AI 解密校验。任何差异先停止，不启动目标服务。
3. 单独迁移到目标 manifest 的 SQL。标准镜像包含 `scripts/tennis/release-migrate.mjs`，不会自动迁移，也不包含 seed。把 `TENNIS_MIGRATION_DATABASE_URL` 放在 root-only 临时 env 文件（目标库和登录角色必须都是 tennis_demo，DBA已预建所需全局角色；不得改用管理员登录生成管理员所属业务表）。该入口隔离管理员调用和配置文件，不构成数据库 DDL 权限隔离：日常 app 与迁移目前使用同一个 tennis_demo owner，app 账号仍具有该库对象的 owner 权限。不要把独立环境变量解释为独立高权限身份。明确调用：

```bash
docker run --rm --network bridge --env-file /root/tennis-cutover/migration.env \
  --user node --read-only --tmpfs /tmp:rw,size=32m --cap-drop ALL \
  --security-opt no-new-privileges:true \
  "$TARGET_IMAGE" node scripts/tennis/release-migrate.mjs --apply
```

`TARGET_IMAGE` 为已验证 manifest 的 imageTag，不是 latest。网络须能访问外部实例；先核对安全组/路由。迁移用 advisory lock + 单事务，锁等待最多30秒、单条SQL最多10分钟；错误仅记录固定分类及白名单SQLSTATE，不输出原始SQL/连接串。失败会回滚，必须查状态后再重试；不额外注入任意命令配置。完成后再次比较全部 migration name+checksum（manifest 使用 sha256 字段）。删除不再需要的临时迁移配置文件（不会因此撤销日常owner的DDL权限），确认日常角色仍无 superuser/CREATEDB/CREATEROLE。

4. 从已审核 main 的锁定 commit 安装受限发布工具；把生成的 deploy.json、正式 `compose.server.yaml`、填好的 `deploy/app.env.example`、reader 凭据安装到 `/etc/tennis-green-pms/`，root-owned、不允许组/其他用户写，秘密文件0600。Compose 明确设置 development + 模拟 Demo，镜像默认 production 禁模拟的保护保持不变。外部 URL 只允许 tennis_demo 库/角色；设置现有单一 HTTPS origin 与**实际反代到容器的精确 peer IP**（Docker bridge gateway），不能填写网段或通配符。网络创建后检查 gateway，更新受限 env，再启动 app；adopt 之后不擅自改配置 hash。
5. 旧 app 已停止释放4200，再使用新项目同端口接管；不要 `docker compose down -v`，不要删除旧 app/DB/volume：

```bash
TENNIS_GREEN_PMS_IMAGE="$TARGET_IMAGE" docker compose --project-name tennis-green-pms \
  --file /etc/tennis-green-pms/compose.server.yaml --env-file /etc/tennis-green-pms/app.env \
  up --detach --no-build --pull never app
```

6. 验证 Docker healthy、本机及公网 `/health`、`/version`（version/revision 与 manifest 完全相同）。受限入口还会校验 OCI labels/归档/rootfs。管理员人工验证已有用户登录、场地排场、原订单及余额、模拟预约支付退改、后台 AI 原配置读取/连接和原密文解密；保留模拟标识，不把合成 AI 测试当真实供应商验收。恢复公网写入前确认上述检查全部通过。
7. 把**目标 manifest** 的 requiredMigrations 提取为 root-owned JSON；获取目标运行容器真实 image ID。只有健康目标上线并且数据库已迁移一致后，才登记 adopt：

```bash
sudo /usr/local/sbin/tennis-green-pms-deploy adopt \
  "$TARGET_VERSION" "$TARGET_REVISION" "$TARGET_RUNTIME_IMAGE_ID" \
  /root/tennis-cutover/target-migrations.json
```

首次状态是 legacy adoption，随后的同镜像 release 重放会验证 bundle、tag、labels、版本/commit、SQL与rootfs，转为正式 manifest 状态，不重启健康目标。**不能 adopt 旧 `1.4.3-demo` 并填入新版身份或新版 SQL**；adopt 不迁移数据库，版本字符串也不能代替数据库核验。
8. **开关保持 false 时先预览清理**。管理员在受信 main harness 工作目录，以受限 SSH key / verified known_hosts 和 Tennis retention 身份运行下列命令；凭据通过0600本地文件装入进程，不打印或粘贴到命令中。需要 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY_FILE`、`DEPLOY_KNOWN_HOSTS_FILE`、`COS_BUCKET`、`COS_REGION`、`RETENTION_COS_SECRET_ID/KEY`（可选TOKEN）。该入口支持尚未转正式manifest的 legacy adoption，也持有服务器发布锁：

```bash
python3 scripts/release/orchestrate.py maintenance --dry-run
```

审查 COS 删除候选与本地镜像计划，确认当前/上一版本、所有运行和停止容器引用保护正确；保留旧 app/DB/volume，不用删引用来让检查变绿。**批准 `TENNIS_DEPLOY_ENABLED=true` 同时允许普通部署重放、回退和定时真实清理**，不是只开上传/重放；必须先完成上述预览和清理范围确认，不等开关打开后再首次预览。
9. 人工验收和清理预览通过后，才打开仓库开关，从 main `workflow_dispatch release.yml` 重放同一已发布 tag。确认正式 manifest SHA/COS prefix、deployed.json 和状态一致。部署重放本身也执行限定清理；旧容器引用保护旧 tennis-demo 镜像，可能使清理 job 报“外部引用”，不会误删。旧容器退役需另行同意，旧 DB/volume及备份按恢复计划保留，自动清理不删卷。确认正式状态稳定后再启用 recovery timer。日志沿用应用3×5m与发布audit按周轮转12份。

## 后续跨 SQL 基线的管理员重新接管

普通 deploy/rollback 不迁移SQL。以后发布包含新SQL或checksum变化时，先完成备份/停写和前向修复方案，然后执行独立窗口：

1. 设置 `TENNIS_DEPLOY_ENABLED=false`，停止 recovery timer，确认已有 release/rollback/retention job 和 recovery service 均已退出；改开关不会取消正在执行的job。禁止在另一个发布事务持锁时操作。
2. 管理员取得 `/var/lib/tennis-green-pms-release/deploy.lock` 的独占 `flock`，保全旧 `state.json`、可能存在的 `transaction.json`、audit及配置hash证据到root-only窗口目录。若有未完成journal，先核实真实运行镜像、数据库基线和已提交状态；状态不明则停止，不通过删journal绕过恢复。
3. 在锁内按本文件停写/最终备份步骤执行独立迁移及目标镜像接管，保留旧状态原文。只有数据库实际达到目标manifest基线、目标版本健康且业务/AI验证通过后，才把旧state和已核实的journal**原样归档**并移出活动状态路径；不编辑旧state里的版本、SQL或checksum来伪造基线。
4. 保持自动开关/timer关闭且无其他管理员并行操作，释放管理员锁，再执行目标真实身份的 `adopt`（该入口会自行取得同一把锁，不能在外层持锁时嵌套调用）。新state只登记当前目标基线，不把跨基线旧镜像留作 `previous` 直接回退。旧证据和旧镜像另存为成对数据库恢复材料。
5. 重新执行关闭开关时的 `maintenance --dry-run`，审查清理范围，再批准开启开关、重放该目标release、核验正式manifest，最后开启timer。归档窗口及恢复材料不得被镜像清理替代。

## 部分 COS 上传失败的恢复

部分前缀会使正常 release replay 的 fetch 拒绝继续。管理员先保持部署开关false，暂停/等待release上传与retention工作流退出；记录目标version/revision和完整前缀，以唯一窗口操作人锁定该前缀，禁止并发上传/删除。仓库开关不阻止package-upload，所以不能仅改开关就假定没有上传job。

若保留了**可信原始runner bundle**，先在本地核验manifest身份、四文件checksum和归档身份，确认远端残存对象内容与原包一致、无矛盾成功marker；用受限upload身份运行：

```bash
python3 scripts/release/cos.py upload --directory /restricted/original-runner-bundle \
  --prefix tennis-green-pms/releases/
```

当前 `upload_bundle` 先验证本地bundle；`put_immutable` 对已有同checksum对象只读复用，仅补缺失对象并回读验证，内容不同即拒绝，禁止覆盖。不要为此重新构建一个“看起来同版本”的包；新的createdAt/镜像字节不能替代原包。正常runner清理可能已删除原始文件，没有可信原包时此路径不可用。

若原包不存在，管理员只能在审查确认这是**从未部署且无成功 `deployed.json` 的残缺候选**后恢复：核对当前/previous/rollbackFrom、所有服务器状态与容器引用、活动工作流及COS对象清单；保存清单/残存manifest和checksum证据，逐一删除这个精确 `tennis-green-pms/releases/<version>/<revision>/` 下经审核的残缺对象，再从可信tag重建。出现成功marker、部署引用、未知对象或身份矛盾立即停止并调查；不能扩大到版本父目录、住房前缀或覆写已部署包。删除只用独立管理员受限权限，并在完整窗口中阻止竞争。首次上传普通链路超时后取消任务，确认前缀无完整对象，再启用已授权全球加速重跑；没有删除已部署发布包。

## 失败和恢复边界

- 首次失败需要退旧时，先关闭部署开关、停止recovery timer并确认无运行job/service，取得发布flock，保全新旧state/journal和配置证据，写明状态恢复计划；不能让自动恢复继续把旧app切回失败目标。旧 `1.4.3-demo` 不符合正式adopt版本合同，回旧后保持自动化关闭，旧目标state/journal原样归档，不改内容伪装旧版，待下一次目标健康后按重新接管路径恢复自动化。
- 未迁移/未恢复公网写入：先前向修复配置、权限或目标镜像；确需退旧，停止目标 app，保留目标库证据，确认旧028库仍为停写时副本后启动旧 app。若旧库曾被改动，必须先把 final-028.dump 恢复到独立空PG16库并校验，再用旧镜像和原密钥恢复；不能仅回退 Git tag。
- 目标迁移失败：事务回滚后核对真实迁移历史；保留旧容器与备份，修复管理员权限/扩展/SQL问题，不手改迁移checksum。迁移成功但健康失败：保持停写，优先修复目标；如必须回旧，需要匹配028数据库和旧镜像成对恢复。
- **开始新写入后**：旧库和 final-028.dump 已陈旧，禁止直接切回。先停写并备份目标最新库，分析和核对新增订单/资金/占用，执行单独批准的数据恢复/补偿或前向修复窗口；PG18新库不能当作PG16自动降级源。
- 日常同基线镜像切换失败会恢复上一容器；只要 SQL 列表或checksum不同，deploy/rollback均在切换前拒绝。恢复旧工具遗留跨基线未提交 journal 同样拒绝，保留 journal 给管理员调查；已提交目标只恢复自身基线。自动化不会做迁移、seed或数据库回退。
- 状态已健康、COS marker/retention失败：保留当前应用，检查后重放，不能以清理失败为由删库或改版本。dry-run不删资源、不改变发布state。

## 验证证据与尚未完成

本轮本地合成PG16.15→PG18.6的逻辑转移、028→030和重复迁移通过：68张旧业务表行数及迁移checksum一致，原合成AI密钥解密通过，低权限tennis_demo在DBA预建NOLOGIN reader角色后恢复可信扩展并迁移成功，028恢复副本通过，合成住房哨兵不变。日志 `.local-workspace/release-transfer-rehearsal.log`。这不是线上PG16.14→18.4兼容性或生产验收的替代。

工作流、release harness、构建/runtime及本地Docker验证见实施状态。真实执行结果及尚未覆盖的人工业务验收见 [首次接管执行记录](tennis-adoption-2026-09-23.md)。合成演练与线上验证分开记录。
