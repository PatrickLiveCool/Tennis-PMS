# 微信支付 API v3 共用安全层（F13）

本层实现真实协议的请求签名、响应验签、通知验签及解密，但**不是已接通的微信支付适配器**。它不发送 HTTP、不选择 JSAPI/H5/Native、不读取商户凭据、不生成支付链接、不认证付款事实，也未注册到本地服务。应用继续只运行 MOCK。

## 协议依据

2026-09-19 读取微信支付官方 Go SDK，固定参考 commit `6dbd7ce2ec5967ac2de5fa053479b411967b9c29`：

- [请求签名原文与 Authorization](https://github.com/wechatpay-apiv3/wechatpay-go/blob/6dbd7ce2ec5967ac2de5fa053479b411967b9c29/core/auth/credentials/wechat_pay_credential.go)
- [响应与通知签名、五分钟时效](https://github.com/wechatpay-apiv3/wechatpay-go/blob/6dbd7ce2ec5967ac2de5fa053479b411967b9c29/core/auth/validators/wechat_pay_validator.go)
- [公钥 ID 与 RSA PKCS1 验签](https://github.com/wechatpay-apiv3/wechatpay-go/blob/6dbd7ce2ec5967ac2de5fa053479b411967b9c29/core/auth/verifiers/sha256withrsa_pubkey_verifier.go)
- [通知先验签再 AES-GCM 解密](https://github.com/wechatpay-apiv3/wechatpay-go/blob/6dbd7ce2ec5967ac2de5fa053479b411967b9c29/core/notify/notify.go)
- [通知字段](https://github.com/wechatpay-apiv3/wechatpay-go/blob/6dbd7ce2ec5967ac2de5fa053479b411967b9c29/core/notify/notify_request.go)

实现使用 Node 原生密码库，没有引入第三方支付 SDK，也未复制其实现代码或凭据。

## PMS 内部契约

源码：[wechatpay-v3-security.ts](../../packages/db/src/tennis/wechatpay-v3-security.ts)。

`WechatPayV3Security` 接收服务端配置的商户号、商户证书序列号及私钥、32 字节 API v3 密钥，以及按 ID 明确登记的微信支付公钥或平台证书。生产配置应由未来凭据解析器按**原交易的不可变商户版本**提供；不能从回调 body 或 URL 获取。`credentialRef` 仍是不透明引用，不能直接当文件路径或远程地址。

- `prepareRequest`：签署原 HTTP 方法、原编码路径及查询串、秒级时间戳、随机 nonce、原始 body，保留协议末尾换行。返回固定 `https://api.mch.weixin.qq.com` 下的完整请求资料，拒绝绝对 URL、路径归一化、控制字符、fragment 和 GET body。未来 transport 必须原样发送，不重排查询、不重新序列化正文、不跨域重定向；本方法本身不发请求。
- `verifyResponse`：对原始正文验签，再允许调用方解释 JSON/HTTP 状态。精确匹配预置信任的公钥 ID 或证书 serial，支持同时登记轮换前后的密钥，拒绝未知 ID、重复歧义头、非法 Base64、签名探测串、错误签名以及时间差达到 300 秒的报文。平台证书检查 serial 与有效期；只接受 RSA2048。未知 ID 不触发任何下载。
- `decryptNotification`：先做上述验签，再校验 `encrypt-resource` 和 `AEAD_AES_256_GCM`，用原 12 字节 nonce、AAD、16 字节认证标签解密，最后解析 UTF-8 JSON。认证失败不暴露部分明文。输出 `resource: unknown`，不是 `VerifiedPaymentEvent` 或 `VerifiedRefundEvent`。
- 所有向外错误只含固定错误码；不回传私钥、API v3 密钥、签名原文或支付报文。配置保存在类私有字段，调用方改动配置对象不能改变既有实例的凭据。

## 接下来的产品适配仍需完成

1. 明确微信支付产品及商户接入身份，扩展真实 `CheckoutAction` 和相应前端付款行为；本期没有代选产品。
2. 实现网络 transport：TLS、超时、禁止重定向、响应大小限制、先验签再解释状态。未认证的错误响应、网络故障和未知状态不能映射为资金失败或 `NOT_FOUND`；继续使用既有 UNKNOWN 和原单核对。
3. 由验签后的 `mchid + out_trade_no/out_refund_no` 查询持久操作映射，并核对原商户、appid、订单、金额、币种、原交易号及退款代次。不得从回调 URL 复制 operationId；有效签名也不代表属于当前租户或当前操作。
4. 退款输入需包含原渠道支付总额 `amount.total`，不能把钱包加外部款的整单总额代入。现有 `RefundPortInput` 暂未扩展，避免在产品适配前改变已验证的业务契约。
5. 配置真实商户密钥/证书或公钥轮换，并完成真实支付、查单、回调、退款及租户直收核账。PMS 内不开发体外 Runtime，微信消息入口仍独立接入。

测试：[wechatpay-v3-security.test.ts](../../tests/tennis/wechatpay-v3-security.test.ts)，仅用合成 RSA/AES 密钥和通知，不访问支付网络。最终运行结果见 [实施状态](implementation-status.md) 和总项目 F13 验证日志；不得把这些协议测试写成真实商户联调或真实交易验收。
