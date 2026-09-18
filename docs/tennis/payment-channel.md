# 支付渠道与商户绑定（F9）

本地实现支持模拟付款、查单、回调和退款恢复。唯一已实现的适配器为显式本地 MOCK；没有真实微信 SDK、商户凭据、支付链接或二维码。WECHAT 商户配置只保存未来接入的身份和凭据引用，不能据此宣称已经接通。 F13 已新增产品共用的 API v3 签名/验签/通知解密安全层，F14 补齐共用 HTTP 请求层并用回环服务验证，尚未注册真实 provider 或访问微信网络，边界见 [微信安全与请求层](wechatpay-v3-security.md)。

## 交易事实与渠道分工

`PaymentProviderPort` 提供 createPayment、queryPayment、createRefund、queryRefund、verifyNotification。业务付款意图、钱包预留和渠道任务在同一 PostgreSQL 事务保存；后台任务在事务外调用渠道。渠道结果经认证、金额/商户/币种/业务编号核验，保存可信观察后交给既有资金服务入账，不复制钱包分配与退款规则。

- 纯余额交易不创建渠道操作；混合付款仅向渠道请求差额；充值仅请求实际本金，不请求赠送额。
- READY 表示尚未发送；PENDING 表示渠道已受理；UNKNOWN 表示结果不确定；SUCCEEDED / FAILED 必须来自已验证的渠道结果。
- 使用 30 秒租约避免正常重复投递，领取租约时锁定并读取当时状态。超时恢复先按持久原商户单号查单。确定 NOT_FOUND 且业务仍可付款时，才允许用同一个单号发起。
- 超时、网络中断、进程崩溃、反序列化失败、渠道暂不可用均不能推定付款失败。UNKNOWN 不触发付款失败的释放逻辑；原预约期限到期仍按已确认业务规则释放，迟到实收进入原有资金异常核对。
- 已过期付款不再发起渠道单，但可查原单和接收迟到实收。服务每 15 秒扫描，常规待核对操作间隔 30 秒；一致性异常退避 5 分钟，单笔异常不阻断其他操作。
- 可信观察持久化后可独立重放。资金服务入账幂等，观察已应用标记和渠道终态投影同事务完成；较晚的失败不能覆盖已确认成功。

## 商户版本与原路退款

平台运营人员在“平台运营 → 租户支付商户”维护配置。每租户、每 provider 同时最多一个有效版本。换商户或凭据引用产生新版本；旧版本不可改、停用不可复活。新付款固定当时商户快照，后续查单及退款始终用原快照、原渠道交易号，不随当前商户配置迁移资金。

MOCK 仅在明确本地模式、非 production 且租户从未配置时自动建立 `mock:<tenantId>` 默认商户。已有配置但停用时不会自动重新开通。平台可预配置 WECHAT 的 merchantId、appId、credentialRef；不在页面粘贴密钥或证书内容。凭据引用需要由未来真实适配器及部署环境解析。

退款 UNKNOWN 时仅查原结果。只有渠道确认该退款号已终态失败、不会再成功，并经授权员工重试后，才创建新的渠道操作代次和退款号；内部退款记录、批准金额、余额分配及原付款来源均不变。旧代次失败不降级新代次；回调必须携带经过签名验证的操作归属，不能把旧代次回调送到新代次。MOCK 退款 FAILED 不允许在原号上改成成功；付款保留模拟迟到实收的能力。

历史本地 MOCK 意图可在首次显式操作时补建渠道记录，严格使用原 merchantId；读快照不创建渠道单。历史成功资金记录继续保留原账务和交易号。未记录过真实商户快照的 WECHAT 历史款不能自动猜测归属。

## HTTP 与外部 Agent

普通会话仍要求原身份、租户/场馆权限、CSRF 和工作区版本：

| 接口 | 行为 |
| --- | --- |
| `GET /api/tennis/payments/:id/channel` | 读取付款渠道快照 |
| `GET /api/tennis/topups/:id/channel` | 读取充值渠道快照 |
| `GET /api/tennis/refunds/:id/channel` | 读取退款渠道快照 |
| `POST <上述路径>/reconcile`，`{}` | 首次提交或按原操作查询恢复，由服务器状态决定；请求不携带金额、商户或外部单号 |
| `POST /api/tennis/payment-notifications/:operationId` | 独立渠道验签入口，保留原始 JSON 字节；不以登录、Cookie 或 Agent Bearer 证明到账 |
| `GET/POST /api/tennis/platform/tenants/:id/payment-merchants` | 平台查看历史或保存新版本 |
| `POST /api/tennis/platform/tenants/:id/payment-merchants/disable` | 停用指定版本的新收款 |

