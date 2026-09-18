# MVP 完成审计与证据边界

审计日期：2026-09-19。需求依据为 [集中决策 1–12](decisions-and-acceptance.md)、[MVP 核心约束 1–11](mvp.md)、[GreenPMS 体验清单](experience-continuity.md)；运行证据为 [本地验收记录](local-acceptance.md)、[实施状态](implementation-status.md) 及本页列出的日志。需求文档内 F0/F1 等历史实施状态保留，不作为当前实现结论。

当前可以交付的是：**独立、本地可运行的 Tennis PMS，以及经自动验证和部分开发者浏览器核对的模拟交易闭环。** 真实微信对话至真实付款、退款的端到端链路尚未完成；客户人工验收尚未进行。本页不将 goal 标为完成，也不把外部 Runtime 纳入 PMS 内部开发。

本页只整理已有源码与证据，没有新增功能、运行测试或操作浏览器。浏览器记录来自主代理已完成的实际操作，均使用合成数据；它们不是客户业务签收。

## 判定口径

- **本地已实现且验证**：有对应源码及已通过的自动用例；浏览器核对仅对明确列出的场景成立。支付渠道验证指本地 MOCK 与受控支付端口。
- **实际渠道仍缺失**：真实账号、支付产品、商户或外部服务尚未接入；其中真实支付 adapter 仍有代码开发工作，不只是补配置。
- **客户人工验收未完成**：真实运营人员和客户尚未签收业务及操作体验。此状态适用于下面所有需求，不因自动测试或开发者演示而消除。

## 集中决策 1–12 对照

源码路径简写以 `packages/db/src/tennis/` 为根；测试路径简写以 `tests/tennis/` 为根。可点击的实现与测试入口另列于后文。

| 编号与需求 | 已实现及验证依据 | 未完成或限定范围 |
| --- | --- | --- |
| 1 同租户跨校区余额通用、不跨租户 | `wallet.ts`、`wallet-store.ts`、`access.ts`；`payments.integration.test.ts`、`tenant-access.integration.test.ts` 覆盖跨场馆消费和跨租户拒绝 | 本地已实现且验证；真实租户资料未导入 |
| 2 本金/赠送分账，FIFO、比例扣款、原构成退款 | `tennis-wallet.ts` 领域算法、`wallet-store.ts`、`refunds.ts`；`wallet.test.ts`、`payments.integration.test.ts` 覆盖分摊守恒、原构成恢复及并发 | 本地已实现且验证；赠送额不作为现金。真实期初拆分待核对 |
| 3 余额＋微信补差、禁止透支、原来源退款 | `payments.ts`、`payment-lifecycle.ts`、`channel-refunds.ts`；`payments.integration.test.ts`、`payment-channel.integration.test.ts` 验证预留、重复/伪回调、到期竞争、渠道恢复和多来源退款；浏览器验证余额100＋MOCK60及部分退款 | 本地资金规则已实现且验证；真实微信补差、原交易退款仍缺 adapter 与商户联调 |
| 4 线上充值、真实线下收款登记、查询与明细 | `topups.ts`、`wallet.ts`、`topup-directory.ts`；`payments.integration.test.ts`、`wallet-history.integration.test.ts`、`topup-directory.integration.test.ts`。浏览器从持久目录找回23元原单、模拟成功后本金只增加23元 | 本地已实现且验证；线下登记使用合成收款事实演示，未处理真实资金。线上真实充值渠道未接入；退卡提现/转赠/过期后置 |
| 5 同场馆多明细、全成全败、员工部分退改 | `booking.ts`、`amendments.ts`、`refunds.ts`；`booking.integration.test.ts`、`amendments.integration.test.ts` 覆盖同段多片、不同时间、单片冲突整组回滚、原单保护、部分取消/改期。浏览器实际完成双片、部分取消和连续补退差价 | 本地已实现且验证；真实资金退改仍依赖支付 adapter |
| 6 报价5分钟、普通待付款10分钟、15分钟调度、常用1小时、租户最短时长 | `booking.ts`、`catalog.ts`、`inventory.ts`、领域 `court-interval.ts`；`interval.test.ts`、`booking.integration.test.ts`、`catalog.integration.test.ts` 覆盖时间边界、过期及营业复查 | 本地已实现且验证。5/10分钟是当前实现固定默认值，不宣称有租户后台 TTL 设置；场馆最短可售时长可配置 |
| 7 人工决定退改金额与理由、AI不自行决定费用 | `amendments.ts`、`refunds.ts`、`exception-refunds.ts`、`agent-guard.ts`；对应集成测试覆盖权限、金额上限、原资金来源、迟到实收异常。浏览器核准部分退款与差价退款；F10异常120元失败→重试→成功关闭 | 本地已实现且验证；雨天/迟到/爽约使用员工判断及理由，不存在自动费用政策；真实退款待接入 |
| 8 授权未付款保留、明确截止与原因、不假记收款 | `booking.ts`、`amendments.ts`；`booking.integration.test.ts`、`amendments.integration.test.ts` 覆盖授权、截止、理由及未付调整。既有浏览器记录验证未付双片240→取消120→改场80，原截止/原因保留 | 本地已实现且验证；普通订单的待收款状态不等于到账 |
| 9 课程仅占场、基础流水核对 | `inventory.ts`、`views.ts`；`inventory.integration.test.ts`、`views.integration.test.ts`、`wallet-history.integration.test.ts`；后台 `OccupancyPanel.tsx`、`FinancePanel.tsx` 提供统一占用及核对 | 本地已实现且验证；无教练冲突、循环排课、优惠券、完整财务/教务。充值预收、赠送和消费不混加为营收 |
| 10 各租户商户直收，微信产品未选定 | `gateway.ts`、`merchant-bindings.ts`、`payment-port.ts`、`payment-channel.ts`、`business-events.ts`；Gateway/商户/支付渠道/业务事件集成测试覆盖归属、绑定、版本、去重与回执 | PMS接入契约本地已验证；实际渠道仍缺失。未选定“微信客服”，真实签名/消息收发/商户支付产品未验证；WECHAT页面仅预配置 |
| 11 平台统一AI配置、后台助手保留、Runtime体外 | `external-agent.ts`、`agent-guard.ts`、`apps/api/src/tennis/assistant-routes.ts`；助手、Agent命令、上下文集成测试。后台保留常用问题、反馈、页面/订单上下文、人工接管与消息恢复，未连接时明确提示 | PMS侧本地已实现且验证；指定模型/Base URL及体外Runtime未接入。实际语言理解、对话确认和微信自动办理不能据此称已完成 |
| 12 模拟开发、独立环境、上线前真实导入 | `local-config.ts`、`scripts/tennis/server.mts`、本地启动/迁移/种子脚本；`local-config.test.ts`及本地演示记录。启动器限定本地模拟并拒绝production | 本地开发交付具备；服务器/域名、真实价目、全部有效占用及会员期初本金/赠送资料未提供，生产部署和真实导入尚未执行 |

