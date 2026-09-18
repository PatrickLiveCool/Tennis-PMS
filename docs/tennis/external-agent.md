# 外部智能体与人工接管接口

PMS 负责身份、库存、价格、订单和资金事实。智能体与 Runtime 在应用外部；此实现没有内置推理循环，也不会把模型 Base URL 当成聊天接口直接调用。

## 平台配置与后台助手

只有平台运营人员可以读取和修改 `/api/tennis/platform/ai-config`。配置包含 `enabled`、`model`、`baseUrl`、`externalAgentUrl`；可选 `apiKey` 是访问外部智能体服务的密钥。租户没有配置权限。密钥用 AES-256-GCM 加密，响应只返回 `hasApiKey`。本地加密主密钥由启动程序在忽略目录 `.local-workspace/tennis-secrets.json` 随机生成，权限为 0600；不复制住房系统凭据。

只有启用且提供外部智能体 URL 后，助手才会派发请求。未接入时保留助手和人工协作入口，明确显示尚未配置，不产生模拟 AI 回答。`model` 和 `baseUrl` 作为平台配置传递给外部服务；模型访问凭据由外部 Runtime 自行管理。

## 外部请求协议

PMS 向配置的 `externalAgentUrl` POST JSON（`protocol: tennis-agent/v1`）。若配置服务密钥，使用 `Authorization: Bearer ...`。请求携带：

- `requestId`：原用户消息 ID，外部服务也必须用它去重。
- `conversationId`、`generation`：当前会话和接管代次。
- `model`、`baseUrl`：平台配置。
- `workspace`：已验证的租户、场馆及客户/员工身份类型。
- `context`：经过归属校验的页面名、可选订单 ID。
- `messages`：签发本次凭据时的会话快照，不包含此后人工接管产生的内容。
- `delegation.token`、`expiresAt`：本次有限授权，最长 15 分钟，响应结束后立即撤销。

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

工具面没有退款、人工记账、资产配置、接管或模拟到账命令。退改费用须授权员工办理。外部 Runtime 必须在执行确认预订、使用余额等动作前完成用户确认，并为同一业务意图保持同一 `commandKey`；失败重试先查询原命令结果。

## 助手体验与反馈

后台助手保留页面/订单上下文、可编辑常用提问和回答反馈。`GET /assistant/conversations/:id` 的每条消息包含当前主体的 `feedback: boolean | null`；`POST /assistant/conversations/:id/messages/:messageId/feedback` 接收 `{resolved:boolean}`。仅允许对有权访问会话中的 assistant 消息反馈，同主体重复提交幂等，不同主体互不覆盖；原始聊天仍保留。

## 接管与重复派发

客户可以申请转人工，授权员工可以接管和恢复智能体。接管提交后会话代次增加，旧授权全部撤销。业务命令在与接管相同的租户事务锁内再次验证授权，所以事先解析出的旧身份也不能绕过接管。已先行提交的交易仍需人工按订单事实处理，接管不会倒退已完成的资金操作。

同一消息的派发由数据库唯一记录声明所有权，避免并发执行两次外部 Runtime。外部结果不明时标记 `UNCERTAIN`，不自动重新派发；员工接管核对订单和回执后再恢复。页面显示回复延迟不等于业务失败，不能据此另建交易。

## 尚待真实接入

具体微信入口产品、账号、商户号、外部 Runtime 服务和真实部署地址均未提供。当前已有本地可信登录和上述适配契约；不代表企业微信/微信客服或真实微信支付已联调完成。外部渠道身份映射需在选择渠道后实现，不能直接把微信昵称或消息中的客户 ID 当作可信身份。
