# 外部智能体与人工接管接口

> 2026-09-20：以[当前 AI Native PMS 决定](ai-native-pms.md)为准。后台助手由平台 UI 直接配置模型；外部业务 Runtime 独立使用 PMS API。当前继续本地 demo 开发与人工验收准备，未接入的外部条件只限制其对应真实验证，不阻塞 PMS 开发。历史验证记录保留。

PMS 负责身份、库存、价格、订单和资金事实。客户/员工业务智能体的 Runtime 位于应用外部，经 [Gateway 接口](gateway.md) 取得受控授权并调用下列业务工具。PMS 后台另有员工自用的直连模型助手，两种会话和凭据分开。

## 平台配置与后台助手

`/api/tennis/platform/ai-config` 现专用于后台助手的 `enabled`、`model`、`baseUrl`、可选 `apiKey` 和 `expectedRevision`；新密钥保存到独立表，旧外部 Runtime 的服务密钥不迁移、不解释为模型密钥。只有平台运营人员可读写、测试配置；租户只使用助手。具体接口与只读工具见 [后台助手](backoffice-assistant.md)。

外部 Runtime 的模型配置仍在它自身管理。PMS 的接入设置负责 Gateway 凭据、身份/租户绑定和业务权限，不要求填外部 Runtime 的模型名称或 Base URL。后台助手可独立工作；它未配置时显示实情，不产生伪造 AI 回答。

## 兼容旧派发模式

原 `platform_ai_config` 和 `sendAssistantMessage` 派发适配保留，供已有外部业务会话兼容；它们不再对应平台 UI 的后台助手配置页。历史服务密钥保留原用途，不发送给模型。新外部 Runtime 对接优先使用 Gateway 身份、授权和受控工具契约；不依赖 PMS 内部保存它的模型参数。

以下旧派发协议描述仅说明兼容代码，不代表新的后台模型调用协议。

## 外部请求协议

PMS 向配置的 `externalAgentUrl` POST JSON（`protocol: tennis-agent/v1`）。若配置服务密钥，使用 `Authorization: Bearer ...`。请求携带：

- `requestId`：原用户消息 ID，外部服务也必须用它去重。
- `conversationId`、`generation`：当前会话和接管代次。
- `model`、`baseUrl`：平台配置。
- `workspace`：已验证的租户、场馆及客户/员工身份类型。
- `context`：经过归属校验的页面名、可选订单 ID。
- `messages`：签发本次凭据时的会话快照，不包含此后人工接管产生的内容。
- `delegation.token`、`expiresAt`：本次有限授权，最长 15 分钟，响应结束后立即撤销。
- 消息快照以本次 `requestId/messageId` 为边界，最多包含它及之前 199 条消息；已入站的后续指令不会混入旧请求。

外部响应为 `{ "content": "回复正文" }`。超时为 30 秒；不跟随重定向。PMS 不信任回复正文中的“已付款/已预订”等自然语言事实，业务结果应由下列工具响应及订单查询确定。

## 受控业务工具

外部服务使用单次 Bearer token 访问 `/api/tennis/agent/`；租户、主体和客户绑定均从数据库凭据解析，不接受请求自报身份。API 基址由外部服务部署配置指定，当前本地为 `http://127.0.0.1:4200`。

| 接口 | 用途 |
| --- | --- |
| `GET /context`、`/courts`、`/schedule?date=YYYY-MM-DD` | 可信工作区、球场和排场 |
| `GET /booking-customers?q=姓名或电话` | 订场选客所需最小资料，员工须有订场权限；客户仅返回本人，不返回手机号及钱包 |
| `POST /quotes` | `{customerId,lines:[{courtId,startAt,endAt}]}`，场馆取凭据作用域 |
| `POST /quotes/:id/confirm` | `{commandKey}`，整组原子占场 |
| `GET /orders`、`/orders/:id` | 查询当前作用域订单 |
| `POST /orders/:id/payments` | `{walletCents,commandKey,staffReason?}`，创建付款尝试 |
| `GET /payments/:id` | 查询付款事实 |
| `POST /orders/:id/cancel` | 未付款取消，带 `commandKey/expectedRevision/reason` |
| `GET /customers/:id/wallet` | 余额和完整明细；客户仅能查自己。`pageSize` 默认 50、范围 1–200，`cursor` 用上一页 `nextCursor`，末页为 null |
| `GET /topup-offers` | 充值档位 |
| `POST /customers/:id/topup-quotes` | `{principalCents? 或 offerId?}`，赠送不可自报 |
| `POST /topup-quotes/:id/confirm`、`GET /topups/:id` | 确认充值、查询到账 |
| `GET /receipts/:commandKey` | 网络结果不明时查原命令回执 |