## MVP 核心约束 1–11 对照

| 编号 | 判定与已有证据 |
| --- | --- |
| 1 Court区间、15分钟、相邻可共存、不同片同人可重叠 | 本地已实现且验证。领域 `court-interval.ts`、数据库库存排斥约束；`interval.test.ts`、`inventory.integration.test.ts`、`booking.integration.test.ts` 覆盖边界、并发和多片 |
| 2 租场/课程/维护共库存；营业、最短时长和缓冲 | 共库存、营业与**场馆**最短可售时长本地已实现且验证，见 `inventory.ts`、`catalog.ts` 及对应集成测试。原文“各产品最短时长和缓冲时间”未形成已确认的具体销售政策；当前没有按产品独立配置的最短时长/缓冲字段。按用户后续集中确认，首期采用场馆最短可售时长、课程仅占场；未定义的产品政策不新增为本期开发阻塞或再次审批事项 |
| 3 查询不占位、写入复查、并发不能重复占场 | 本地已实现且验证。`catalog.ts`、`booking.ts`、`inventory.ts`；数据库并发测试覆盖整组回滚。F11浏览器报价后新增维护，刷新撤旧报价、保留输入、显示冲突 |
| 4 报价/占位分期限，订单/资金分状态，可信付款结果 | 本地已实现且验证。`booking.ts`、`payments.ts`、`payment-channel.ts`；付款/渠道测试覆盖未到账、伪回调和重复结果。真实微信验签、主动查单和付款操作未验证 |
| 5 改期失败保原预约，取消/库存/退款各有结果 | 本地已实现且验证。`amendments.ts`、`refunds.ts`、`channel-refunds.ts`；集成测试覆盖冲突保护、补款前保原、独立退款失败与恢复。浏览器完成补40及核准退40 |
| 6 客户本人、员工授权、相关主体留痕，接管重确认 | 本地身份、客户归属、操作者、服务凭据、会话授权与接管控制已验证，见 `auth.ts`、`access.ts`、`gateway.ts`、`agent-guard.ts` 及认证/Gateway/Agent命令测试。付款记录有客户、创建者及商户交易引用；**真实微信付款人身份**需由真实渠道适配明确、留存并验证，当前不能声称完成 |
| 7 幂等、事务复核、审计、可恢复回执 | 本地已实现且验证。`receipts.ts`、`transaction-locks.ts`及业务事务；重复请求/并发用例通过。F12成功响应截断后，充值按原回执恢复唯一原单；助手重试保持原消息和context |
| 8 HUMAN使旧Agent授权失效，确定性任务继续 | 本地已实现且验证。`external-agent.ts`、`agent-guard.ts`、`gateway-guard.ts`；助手/Agent/Gateway测试覆盖接管、撤权、原授权快照及支付/到期操作。体外Runtime真正停止工具调用仍待联调 |
| 9 完整时段多片，不拼碎时段，整组原子 | 本地已实现且验证。`catalog.ts`、`booking.ts`；资产查询与订单集成测试验证整段所需片数、不同片碎时段不可冒充、整组并发冲突回滚 |
| 10 全入口及异步动作验证租户归属、第二租户否定测试 | 本地已实现且验证。`access.ts`、认证、Gateway、Agent、商户版本、回调/事件/目录均有跨租户与撤权用例；`tenant-access.integration.test.ts`及HTTP集成不是只检验前端过滤。浏览器核对平台不默认拥有业务权限、第二合成租户停用与恢复 |
| 11 租户价格/分时折扣、分段汇总、版本快照 | 本地已实现且验证。领域 `tennis-pricing.ts`、`catalog.ts`、`booking.ts`；`pricing.test.ts`、资产/订单集成测试覆盖跨价段、舍入、多明细、重叠折扣拒绝、有效报价保价和旧订单不变 |

