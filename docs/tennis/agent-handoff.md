# Tennis PMS 外部智能体交接入口

本文供连接 Tennis PMS 的外部智能体 Runtime 和渠道 Gateway 阅读。当前云端 Demo 的 PMS API 基址是 `https://tennis.qintopia.cn/api/tennis`；这不是模型服务的 Base URL。云端 Demo 使用模拟支付，真实微信渠道与商户支付尚未完成联调。

## 按顺序阅读

1. [Gateway 接入契约](gateway.md)：集成凭据、可信渠道身份、消息入站、短期授权、完成回报、人工接管与结果恢复。
2. [外部智能体业务接口](external-agent.md)：`/agent/` 工具、请求参数和执行边界。其中“兼容旧派发模式”只描述旧协议，新接入使用 Gateway 流程。
3. [接入与身份管理](gateway-admin.md)：管理员如何签发一次性 API Key、核验并绑定渠道账号。

按需阅读：[接入凭据生命周期](agent-access-management.md)、[业务事件](business-events.md)、[同租户场馆发现](agent-discovery.md)、[工作人员收款核对](staff-agent-reconciliation.md)。

## 接入要点

- 将“智能体接入”签发的 API Key 仅保存在外部服务端。Gateway 请求使用 `Authorization: Bearer <integration token>` 和已人工绑定的 `X-Gateway-Subject`。此 Key 标识一个租户的接入，不单独代表某个用户或授予业务权限，也不是模型 API Key。
- 通过 `POST /gateway/messages` 接收消息，再以 `POST /gateway/conversations/:id/messages/:messageId/grant` 获取本次短期 token。业务工具位于 `/agent/`，必须使用短期 token，不能使用长期集成 Key。
- 订场、余额支付等交易执行前取得用户确认；对同一业务意图保持同一 `commandKey`。请求结果不明时先查原回执、订单和付款事实，不另建交易。
- 模型回复不能证明库存、付款或退款已完成。具体可用操作以接口、身份及实时权限为准。退款金额由授权工作人员确定；外部智能体没有自主退款工具。

## Key、身份和权限

| 当前绑定身份 | 可使用的业务能力 | 限制 |
| --- | --- | --- |
| 客户 | 查询可售场地、本人订单与钱包；为本人报价、订场、付款和充值 | 只能操作本人，不能查看其他客户、执行员工收款核对或退款 |
| 员工 | 在获授权的场馆内读取业务；具有 `book` 权限时可办理订场和订单付款；具有 `manage_members` 权限时可办理会员钱包和充值；收款核对还需要 `reconcile_payments` 及目标业务权限 | 员工 Gateway 会话本身需要 `book` 权限；角色为只读或缺少场馆权限时不能借 Key 扩权 |
| 管理员身份绑定 | 在 `/agent/` 工具范围内按实际业务权限办理 | Gateway Key 不能调用需要后台登录会话的接入管理、员工管理或退款设置接口 |

管理员在“系统管理 → 渠道账号绑定”选择真实客户或员工，在“员工账号”核对员工角色、业务权限和可管理场馆。授权可能随时变化，每次请求都由 PMS 重新校验；收到权限错误时停止该操作并核对当前绑定与授权。取得短期 token 后，先调用 `GET /agent/context` 确认 `actorKind`、`tenantId`、`venueId`、`customerId` 和会话状态；该接口当前不返回完整员工权限清单，不能据此推断更多权限。

交接时，管理员应一并提供：PMS API 基址、接入名称与有效期、已核验的外部账号标识、绑定的客户或员工身份；员工身份还需注明角色、已授予的业务权限和场馆范围。API Key 通过受控服务端配置单独交付，不放入对话或文档。仅凭 Key 无法推断这些身份与权限。

这些文档随应用版本发布，可从 `GET /api/tennis/integration-docs/agent-handoff.md` 及本页相对链接读取。上线版本是否包含该入口，应以实际请求结果为准。
