# GreenPMS 体验延续清单

开发快照来源：总项目 `Tennis/docs/GreenPMS-体验延续清单.md`。

日期：2026-09-18。本文是网球 MVP 的体验约束，随对应业务功能实施；不是已完成界面的验收报告。

## 继承原则

用户明确要求：在满足网球业务的前提下，尽量保留 GreenPMS 的视觉效果、操作习惯和个人风格；**后台 AI 助手必须保留**。这不是可在精简 MVP 时删除的可选项。

参照 Green PMS v1.4.3，commit `47eb658a20aee5fc469a6ecbb17444999385da6a` 的源码。历史截图用于核对风格，若与当前源码不同，以当前源码和最新业务决定共同确定适配结果。

- 延续深绿主色（`#176b4d`）、浅灰绿背景（`#f4f6f3`）、白色内容区、细边框、中文系统字体、现有按钮/表单/弹窗/状态标签体系，以及原有信息密度。复用原组件和样式，不另换整套设计模板。
- 延续桌面侧栏、手机底部导航、当前经营地点切换和工作台的操作习惯。必要变化围绕网球业务：房态变为排场，住房按天变为球场按时段；校区与场馆是同一层。
- 常用订场从一片、1 小时开始；调度精度为 15 分钟。增加同段多片和特殊的不同时间明细按需展开，日常接单不必填写全部高级选项。
- 易用性随排场、订单、客户、定价和 AI 切片一起验收，不另建一套独立业务模块。继承界面习惯不意味着继承住房账务、房晚权益或生产配置。

## 必须延续的能力与验收目标

下表的“原系统依据”指已核对的上游源码行为；“网球适配与验收”是后续开发目标，当前尚未完成网球适配。

| 能力 | 原系统依据 | 网球适配与验收 |
| --- | --- | --- |
| 后台 AI 助手 | 桌面/手机入口、当前页面与订单上下文、常用提问、查询工具、打开业务入口、反馈 | 保留入口与面板；适配查空场、查客户/订单、解释报价、引导代订和改期。与微信入口调用同租户 PMS 能力；不能绕过权限和确认。已有表单未完成时不强行跳走 |
| 在排场上直接办理 | 网格选区、快捷操作、订单上下文抽屉 | 选片场和时间即可进入预订；点击已有预约查看详情和可执行动作。增加多片时保留已填客户信息；同一笔订单的实际明细可定位，不把间隙显示成占用 |
| 返回后还在原位置 | 排场滚动/焦点恢复、订单列表筛选及分页返回 | 从订单详情返回保留日期、场馆、筛选和滚动位置；数据更新后重新校验选区，不能把已被占用的选择继续当作可售 |
| 网络波动不白填 | 读失败保留已显示内容；同身份、同权限且业务依据未变时保留输入 | 后台刷新失败不清空正在填写的预约，提示数据过期并暂停新提交；恢复后复核。切换身份/租户/权限时清除或隔离旧草稿，不跨租户复用 |
| 提交结果明确、避免重复下单 | 预览、确认、回执与未知结果恢复流程 | 展示正在提交、已成功、未执行或结果待核实；超时先查原操作，不诱导再次扣款/占场。多人或多片请求只能按实际结果报成功 |
| 改动和费用看得懂 | 变更摘要、前后效果和金额展示 | 确认前显示原/新球场、时间、各明细费用、折扣依据及总价。涉及补退金额按后续确定的规则展示，不从 UI 自行推导免费取消或退款政策 |
| 老客户少重复填写 | 客户检索、选择后预填、从客户档案进入业务 | 在授权租户内查找客户，带入已知资料到订场；一次多片仅关联同一客户档案。不同租户不能因手机号相同自动合并业务档案 |
| 今日任务可直接处理 | 工作台分类任务、数量、直接进入办理；手机任务视图 | 用网球已定义的状态展示今日预约和待处理事项，直接打开相关订单；保留手机任务视图，不把密集桌面网格简单缩小。此项不自动新增签到、教务或复杂财务模块 |
| 状态和错误告诉人下一步 | 中文业务错误、辅助说明、状态标签 | 说明哪片场/哪段时间冲突、需要刷新或补哪项信息；文字配合颜色，区分失败与结果未知。技术细节按需展开，不要求工作人员理解内部协议 |
| 熟悉的手机与键盘操作 | 响应式布局、焦点管理、侧栏折叠、中文输入保护 | 延续侧栏/底栏和表单手感；保留中文输入不误发送、桌面 Enter/Shift+Enter 习惯及手机适配。记忆设置按身份/租户/场馆隔离，当前租户和场馆始终可辨认 |