## GreenPMS 体验延续对照

以下“浏览器”均指开发者本地合成数据核对，十项的客户人工验收均未完成。

| 体验要求 | 实现与已有核对 | 仍需人工核对的范围 |
| --- | --- | --- |
| AI助手与个人风格 | `TennisApp.tsx`、`tennis.css`延续绿色/浅灰绿、侧栏/底栏；`AssistantPanel.tsx`保留入口、上下文、常用问题、反馈及接管。浏览器验证未接入状态、关联订单、HUMAN留言及返回原会话 | 与用户个人使用习惯的最终签收；真实Runtime回复与工具调用 |
| 排场直接办理 | `BookingPage.tsx`、`OrdersPage.tsx`默认一片一小时，按需加片/不同明细；选区进入预订、订单详情接续。浏览器验证同段双片和部分改退 | 真实运营人员按日常接单流程使用 |
| 返回原位置 | `TennisApp.tsx`作用域、滚动保存；`OrderDirectory.tsx`和订单页保留筛选/分页。已有会话关闭订单后返回核对；F12桌面工作台滚动4817.5→预订订单→返回后，异步加载完成仍为4817.5 | 真实手机、不同断点和其余长页返回位置验收 |
| 网络波动不白填 | `components.tsx`、`BookingPage.tsx`草稿和过期状态；身份/租户/场馆隔离。F11占用冲突刷新后保留客户与明细、撤销报价并禁止继续报旧价 | 真实网络切换及剩余故障场景；不能把已核对的一条路径推广为全部网络行为 |
| 明确提交结果、恢复原操作 | `components.tsx`回执恢复、`MembersPage.tsx`/`TopupHistoryPanel.tsx`持久充值目录、`AssistantPanel.tsx`原消息快照；`web-api.test.ts`、回执/目录/助手集成测试。F12已实际截断成功响应、刷新或切换订单后恢复 | 真实渠道返回/断网组合，以及跨设备恢复体验 |
| 费用与变更摘要 | `BookingPage.tsx`报价明细、`AmendmentPanel.tsx`前后对照、补退金额，底层以服务端计算为准；浏览器核对80→120补40、120→80退40及原来源拆分 | 操作人员对报价/差价/退款说明的理解与签收 |
| 老客户少重复填 | `CustomerPicker.tsx`、`MembersPage.tsx`、`customers.ts`；客户检索预填、同单共用客户，Gateway不按电话自动跨租户合并。F11无subject新客候选和人工绑定浏览器通过 | 真实客户重名、资料质量和导入后的检索习惯 |
| 今日任务可直接处理 | `TennisApp.tsx`、`views.ts`工作台入口和订单关联，`views.integration.test.ts`验证分类/权限；浏览器已使用相关订单入口 | 真实营业日的任务密度、优先顺序和手机使用 |
| 中文状态与错误引导 | `components.tsx`、`api.ts`及业务页面提供冲突、过期、待核实与未配置提示；浏览器已核对折扣冲突、占用冲突、AI未连接及响应中断状态 | 运营人员遇到其他真实错误时的可理解性 |
| 手机和键盘习惯 | 响应式导航及助手 `isComposing`/Enter/Shift+Enter 保护存在于源码；有限手机断点已核对侧栏隐藏、底栏可用、外层无显著横溢 | 真实触屏、中文输入法、全断点及焦点手感；代码检查不能代替这些人工验证 |

