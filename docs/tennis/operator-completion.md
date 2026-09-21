# F11 人工协作完成规格

状态：2026-09-19 本地实现、自动验证及限定浏览器核对已完成；真实渠道与客户人工验收仍未完成。本文件只定义现有 MVP 的运营闭环，不扩展微信协议、外部 Runtime、账号自注册或完整客服工单系统。

## 目标与源码证据

| 目标 | 当前行为与证据 | 最小完成行为 |
| --- | --- | --- |
| 日常新客户能够绑定可信 Gateway | `customers.ts:createCustomer` 只建客户档案；`gateway.ts:gatewayBindingTargets` 排除 `subject_id IS NULL`；`createGatewayBinding` 只接受已有 subject；现有 Gateway 测试手写 SQL 给客户补 subject | ADMIN 明确选择已有客户档案，首次绑定时原子创建内部主体并绑定，无需本地密码账号 |
| 人工接管后知道“这笔订单”是哪笔 | `external-agent.ts:sendAssistantMessage` 验证 `input.context.orderId`，但插入消息只保存正文；HUMAN 提前返回；`AssistantPanel.tsx:handoff` 不带 context | 消息与接管记录保存已验证 context；员工刷新、换设备仍能看到关联订单并打开受权详情 |
| 超过 100 条会话仍能找到人工待办 | `listConversations` 固定最近 100 条；UI 只显示“客户 / 同事会话”与时间 | 服务端分页、HUMAN 筛选和姓名/编号检索；列表显示具体客户或员工姓名 |

这些补齐不改变既有多租户、场馆授权、客户本人限制、HUMAN 撤销委托和资金命令的权限。沿用 GreenPMS 的面板、搜索、状态标签、刷新、错误恢复与“加载更多”样式。

## A. 新客户 Gateway 绑定

### 身份模型与范围

- `customers` 是业务档案，`subjects` 是认证后使用的内部主体，`local_accounts` 才是用户名/密码登录账户。首次渠道绑定只补 `subjects` 与 `customers.subject_id`，不插入 `local_accounts`、`auth_sessions`、员工授权或平台角色。
- 客户先通过已存在的会员建档入口建档。绑定页只从后端返回的本租户有效客户/员工候选选择；服务端按明确 ID 校验，不按显示名、手机号、聊天正文或外部主体编号自动合并。
- 外部 `/gateway/` 仍拒绝未绑定身份。首次联系时自动建档、验证码认领、开放注册均不属于这次修改。
- 保持租户 ADMIN 办理人工核验的既有权限；普通拥有 `manage_members` 的员工可建档，并不因此获得绑定身份的权限。平台运营身份也不自动得到租户绑定权限。

### 最小服务/API 契约

`GET /gateway-binding-targets?q=...` 继续按当前租户搜索，扩展候选为判别联合：

```ts
type BindingTarget =
  | { actorKind: "staff"; subjectId: string; customerId: null; name: string }
  | { actorKind: "customer"; subjectId: string | null; customerId: string; name: string };
```

客户候选包含尚无 subject 的有效档案。已有 subject 若关联停用的本地账号，继续排除，不能借 Gateway 绕过停用。候选 UI key 使用 `staff:${subjectId}` / `customer:${customerId}`，不能让多个空 subject 客户共用 key。

`POST /gateway-bindings` 保留已有字段并增加客户按档案绑定分支：

```ts
type BindingInput = {
  integrationId: string;
  externalSubjectId: string;
  reason: string;
} & (
  | { actorKind: "staff"; subjectId: string }
  | { actorKind: "customer"; customerId: string }
  | { actorKind: "customer"; subjectId: string } // 兼容现有可信调用
);
```

`customerId` 与 `subjectId` 只允许出现一个；新后台客户绑定使用 `customerId`。旧客户 subject 分支仍反查当前租户有效客户。请求不能指定 tenant、角色、余额或新 subject 的 ID。

在已有租户事务锁内，顺序如下：