## AI 助手的明确边界

后台 AI 助手与微信 Agent 是两个使用入口。后台入口服务正在使用 PMS 的员工，能携带当前页面/订单上下文；微信入口服务客户及员工的对话办理。两者访问同一套 PMS 业务事实、租户权限与交易规则，但不据此假定自动共享完整聊天历史或必须使用相同 Runtime。

GreenPMS 原助手已有订单/会员/可用性查询、订单详情和打开业务入口；它当前采用只读查询与入口引导，不能将“保留原助手”描述为已经具备自动订场、改期、收退款能力。网球写操作按已确定的业务流程接入受控接口，确认、幂等、权限和回执由 PMS 保证。

延续问题推荐、“已解决/未解决”反馈与受控的问题分析能力。原有脱敏提问记录不等于完整会话持久恢复；本轮不承诺刷新后恢复完整聊天记录。

切换身份、租户或场馆时，清理不再适用的助手上下文，并丢弃旧上下文的迟到响应；保留输入和位置不能成为跨租户泄露的原因。原系统 AI 配置存在 installation 级作用域，不能原样向所有租户开放。用户已明确：模型和 Base URL 由我方平台统一配置，租户不配置；智能体及 Runtime 在 PMS 外部。本次保留助手 UI、受控业务接口与外部服务适配，不新建 PMS 内的 Runtime；指定参数和实际外部服务待接入。

## 本次没有新增的业务范围

会员人民币储值现已由用户另行明确纳入本期，按消费金额扣款且不另加会员折扣，见 MVP 与开发决策清单。本体验清单仍不自动纳入房晚权益转换、优惠券、营销自动化、完整教务、语音助手或任何交易的任意撤销。住房专属权益不能换名后直接使用。

时段折扣另已确认：同一球场、同一使用时间最多命中一条有效时段折扣，未命中时用基础价；重叠配置必须解决后才能生效，不自动叠加或选择优先级。会员身份不再引入额外折扣；优惠券首期后置。

## 证据索引

以下均为原 Green PMS 文件，供实施时定点复用，本轮未修改原系统。

| 主题 | 源码或记录 |
| --- | --- |
| 样式与应用布局 | [styles.css](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/styles.css>)；[session.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/session.tsx>) |
| 助手入口、上下文与工具 | [Assistant.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/assistant/Assistant.tsx>)；[服务端 assistant.ts](</Users/feather/Documents/Codex project/Green PMS/apps/api/src/assistant.ts>) |
| AI 反馈与问题记录 | [AssistantFeedback.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/assistant/AssistantFeedback.tsx>)；[ai-question-records.md](</Users/feather/Documents/Codex project/Green PMS/docs/operations/ai-question-records.md>) |
| 排场与返回位置 | [InventoryPage.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/pages/InventoryPage.tsx>)；[RoomStatusGrid.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/room-status/RoomStatusGrid.tsx>)；[RoomStatusQuickPopover.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/room-status/RoomStatusQuickPopover.tsx>) |
| 刷新与草稿保留条件 | [f01-f05-read-reliability.md](</Users/feather/Documents/Codex project/Green PMS/docs/implementation/f01-f05-read-reliability.md>) |
| 核对、变更摘要与提示 | [ui.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/ui.tsx>)；[uiBasic.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/uiBasic.tsx>) |
| 客户与今日任务 | [MembersPage.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/pages/MembersPage.tsx>)；[TodayPage.tsx](</Users/feather/Documents/Codex project/Green PMS/apps/web/src/pages/TodayPage.tsx>) |
| 历史视觉参考 | [桌面截图](</Users/feather/Documents/Codex project/Green PMS/docs/audits/user-journey-2026-09-06/evidence/inventory-1440.png>)；[手机截图](</Users/feather/Documents/Codex project/Green PMS/docs/audits/user-journey-2026-09-06/evidence/inventory-375.png>)。截图早于 v1.4.3，部分导航和 AI 入口尚未包含 |

## 当前完成口径

本轮完成上游源码和历史截图核对、体验清单及 MVP 约束同步。Tennis PMS fork 仍保留相关住房源码，但网球排场、租户后台和 AI 工具尚未适配；没有启动新版界面或完成网球 UI 人工验收。本轮仅修改文档，核对链接与规格一致性，不重跑业务测试。