## 自动验证与浏览器证据

### 自动验证基线

| 基线 | 检查结果 | 原始证据 |
| --- | --- | --- |
| F11完整业务基线 | typecheck通过；单元69文件/1,284项；PostgreSQL集成22文件/276项；网球构建通过；PR格式8项 | [typecheck](/private/tmp/tennis-f11-typecheck.log)、[单元](/private/tmp/tennis-f11-unit.log)、[PG](/private/tmp/tennis-f11-integration.log)、[build](/private/tmp/tennis-f11-build.log)、[PR检查](/private/tmp/tennis-f11-pr-check.log) |
| F12助手提示修正后的基线 | typecheck通过；单元69文件/1,284项；网球build通过，资产 `tennis-PlQNya-z.js` | [typecheck](/private/tmp/tennis-f12-typecheck.log)、[单元](/private/tmp/tennis-f12-unit.log)、[build](/private/tmp/tennis-f12-build.log) |

1,284项包含继承住房系统回归，不能等同于1,284项网球独立验收。F11新增客户绑定13项、订单上下文/会话目录8项、充值目录9项PG测试包含于276项内。F12仅改助手顶部显示分支，没有后端、资金、库存或迁移改动，因此沿用F11 PG结果，未声称重新运行。构建通过不代表视觉或真实业务签收。

### 已有实际浏览器记录

- 主业务：订单 `46e7c038` 同段两片160元；余额100＋MOCK60；取消其中一片退80，拆余额50/原渠道30。改期80→120补40，再改回80核准退40，按原两笔付款分摊。详见 [本地验收记录](local-acceptance.md)。
- F10异常实收：订单 `d4427d89` 的120元迟到款，退款 `2776554b` 失败时保持OPEN，授权重试后成功转RESOLVED；记录现金负流水120，钱包变化为0。详见 [实施状态](implementation-status.md)。
- F11运营补齐：加载更多找回第22条HUMAN会话 `a6a8421a`；按订单 `e4205cfa` 搜索并打开详情；无草稿找回23元充值 `4d354dab` 并模拟完成；管理员绑定无subject合成新客；报价后加入维护 `db726181`，刷新保留输入并阻止旧报价。详见同页F11记录。
- F12充值响应截断：17元充值 `fb5aedd1` 经整页刷新按原回执恢复。DB为唯一 `topup.begin` 回执、唯一PENDING充值、第1代原渠道操作、**钱包流水0条**；这次没有执行模拟付款。见 [充值证据](/private/tmp/tennis-f12-topup-evidence.json)。
- F12助手响应截断：从订单A `e4205cfa` 发送HUMAN消息，切到B `46e7c038` 后重试仍保持相同messageId、内容摘要及context(A)；DB一条消息、零Runtime派发。修正后顶部/底部均显示原A，成功后才恢复当前B提示。见 [原消息证据](/private/tmp/tennis-f12-message-evidence.json)、[修正复核证据](/private/tmp/tennis-f12-header-fix-evidence.json)、[代理请求证据](/private/tmp/tennis-f12-proxy-evidence.jsonl)。

- F12桌面返回位置：工作台 `scrollTop=4817.5`、`scrollHeight=5717`，进入预订订单再返回，异步数据加载后位置和高度一致。见 [滚动证据](/private/tmp/tennis-f12-scroll-evidence.json)；仅证明当前桌面实例，不代替真实手机或所有断点验收。

上述F12证据由主代理浏览器执行及定点数据库核对产生；本审计读取记录，没有独立复演，也没有把HUMAN零派发当成真实Runtime调用测试。演练代理已关闭。

## 源码与测试入口