1. 复核当前租户有效、操作者为 ADMIN、integration 属于当前租户且有效；验证外部主体与核验依据。
2. 按 `tenant_id + customerId` 锁定有效客户。员工分支继续按真实 membership 校验。
3. 客户已有 subject 就复用，并复查本地账号停用状态；没有则生成随机 subject ID，display name 来源为客户昵称，只插入 `subjects` 并更新该客户 `subject_id`。
4. 建立原有 `gateway_bindings`，写审计，和新 subject/客户关联一起提交；任何冲突或错误全部回滚，不留孤立主体。
5. 返回原有绑定记录格式，仍含实际 `subjectId`、`customerId`、`actorKind`。

并发相同外部主体仍由租户锁和现有有效唯一索引保护；重复提交返回既有 `GATEWAY_MESSAGE_CONFLICT`，由现有“刷新原列表核对”处理未知结果，不隐式重新激活已撤销绑定。同一新客户同时绑定两个明确授权的不同渠道标识时，只生成一个 subject。

既有解绑、接入停用、客户停用、租户停用及旧绑定会话隔离继续生效。撤销后重新人工绑定不能继承旧绑定会话或旧委托。新客户无需修改认证会话代码；`resolveGatewayIdentity` 与 `requireCustomer` 已支持没有 `local_accounts` 的可信主体。

### 后台修改

`GatewayPanel.tsx` 扩展候选类型与提交分支。文案以“已有客户档案 / 员工身份”为准，不要求客户先创建登录账号。空 subject 是正常候选，不作为警告。用户仍在会员页面建档，避免增加第二套建档表单与未知提交恢复逻辑。

同步修订 `gateway-admin.md` 中“仅列已有主体”和“不允许手填 customerId”表述：界面继续不开放任意 ID 文本框，但后端请求按用户选择的客户 ID 办理，并严格校验。

## B. 持久订单上下文与人工接管

### 存储与显示

建议在下一条新增迁移中给 `agent_messages` 加：

- `context_page text NULL`，长度不超过 100。
- `context_order_id text NULL`，外键 `(tenant_id, context_order_id)` 指向 `orders(tenant_id,id)`。
- 兼容旧记录，所有历史消息默认为无 context；不从历史自然语言猜测订单。
- 按 `(tenant_id,conversation_id,created_at DESC,id DESC)` 为 `context_order_id IS NOT NULL` 建部分索引，支持不受最近 200 条消息限制的“最近关联订单”。

不复制金额、客户手机号、订单状态、凭据或整份订单 JSON。订单真实状态始终由现有订单读取接口提供。消息返回增加可选/可空 `context:{page:string;orderId?:string}`；会话详情另返回 `latestOrderContext`，包含最新一条有订单关联的消息 ID、时间、page 和 orderId。该字段明确叫“最近关联订单”，不能代表每条新消息都在讨论此订单。

纯文本留言不清空既有关联。较新消息附其他有效订单后，详情头部切换到新订单，但旧消息的关联仍可查看。此方案无需在 `agent_conversations` 额外存一份容易不同步的当前订单。

### 写入与归属校验

复用一个事务内 context 校验/规范化 helper，供后台消息、Gateway 入站和 handoff 调用：

- context 只接受 `page` 与可选 `orderId`；无额外授权字段，不能把 context 当作可信身份。
- 订单必须属于当前租户、当前会话场馆。
- 客户 actor 只能关联本人订单。
- **客户会话即使由员工回复，也只能关联 `conversation.customerId` 的订单**，避免员工把同场馆另一客户订单放进客户可读历史。
- 员工自己的会话允许引用该员工在当前场馆有权读取的订单。权限或客户归属不符统一拒绝，不写消息、不改代次、不发 Runtime 请求。
- HUMAN 消息同样校验与持久化，不调用 Runtime。

`sendAssistantMessage` 的同 messageId 检查必须比较规范化的正文与 context。相同消息 ID 换 orderId/page 不能复用旧消息或派发新意图；无 context 的旧消息只可按无 context 重放。

`handoffConversation` 增加可选 context，后台与 Gateway handoff schema 同步。带 context 时存入同一次事务创建的 system 接管消息；上下文验证先于 mode/generation 更改。这样“从订单直接转人工、尚未发送文本”也留下关联。无 context 时不修改原有关联；AGENT/HUMAN 权限与旧委托立即撤销规则保持原样。

### Gateway 与 Runtime 契约

