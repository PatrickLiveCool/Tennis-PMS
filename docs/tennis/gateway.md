# 可信 Gateway 接入契约

PMS 不实现微信协议或 Agent Runtime。本文是外部渠道适配器接入 PMS 的渠道无关契约；当前使用合成身份在本地验证，尚无真实微信账号、签名验证或渠道消息发送。

## 身份与人工绑定

平台运营人员在 `/platform/gateways` 为一个租户创建集成凭据。随机 token 仅创建响应展示一次，数据库只保存 SHA-256；丢失时先核对已有集成并撤销，再创建新凭据。列表、审计和浏览器持久缓存不包含 token。集成停用后不能恢复，避免旧凭据重新生效。

租户管理员在“系统管理 → 渠道账号绑定”选择一个已有 PMS 客户或员工主体，填写经过渠道核验的 `externalSubjectId` 和核验依据，建立绑定。此编号用于识别渠道用户，与接入凭据分开管理。此处不按手机号/昵称自动注册、合并客户或授予余额权限。同一集成一个外部主体只允许一个有效绑定；变更身份必须撤销后重新人工绑定。旧消息和会话仍属于旧绑定，不能被新身份继承。

员工继续受原租户、场馆与业务权限约束；客户只能操作本人档案和资金。绑定被撤销、集成停用、账号停用或租户停用后，即使请求先前已解析出身份，也会在实际业务事务内重新检查。撤销与业务命令使用同一租户事务锁；已在撤销之前提交的订单仍按真实业务结果处理。

## 鉴权与路径

所有路径基于 `/api/tennis`。管理接口用原后台 session、CSRF 和工作空间版本。外部 `/gateway/` 接口只接受：

- `Authorization: Bearer <integration token>`
- `X-Gateway-Subject: <人工绑定的外部主体标识>`

Gateway 必须先验证真实渠道来源和用户身份，再填该标识。PMS 不把聊天正文、请求自报 tenant/customer/role 当成可信身份。这一集成凭据可代表该集成下已绑定主体，须留在服务端，不能放在客户端、小程序或模型提示中。

| 管理接口 | 输入/用途 |
| --- | --- |
| `GET /platform/gateways?tenantId=...` | 平台查询一个租户的集成，无凭据 |
| `POST /platform/gateways` | `{tenantId,name}`，创建并一次返回 token |
| `POST /platform/gateways/:id/revoke` | `{reason}`，撤销 |
| `GET /gateway-bindings` | 当前租户管理员查询集成及绑定 |
| `GET /gateway-binding-targets?q=...` | 当前租户已有可绑定客户/员工主体，最多 100 条 |
| `POST /gateway-bindings` | `{integrationId,externalSubjectId,subjectId,actorKind,reason}` |
| `POST /gateway-bindings/:id/revoke` | `{reason}`，撤销绑定 |

## 入站、授权与响应丢失

1. `POST /gateway/messages`，输入 `{externalConversationId,externalMessageId,venueId,content}`。PMS 保存消息并返回 `{conversation,messageId,duplicate}`，不启动 Runtime、不执行业务。
2. 同集成下 `externalMessageId` 唯一。重复输入必须是同绑定、同会话及相同正文；不同内容拒绝。同一外部会话绑定一个场馆，改场馆需新外部会话并重新报价，不能扩大旧会话授权。
3. 外部组件准备处理时调用 `POST /gateway/conversations/:id/messages/:messageId/grant`，输入 `{expectedGeneration}`。响应包含 `requestId`、有限 `token`、`expiresAt`、会话和消息快照。业务工具仍使用 `/agent/`，不要把长期 integration token 用作业务委托。
4. 相同 grant 请求若响应丢失，重试只返回加密保存的同一 token、同一期限、同一消息快照；不新建请求、不延长 15 分钟期限。PMS 只保存 AES-256-GCM 密文并绑定 messageId 作为附加认证数据，复用平台本地加密主密钥。
5. Runtime 对同一业务意图使用稳定 `commandKey`，先查询原回执，再决定下一步。获得同一 token 不代表可以重新生成一个业务意图。确认订场、扣余额仍由 Runtime 在执行前取得用户确认。
6. 处理结束调用 `POST /gateway/conversations/:id/messages/:messageId/complete`：`{status:"SUCCEEDED",content:"回复正文"}` 或 `{status:"UNCERTAIN"}`。它记录对话处理结果、撤销本次 token、删除保存的密文；自然语言回复与此状态均不代表订单/资金成功，必须查业务事实。重复完成须相同内容。
7. `UNCERTAIN` 阻止同代次继续签发，授权已过期也不会重新签发。新消息可入站留存，需员工接管并核对原命令之后再恢复。旧代次消息始终不能获得新写授权。

消息只在当前租户数据库中保存。真实渠道回复和重试由外部组件负责，本接口不发微信通知。

## 接管、只读恢复与事件

`POST /gateway/conversations/:id/handoff` 接收 `{reason}`，只能请求 `HUMAN`。恢复 AGENT 必须由授权员工在后台执行。接管立即改变代次并撤销旧业务 token；之后旧 Runtime 的成功回复不能追加进新会话状态。它可以标记原请求 `UNCERTAIN` 供人工核对。

以下只读接口使用长期 Gateway 凭据和当前有效身份绑定，不依赖旧业务 token，因此能在授权结束或人工接管后读取原结果：

- `GET /gateway/conversations/:id`：当前会话与最近 200 条消息，只允许该外部身份绑定的会话。
- `GET /gateway/conversations/:id/requests?cursor=...`：请求分页索引。
- `GET /gateway/conversations/:id/requests/:requestId`：原请求所有已提交命令的最小结果，复用员工/客户权限过滤，不返回原敏感参数。
- `GET /gateway/events?venueId=...&cursor=...&pageSize=...`：当前身份有权看到的业务事实，详见 [事件契约](business-events.md)。每个身份、场馆独立保存游标，按 eventId 去重；授权变化导致旧游标无权时重新核对可见状态。

人工核对结果只提供读视图，不恢复旧 token，也不自动重发未知交易。平台助手配置控制后台主动派发；Gateway 是否可用由独立集成和身份绑定控制，PMS 不替外部 Runtime 管理启动、模型调用或循环。

## 验证边界

本地 PostgreSQL 验证覆盖并发重复入站/授权、同 ID 不同内容、越租户/场馆/身份、存储密文、解绑及停用后已解析身份失效、接管后旧回复拒绝、过期不延长、未知结果阻止继续处理，以及独立 HTTP 鉴权。真实渠道首绑、签名验证、实际消息收发、指定 Runtime、托管环境和业务人工验收仍待外部条件具备后完成。

## F11 兼容新增

客户人工绑定支持按明确 customerId 为已有档案补内部主体，无密码账号；管理员权限和核验依据保持。入站消息与 handoff 可带 context（page、orderId），订单须属于该会话租户、场馆及客户。重复 externalMessageId 的正文和规范化 context 都须一致。grant 顶层及消息中的 context 固定原消息，既有已签发 snapshot 原样恢复，不使用会话后来的订单关联替换。