- 库存/定价/预订：[区间领域](../../packages/domain/src/court-interval.ts)、[定价领域](../../packages/domain/src/tennis-pricing.ts)、[库存](../../packages/db/src/tennis/inventory.ts)、[资产目录](../../packages/db/src/tennis/catalog.ts)、[报价订单](../../packages/db/src/tennis/booking.ts)；[库存测试](../../tests/tennis/inventory.integration.test.ts)、[资产测试](../../tests/tennis/catalog.integration.test.ts)、[预订测试](../../tests/tennis/booking.integration.test.ts)。
- 钱包/退改：[钱包领域](../../packages/domain/src/tennis-wallet.ts)、[支付](../../packages/db/src/tennis/payments.ts)、[充值](../../packages/db/src/tennis/topups.ts)、[退款](../../packages/db/src/tennis/refunds.ts)、[改期](../../packages/db/src/tennis/amendments.ts)、[异常退款](../../packages/db/src/tennis/exception-refunds.ts)；[支付测试](../../tests/tennis/payments.integration.test.ts)、[改期测试](../../tests/tennis/amendments.integration.test.ts)、[异常退款测试](../../tests/tennis/exception-refunds.integration.test.ts)。
- 租户/外部协作：[权限](../../packages/db/src/tennis/access.ts)、[Gateway](../../packages/db/src/tennis/gateway.ts)、[外部助手](../../packages/db/src/tennis/external-agent.ts)、[业务事件](../../packages/db/src/tennis/business-events.ts)；[租户测试](../../tests/tennis/tenant-access.integration.test.ts)、[客户绑定测试](../../tests/tennis/gateway-customer-binding.integration.test.ts)、[上下文测试](../../tests/tennis/operator-context.integration.test.ts)、[HTTP测试](../../tests/tennis/api.integration.test.ts)。
- 支付渠道边界：[支付端口](../../packages/db/src/tennis/payment-port.ts)、[渠道操作](../../packages/db/src/tennis/payment-channel.ts)、[商户版本](../../packages/db/src/tennis/merchant-bindings.ts)、[本地启动器](../../scripts/tennis/server.mts)；[渠道测试](../../tests/tennis/payment-channel.integration.test.ts)、[商户测试](../../tests/tennis/merchant-bindings.integration.test.ts)。
- 后台体验：[应用](../../apps/web/src/tennis/TennisApp.tsx)、[排场](../../apps/web/src/tennis/BookingPage.tsx)、[订单](../../apps/web/src/tennis/OrdersPage.tsx)、[助手](../../apps/web/src/tennis/AssistantPanel.tsx)、[充值目录](../../apps/web/src/tennis/TopupHistoryPanel.tsx)、[恢复组件](../../apps/web/src/tennis/components.tsx)；[前端API测试](../../tests/tennis/web-api.test.ts)、[充值目录测试](../../tests/tennis/topup-directory.integration.test.ts)、[订单目录测试](../../tests/tennis/order-directory.integration.test.ts)。

## 剩余事项与完成边界

本轮只读配置核对显示：AI `enabled=false`，模型、Base URL、Runtime端点及密钥均未配置；商户记录只有MOCK共2个版本。见 [外部配置状态](/private/tmp/tennis-f12-external-state.json)。此证据未输出凭据。F12浏览器、DB与构建证据已汇总保存于 [总项目验证日志](</Users/feather/Documents/Codex project/Tennis/outputs/Tennis-PMS-F12-verification.log>)。

1. **真实支付adapter仍需开发及验证。** 当前 `CheckoutAction` 仅有 `LOCAL_SIMULATION`，本地启动器只实例化MOCK；WECHAT配置不是可用的微信付款。需要确定租户商户及支付产品，接入真实发起、付款人/交易事实、签名回调、主动查单、原交易退款和渠道异常核对，证明款进入正确租户账户。
2. **真实微信入口和体外Runtime需要联调。** 微信产品、账号、消息签名、真实首绑、回复通道及指定模型/Base URL未提供。PMS已有受控接口、上下文、事件与接管；不在PMS内补造智能体Runtime，不把模拟绑定或人工留言冒充微信智能体服务。
3. **目标环境和真实资料未就绪。** 服务器、域名、真实场地价目、有效预约、会员期初本金/赠送拆分尚缺；部署、回调可达及实际导入核对未完成。
4. **客户人工验收未完成。** 运营人员需走实际接单、退改、储值、台账与接管流程，并核对手机、输入法及返回操作习惯；开发者合成数据证据仅作为验收准备。
5. **旧规格措辞按后续确认收敛。** 首期场馆最短可售时长可配置，报价5分钟、普通待付款10分钟按已确认数值执行；没有租户TTL后台。旧文的产品独立时长/缓冲尚无具体政策，且首期课程仅占场，因此不作为新的必做模块或审批事项。真实付款人渠道事实留待实际支付适配核对，不能将当前模拟交易说成已经验证。

人人匹配、优惠券、余额提现/转赠/过期、完整财务与教务、自动循环排课、自助SaaS套餐和生产发布均不因本页自动加入本期。更完整的接入边界见 [外部接入状态](external-integration-gaps.md)，交付剩余条件见 [本地验收现状](remaining-local-acceptance.md)。