另有工作人员专用的 `GET /wecom/receipts`、`GET /wecom/payment-targets` 和 `POST /wecom/receipts/:id/link`，用于员工在对话中指定真实收款归属。需要独立“收款核对”权限及目标业务权限，客户不可用；资金、流水关联与请求回执同事务提交。输入、候选歧义、权限和恢复规则见 [工作人员智能体收款核对](staff-agent-reconciliation.md)。

工具面没有退款、自报到账、资产配置、接管或模拟到账命令。退改费用须授权员工办理。外部 Runtime 必须在执行确认预订、使用余额等动作前完成用户确认，并为同一业务意图保持同一 `commandKey`；失败重试先查询原命令结果。

## 业务会话体验与反馈

业务会话保留页面/订单上下文、可编辑常用提问和回答反馈；员工自用后台助手使用独立 `/backoffice-assistant/` 接口。`GET /assistant/conversations/:id` 的每条消息包含当前主体的 `feedback: boolean | null`；`POST /assistant/conversations/:id/messages/:messageId/feedback` 接收 `{resolved:boolean}`。仅允许对有权访问会话中的 assistant 消息反馈，同主体重复提交幂等，不同主体互不覆盖；原始聊天仍保留。

## 接管与重复派发

客户可以申请转人工，授权员工可以接管和恢复智能体。接管提交后会话代次增加，旧授权全部撤销。业务命令在与接管相同的租户事务锁内再次验证授权，所以事先解析出的旧身份也不能绕过接管。已先行提交的交易仍需人工按订单事实处理，接管不会倒退已完成的资金操作。

同一消息的派发由数据库唯一记录声明所有权，避免并发执行两次外部 Runtime。外部结果不明时标记 `UNCERTAIN`，不自动重新派发；员工接管核对订单和回执后再恢复。页面显示回复延迟不等于业务失败，不能据此另建交易。

## 请求结果核对

015 追加迁移持久保存请求，并在业务命令与幂等回执的同一事务内关联 `conversationId/requestId → subjectId/commandKey`。新授权复用原命令键时也会关联原回执；失败或事务回滚不留下已完成命令假象。`GET /agent/context` 包含可信 `requestId`。

- `GET /assistant/conversations/:id/requests?cursor=...`：每页 20 个请求，返回 `items/nextCursor`；使用数据库原时间精度排序，游标须属于原租户和会话。
- `GET /assistant/conversations/:id/requests/:requestId`：返回该请求所有已提交命令的类型、原键、完成时间、白名单业务 ID 及当前状态，不返回原参数或任意回执 JSON。
- 授权员工可以在助手“办理记录”核对客户请求，不需要冒用客户或恢复旧 token。没有会员管理权限时，充值/钱包命令结果隐藏，并计入 `restrictedCommandCount`。客户仅能查看本人会话及业务。
- `IN_FLIGHT` 仅表示未收到结束回报，不证明 Runtime 仍在运行或授权仍有效；`SUCCEEDED` 是对话处理状态，不替代订单/资金状态。未知结果不自动重新派发。
- Gateway 使用独立长期凭据的对应只读接口核对，见 [Gateway 契约](gateway.md)。它在人工接管后仍可核对当前身份有权读取的原结果，而旧写授权保持撤销。

## 尚待真实接入

具体微信入口产品、账号、商户号、外部 Runtime 服务和真实部署地址均未提供。当前已有本地可信登录和上述适配契约；不代表企业微信/微信客服或真实微信支付已联调完成。已提供人工绑定及渠道无关 Gateway 入口，但真实微信身份验证和收发适配仍需在确定渠道后接入，不能直接把微信昵称或消息中的客户 ID 当作可信身份。

## F11 人工会话工作流

消息和直接人工接管持久保存已验证 page/orderId；客户会话里员工也只能关联该客户订单。相同 messageId 重试必须保留原文和 context。会话详情增加 latestOrderContext，Agent /context 使用当前请求原消息的 context；历史消息无关联时为空，不猜测。新 /assistant/conversation-directory 提供按场馆、mode/q/pageSize/cursor 分页目录；旧 /assistant/conversations 数组接口兼容保留。参见 [人工协作完成规格](operator-completion.md)。
