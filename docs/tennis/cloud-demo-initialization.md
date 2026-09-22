# 公网 Demo 初始化

`cloud-demo-init.mts` 只负责专用网球 Demo 的合成数据，不自动迁移。先运行独立网球迁移，再运行初始化，最后启动服务。源码入口：`node --import tsx scripts/tennis/cloud-demo-init.mts`；编译后的容器入口：`node scripts/tennis/cloud-demo-init.mjs`。

必须显式提供 `TENNIS_DEMO_MODE=true`、`TENNIS_ALLOW_SIMULATION=true`、`NODE_ENV=development`。`TENNIS_DATABASE_URL` 的库名和数据库用户均须为 `tennis_demo`，不得带 URL 参数；连接后会再核验实际库名和身份。初始化不会读取住房配置、本地演示凭据或本地 AI 配置。

四个账户的密码通过环境变量独立传入，不写入源码或初始化日志，均须为 20–256 字符且彼此不同，也不能与数据库密码相同或包含本地公开默认密码：

| 账号 | 密码变量 | 权限 |
| --- | --- | --- |
| `demo.platform` | `TENNIS_DEMO_PLATFORM_PASSWORD` | 平台运营，供部署方配置云端 AI |
| `demo.green` | `TENNIS_DEMO_ADMIN_PASSWORD` | 格林网球管理员 |
| `demo.staff` | `TENNIS_DEMO_STAFF_PASSWORD` | 两校区前台，预订、会员、授权退改 |
| `demo.customer` | `TENNIS_DEMO_CUSTOMER_PASSWORD` | 合成演示球友，只访问自身订单和余额 |

首次初始化要求网球库没有租户、账号和主体。生成一个“格林网球”租户，省体、高新两个校区，每校区四片场地，营业时间每天 07:00–23:00，最短预订 30 分钟。另生成三位带合成手机号的会员、合成充值余额及充值方案；两个校区各有一笔次日 18:00–19:00 的已支付订单、一段课程和一段维护排场。订单使用合成钱包余额结清，初始化不会发起真实收款或商户调用。

所有初始化业务写入和 `tennis.cloud_demo_initializations` 清单在一个 PostgreSQL 事务内提交；业务 API 的内部事务映射为保存点，失败全回滚。并行初始化由专用事务锁串行化。成功后重跑会核验清单并返回 `already-initialized`，不会重置密码、补发余额、移动订单日期或覆盖客户试用数据。若连接在提交阶段断开，先查询清单，再重跑核验；若已有业务记录但没有初始化清单，脚本会拒绝继续，不尝试删除或合并。

本地 `demo.mts` 仍保留第二租户用于隔离验收；已有演示球友缺手机号时，只补齐缺失联系信息，不覆盖现有手机号。公网初始化不创建第二租户。

验证涵盖环境/数据库/密码门禁、真实 PostgreSQL 保存点、途中 SQL 失败后的全量回滚、重跑不重复资金或重置密码。集成测试限定 `tennis_test`，保留既有测试数据，测试生成的所有数据最终回滚。公网空库、迁移顺序、编译入口和容器冷启动由部署编排另外验证。
