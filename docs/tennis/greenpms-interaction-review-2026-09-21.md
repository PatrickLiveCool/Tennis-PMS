# GreenPMS 交互更新核对与网球适配建议

日期：2026-09-21。范围：完成时间栏居中；只读核对上游，提出后续交互适配建议。未将建议项标为已实现。

## 核对依据

- GitHub 确認 fork 父仓库为 [qintopia-agent-studio/GreenPMS](https://github.com/qintopia-agent-studio/GreenPMS)。Tennis PMS 来源为 v1.4.3 / `47eb658a20`。
- 查询时上游 main 已为 **v1.7.2 / `c75c5470f0`**，发布于 2026-09-21。本地 Green PMS 工作区 HEAD 为 `0254fbab`；已把下述七个关键文件的 Git blob hash 与远端 v1.7.2 tree 逐一比对，全部一致。没有切换、拉取覆盖或修改上游工作区。
- 已阅读真实源码和合并 PR；PR 所述上游测试属于上游记录，本轮没有运行住房应用或住房测试。

| 上游变化 | 证据 | 适用判断 |
| --- | --- | --- |
| 悬浮摘要、点击抽屉、行列高亮、遮罩防穿透 | [PR #45](https://github.com/qintopia-agent-studio/GreenPMS/pull/45)，`RoomStatusQuickPopover.tsx`、`RoomStatusGrid.tsx`、`InventoryPage.tsx` | 适合排场；不能把悬浮等同于选中或改变预订草稿 |
| 紧凑快捷框，最多四个常用订单动作，复杂表单复用 | [PR #44](https://github.com/qintopia-agent-studio/GreenPMS/pull/44)，`roomStatusQuickOrderActions.ts` | 适合快速办理；改为网球已有订单动作，仍走服务端核对与确认 |
| 助手与订单抽屉共存、独立关闭、保留阅读与输入位置 | [PR #43](https://github.com/qintopia-agent-studio/GreenPMS/pull/43)，`Assistant.tsx`、`uiBasic.tsx` | UI 交互值得适配；住房模型传输、运行时和渠道实现不直接移植 |
| 具体字段错误、加载失败分类、旧核对失效及恢复入口 | [PR #47](https://github.com/qintopia-agent-studio/GreenPMS/pull/47) | 借鉴反馈方法；住房补录、渠道差价和住宿期限规则不属于网球需求 |

七个远端一致性核对文件：`RoomStatusQuickPopover.tsx`、`useRoomStatusHover.ts`、`useRoomStatusOrderPreview.ts`、`InventoryPage.tsx`、`uiBasic.tsx`、`Assistant.tsx`、`roomStatusQuickOrderActions.ts`。原始 tree 留存于 `.local-workspace/greenpms-review-2026-09-21/upstream-tree.json`。

## 当前网球实现与建议顺序

| 优先级 | 当前状态 | 推荐适配 |
| --- | --- | --- |
| 1：Esc 分层收起 | 订单详情使用现有 Modal，已经支持 Esc、焦点返回和编辑退出保护；新建预订使用独立 aside，只有“收起”按钮。网格 Esc 目前取消拖动或删除焦点选区 | 为预订侧栏补 Esc 收起，保留客户、时段、报价与返回位置。拖动中先取消拖动；内层菜单/弹框优先消费 Esc；一次按键只处理一层，不能顺带删除选区。支持中文输入法组合状态 |
| 1：订单悬浮摘要 | 已有预订色块只提供原生 title，点击直接进入订单抽屉，没有结构化快捷摘要 | 桌面停留约 250ms 显示客户、时间、球场、订单/付款状态；约 220ms 延迟收起，允许鼠标跨越色块与弹框间隙。框选、滚动、打开办理面板时暂停悬浮；不抢焦点、不改草稿。手机保留点击入口 |
| 1：快捷办理 | 操作集中于订单抽屉 | 快捷框最多放 3–4 个高频入口，如收款、改期/改场、取消，以及详情入口的取舍；按网球订单状态和权限展示。按钮只打开已有表单，不直接扣款、退款、取消或修改库存；保留未知结果恢复 |
| 2：助手与办理共存 | 网球助手与订单各有独立实现，不等同于上游的新布局；助手当前使用 Modal | 桌面订单与助手并排，窄屏分区；任意打开顺序一致，两侧独立收起。助手入口不触发订单“外部点击”关闭；各自保留输入和阅读位置。只迁移交互，不改变外部智能体边界 |
| 2：行列定位 | 网格已有空位 hover 与拖动预览，尚无整行/对应时间栏联动 | 轻量高亮当前球场行与时间栏，多日视图明确所属日期；选中订单定位其真实明细，不把不同明细之间的空隙涂为占用 |
| 2：失败与禁用原因 | 已有中文错误、冲突标识和失效报价拦截；还未系统核对所有入口 | 禁用原因就近按需展开，区分读取失败与提交失败；指出哪片场、哪段时间或哪个字段需要调整，并提供重试/回到表单的入口 |

建议先做“Esc 分层收起 + 悬浮摘要”，再接快捷办理和助手共存。空位点击、拖选后直接填写预订的现有流程继续保留，不为每次预订多加一道必经弹框。

## 为什么 fork 后没有自动得到这些体验

一部分是 fork 后新增的 #43–#45；另一部分（例如订单抽屉 Esc）在 v1.4.3 已存在。网球页面新增了自己的 `BookingPage` / `ScheduleGrid` / 助手和订单适配层，保留住房源码并不代表这些交互已经接入新页面。应对照行为逐项适配，不能仅根据“沿用 GreenPMS”推断能力已继承，也不适合把上游住房实现整批合并覆盖网球逻辑。

## 本轮已完成与验证

- 时间栏按显示的时间段分组，文字水平、垂直居中；保留自适应宽度、稀疏标签、15 分钟操作精度和三天默认范围。
- `npm run typecheck`、`npm test`（75 文件 / 1396 项）、`npm run build` 通过。
- `browser-calendar-fit.mjs` 通过：检查文本居中、表头与格子对齐、短/常规/全天营业、768–1920px、侧栏展开后框选/调整时长及翻页。截图已目视复核。
- 已更新本机 4273 静态预览；未部署。原有暂存补丁逐字节保持一致。日志、备份和截图位于 `.local-workspace/greenpms-review-2026-09-21/`。
- 上述推荐交互尚未实施，需在后续开发中分别验证，不构成本轮完成声明。