- `/gateway/messages` 增加可选 context，存入对应 `agent_messages`。
- 重复 externalMessageId 在原有 binding/conversation/content 比较外，还比较持久 context。可保留原 `content_hash` 算法，与关联消息 context 分开比较，避免让现有无 context 的重放失效。
- delegation 消息快照包含每条消息的 context；顶层请求 context 必须来自被授权的原 message，不取当前会话最近关联订单。
- `sendAssistantMessage` 派发使用已存消息 context；Gateway grant 的已存 `grant_snapshot` 一经签发仍原样重放，后续用户改谈其他订单不会改写旧 grant。
- `/agent/context` 如增加订单 context，应按当前 request 的 anchor message 读取，不能将会话最新值当成本次输入。
- 继续采用 `tennis-agent/v1` 的兼容新增字段；旧记录返回空 context，不重新签发委托、延长期限或执行未知命令。

### 后台入口与不串单

- `AssistantPanel` 的消息与“最近关联订单”展示轻量订单链接，沿用现有订单详情组件或回调；服务端照常再核验读取权限，不能仅凭链接直接渲染缓存详情。
- 订单详情打开助手时的 page/orderId 已有，可直接传给 send/handoff；从通用页面打开助手并选客户会话时，不自动将工作人员当前查看的其他订单附到该会话。
- 未确认消息请求保留 `{messageId,content,conversationId,context}` 完整快照。等待结果时切页/切单不能让同 messageId 携带另一个 context 重试。
- 租户、session contextVersion、场馆、会话或查询条件变化后清理对应请求状态；迟到响应不得替换新 scope 的会话、关联订单或列表。
- 查看关联订单不关闭/清空原会话或工作人员尚未提交的订单表单。

## C. 人工会话目录、分页与搜索

### 服务/API

新增分页服务 `listConversationPage`，旧 `listConversations` 若仍有外部/测试消费者可作为兼容包装；新增明确分页路径 `/assistant/conversation-directory`，避免把既有数组接口静默改成对象。

```ts
interface ConversationQuery {
  venueId: string;
  mode?: "AGENT" | "HUMAN"; // 省略为全部
  q?: string;                // trim，最多 200 字
  cursor?: string;
  pageSize?: number;         // 默认 20，范围 1..100
}
interface ConversationSummary extends Conversation {
  displayName: string;       // customer.nickname 或 subjects.display_name
  actorKind: "customer" | "staff";
  latestOrderId: string | null;
}
interface ConversationPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}
```

筛选在 SQL 分页之前执行；搜索范围限客户/员工姓名、会话编号、已验证关联订单编号。采用参数化 `strpos(lower(...),lower(q))`，不开放任意 SQL 或全文扫描正文；搜索“关联订单”按历史有效 context 存在性匹配，不只查最近 200 条消息。不开客户手机号展示/搜索，避免把需要 `manage_members` 的额外资料带进现有订场员工目录。

权限沿用 `conversation()`：员工须该场馆 `book`，客户只看本人 subject+customer 的会话；模式与查询词不能扩大范围。平台角色无隐式跨租户通道。每页重新授权，撤销后旧 cursor 不再有权限。

排序统一 `updated_at DESC,id DESC`；取 pageSize+1 判断 nextCursor。cursor 保存末条返回记录的**原始时间值与 ID**，不可只在下一次查询时按 ID 重读可变的 updated_at。cursor 中带查询范围标识（租户、身份类型/subject/customer、场馆、mode、规范化 q）；与本次参数不符或编码非法返回明确的 400。scope 只用于拒绝错页，真正授权仍来自服务端 actor。

PostgreSQL 时间游标保留微秒精度（使用 SQL 文本精确值），不能经 JS Date 毫秒截断后作为分页边界。同时间通过 ID 排序。添加 `(tenant_id,venue_id,mode,updated_at DESC,id DESC)` 索引；现有未带 mode 索引可继续服务全部列表。

这是实时会话列表，不承诺跨多个 HTTP 请求冻结全库快照：翻页期间新留言导致旧会话上移时，用户刷新首页能重新看到它。前端按 conversation ID 去重；后续页使用已保存边界，不能因边界会话又收到消息而跳过静态旧会话。验收须证明静态超过 100 条全部可达、同时间无漏页、边界更新不改变游标含义。