付款 reconcile 需要 book 权限；员工充值需要 manage_members；退款需要 refund，客户仅能查看本人退款。外部受控 Agent 的 `/agent/payments/:id/channel` 和 `/agent/topups/:id/channel` 提供同样查询及 reconcile，继续复核短期授权、接管和主体权限。

快照返回 sourceId、operationId、provider、simulation、state、checkout、lastCheckedAt、message、canReconcile；不返回商户凭据引用或密钥。当前 checkout 只可能是 `LOCAL_SIMULATION`，界面明确无真实扣费。模拟按钮只在本地能力开启且使用 MOCK 时可用。

Mock 通知使用 `x-mock-signature`；签名 JSON 必须包含 operationId，且认证结果的 bindingId/version、操作编号、金额和业务归属均与持久请求一致。旧的内部 Mock verify helper 仅用于已有合成验证，不能替代新通知入口的操作归属校验。通用可信事件不能通过 JSON cast 或 spread 伪造。

新事件语义哈希排除仅用于观察/签名时效的 issuedAt。同事件编号和同一事实可以用新的通知时间重放；改变金额、商户或交易号会拒绝。旧版本保存的完整事件哈希仍兼容完全相同的历史重放；若历史事件仅改 issuedAt，则要求核对，不静默改变旧证据。

## 退款原渠道交易金额（F15）

新退款请求保存 `originalPaymentCents`，对应微信退款请求的 `amount.total`，即原支付交易订单总金额。`amountCents` 仍为本次渠道退款金额；二者均为整数分。不得用 PMS 整单总额、累计实收、剩余可退金额或本次退款金额替代原交易总额。

普通退款按 `refund.payment_id` 找到原付款，再以租户、provider、商户、交易号及 source 精确匹配已验证的 `channel_transactions`；登记金额必须等于该笔付款的 external 金额。混合付款不含钱包本金/赠送；改期存在多笔付款时逐笔分别处理。异常退款定位异常本身的原交易号，充值额外实收不包含赠送额，也不误用正常到账的另一笔交易。

兼容规则：已有渠道请求及其 hash 不补写、不重算；重复 enqueue 原样返回。旧 MOCK 记录仍可跨实例查询及模拟完成。仅原渠道明确失败且员工授权重试时，新代次才从可信实收补充旧请求缺失的原金额；原字段已存在但矛盾时拒绝并回滚，不能自动纠正后发送。新请求修改或移除该字段会导致同号请求冲突。无需数据库迁移。

未来真实 `createRefund` 必须调用 `requireRefundOriginalPaymentCents`，缺失、非正安全整数、原金额小于本次退款均拒绝；查询原退款不因缺少创建参数而被封死。这不是现已启用真实 provider 的声明。微信营销优惠及 `payer_total` 与退款返回字段的映射仍属于产品适配，不由本字段推定。

官方依据：[微信支付官方 Go SDK AmountReq](https://github.com/wechatpay-apiv3/wechatpay-go/blob/6dbd7ce2ec5967ac2de5fa053479b411967b9c29/services/refunddomestic/models.go#L212)，其中 `Total` 为必填的原支付交易订单总金额。

## 验证及剩余条件

追加迁移 018/019，001–017 内容与校验不变。PostgreSQL 测试覆盖跨租户与动作权限、仅差额收款、持久 Mock 跨实例恢复、响应丢失、通知/查单并发、退款代次、原商户和过期不再发起；HTTP 测试核对原始字节验签及无会话回调边界。测试数量与最后结果以实施状态和本轮验证日志为准。

真正接入微信仍需选定支付产品并实现适配器、商户证书及密钥解析、渠道实际请求/查单/回调验签、真实退款和核账验证。各租户直接收款的要求不变；无平台代收。真实条件缺失不影响上述本地实现，但不能把本地模拟验收当成真实资金验收。