### UI

保留 AI 助手入口和原会话选择习惯，增加搜索框、“全部 / 人工处理中 / AI 协作”筛选及“加载更多”。列表选项显示具体姓名、身份、处理状态、最近时间和短编号；长名称可截断，完整名称可读。默认全部，工作人员可切 HUMAN，不强制丢失自己的 AI 会话。

换筛选/搜索/场馆后清空分页游标，防止把旧页接到新列表；已打开的详情不应仅因刷新后暂不在首页就丢失，必要时保留当前选中项。列表空、搜索无结果、网络失败分别沿用现有空态与重试，不伪称“没有待办”。不增加未读计数、分派队列、SLA 或自动归档。

## 必要验证

以下应优先扩展现有 `gateway.integration.test.ts` 与 `assistant.integration.test.ts`，由 root 统一安排 PostgreSQL 验证；新增 HTTP/浏览器检查只覆盖新风险。

| 验收场景 | 必须观察到的行为 |
| --- | --- |
| 新建普通客户后按 customerId 绑定 | 成功建立一个 subject + 一个 binding；没有 local_account/session/staff/platform 记录；Gateway 能解析客户本人身份 |
| 两次并发首次绑定 / 同外部ID冲突 | 最多一个客户 subject，无孤立主体；有效外部绑定唯一，冲突全部回滚 |
| 同名或同手机线索、跨租户 customerId、客户停用 | 不自动合并；越租户/停用拒绝；按明确档案 ID 办理 |
| 普通员工、客户、仅平台身份尝试绑定 | 维持 ADMIN 边界；已停用本地账号不得借复用 subject 恢复 |
| 撤销后旧身份 / 旧委托 / 旧绑定会话 | 即使先前已解析 principal，业务事务仍拒绝；重新绑定不继承旧会话 |
| 从订单直接 handoff，未发文本 | 员工另一会话/新请求读取仍见正确关联订单；接管系统消息与 generation 同事务 |
| HUMAN 文本附订单 | 不发 Runtime；内容与已验证 context 均保留，超过 200 条后详情头部仍可定位最近关联订单 |
| 同 messageId 或 externalMessageId，正文同但 context 不同 | 明确拒绝，无第二条消息/业务授权；原记录不变 |
| 同租户另一客户 / 另一场馆 / 另一租户订单 | 客户本人和员工回复客户会话两种路径均拒绝；无上下文泄漏 |
| 旧消息等待 grant 时后面有其他订单消息 | 授权与 Runtime 快照只含原消息当时的context；重放grant保持同token/期限/快照 |
| 121 条会话含旧 HUMAN、同时间记录 | HUMAN 筛选先于分页，姓名/编号能找回旧会话；全部静态记录无重复/漏页 |
| cursor被用于另一租户/客户/场馆/筛选，或权限已撤销 | 查询拒绝或返回限定范围内的正确空结果，不绕过授权，不返回他人资料 |
| 分页边界会话更新、查询切换后旧响应迟到 | 固定游标边界不漂移；UI按ID去重，旧scope响应不覆盖新列表 |
| 浏览器原流程 | 新客户候选可选、提交使用customerId；接管/消息可开正确订单；换设备读到同context；既有草稿和AI入口保留 |

源码审阅、迁移/typecheck 与自动化通过分别记录；真实微信首绑、真实渠道身份验证和消息投递、外部 Runtime 联调仍属于外部验收，不以本地合成身份代替。

## 同期完成：待完成线上充值目录

F11 开始前已核实：`MembersPage.tsx` 的充值对话框仅用 `useDraft` 保存当前客户单个 `quote/payment`；`topups.ts` 只有按 ID 读取，没有持久分页列表；`views.ts` 的资金台账仅收录 `topup_payments.status='SUCCEEDED'` 的主充值。

换设备或草稿丢失后，工作人员不能从会员页面找到旧 PENDING/FAILED 线上充值核对渠道状态。当前已实现按客户+场馆与既有成员权限查询充值历史，复用 PaymentChannelPanel；客户只查本人，UNKNOWN 继续查原单。参见 [持久充值目录](topup-directory.md)。
