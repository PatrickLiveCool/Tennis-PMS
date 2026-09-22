# 后台 AI 助手与外部智能体分离

后台 AI 助手延续 GreenPMS 入口和使用方式，目标是平台运营管理员在 UI 配置模型、Base URL、API Key、启停和测试连接。租户员工使用助手；租户不能查看模型配置和密钥。外部 Runtime 仍独立连接客户 Gateway，通过既有受控业务 API 成交，配置和会话与后台助手分离。

## 当前可运行边界（2026-09-21 更新）

- 配置仍只由平台运营者维护；租户员工使用助手，不能读取或修改模型地址与密钥。
- 本地启动及独立服务启动已注入真实 HTTPS Chat Completions 传输。平台保存模型、Base URL、API Key 并启用后，可点击“测试连接”；测试要求模型实际返回工具调用，不把配置保存当成连接成功。未配置时不发起模型请求。
- 已按用户指定在本机加密保存测试配置并完成真实模型联调，供应商为 `https://qintopia.ccwu.cc/v1`、模型为 `deepseek_v4`；本地 API 启动自动带入。密钥不进入 Git 或文档。具体证据见 [新版助手与红土场验收记录](assistant-parity-2026-09-21.md)。
- 查询：当前页面日期范围和已选时段、球场基础价、真实时段折扣、排场占用、当前订单状态/明细金额/剩余可退金额。姓名、电话、客户 ID、商户信息及支付交易号不由查询工具外发；员工自己输入的问题会送往其平台配置的模型。
- 准备业务：`prepare_booking` 支持页面已选或明确指定的多片球场/时间；`prepare_order_action` 支持付款、退款、取消及单条明细改期/改场。服务端复核场馆权限、订单身份、营业时间、时长和占用后，返回可带入表单的结构化内容；不生成订单、不占场、不扣退资金。缺少退款金额时由员工在正式表单填写，模型不能编造。
- 员工点击“带入/准备”后，复用现有预订、改期、付款、退款表单，报价/改期核对、版本及最终业务确认继续由原服务端执行。新增预订追加所选时段并去除完全相同的条目，保留已填客户；改期只更新指定明细，其他草稿行保留，旧预览失效。
- 助手侧栏对齐 GreenPMS v1.7.2，支持 Markdown 表格、流式回答、查询进度和停止生成。与订单独立开关，桌面并列、手机上下分屏；关闭保留输入与阅读位置。手机回车换行、桌面回车发送并保护中文输入法。恢复只查询原消息，不自动重复调用模型。
- `connectionAvailable` 表示传输能力已接入，`configReady` 表示平台配置完整，`configured` 两者同时满足；只有“测试连接”成功才证明当前供应商可用。

## 提问分析（2026-09-23）

后台助手的新提问已接入独立脱敏分析记录、UTC 日汇总和 Codex 只读导出。复用本人回答的“已解决／未解决”反馈，按租户、场馆隔离；分析故障不触发模型重试，分析锁等待有独立短时限。历史聊天不回填。存储、保留、专用账号与导出方法见 [问题分析与 Codex 导出](ai-question-records.md)。

## HTTP 契约

- `GET/PUT /api/tennis/platform/ai-config`：独立的 `backoffice_ai_config`；GET 返回 enabled/model/baseUrl/hasApiKey/revision/connectionAvailable。PUT 只接受 enabled/model/baseUrl/apiKey?/expectedRevision。省略密钥保持原值，空字符串清空；已有凭证时改变来源域名或清空地址必须显式重新提交/清空凭证。
- `POST /api/tennis/platform/ai-config/test`：`{expectedRevision}`，只测试已保存配置，限平台管理员。没有 transport 时明确不可用。测试实际验证 Chat Completions 工具调用能力。
- `GET /api/tennis/backoffice-assistant/status`：员工权限，返回 enabled/configReady/configured/connectionAvailable。
- `GET/POST /api/tennis/backoffice-assistant/conversations`：按当前员工、租户、场馆隔离；GET query 和 POST body 都用 `{venueId}`。
- `GET /conversations/:id`：本人会话，最多最近 100 条消息/请求，超时请求变为 FAILED。
- `POST /conversations/:id/messages`：`{messageId,content,source?:"USER"|"SUGGESTION"|"UNKNOWN",context?:{page,orderId?,date?,viewDays?,selection?}}`，默认返回 JSON 会话详情；`Accept: text/event-stream` 返回 `status/delta/result/error` 事件，最终 result 为同一会话详情。两者复用身份、CSRF、工作空间版本及消息幂等校验。相同 messageId 只执行一次，相同 ID 不同输入拒绝，重试已失败请求须用新 ID。断开流中止本次生成，迟到回答不能落库。
- `POST /conversations/:id/messages/:messageId/feedback`：`{resolved}`，仅本人的助手消息。

既有 `/assistant`、`/agent`、`/gateway` 的 Runtime 会话、业务操作、身份及接管保留。迁移 024 不复制原 `platform_ai_config.encrypted_key`：原 Key 属于 Runtime；新模型 Key 使用独立数据表和 AES-GCM 用途标签。

## 权限和执行

后台助手最低权限为当前场馆 read，客户身份禁止；即便同租户管理员也不能查看另一员工的私人助手会话。上下文中的订单必须属于当前场馆。每次模型/工具调用前、结果落库前重新校验权限、配置版本和请求有效期。

请求在数据库先登记 RUNNING，租户内同一员工最多一个执行中请求。模型执行总期限为 150 秒，超时中止信号传给执行器并记录 FAILED；180 秒数据库租约用于进程崩溃后的恢复。迟到结果不能追加答案，同 ID 再发不会调用第二次。请求失败不保存上游响应体、错误堆栈或密钥，返回通用失败状态；本地入口在落库前再次校验字段白名单、权限和密钥泄漏。历史最多 21 条/24,000 字符；单次最多 4 轮模型调用、6 次工具。

工具的租户、场馆和当前订单均由会话及服务端上下文绑定，模型不能选择任意业务身份。页面选择携带的球场 ID 逐一校验租户与场馆，发给模型时转成球场名。表单动作同样在落库前再次校验权限与目标归属，不能只依赖前端隐藏按钮。

传输仅使用配置中的公网 HTTPS 地址，DNS 校验后固定解析地址；不跟随重定向、不自动重试；响应上限 1 MB，单次请求 60 秒，受整体 150 秒执行期限和 AbortSignal 控制。密钥只在服务器解密，服务方响应体和凭据不作为错误消息落库。

外部客户 Runtime、Gateway 与员工助手仍保持分离：客户自动化流程沿用既有受控 API；本次只增强员工助手的查询和业务准备能力。

## 验证

`backoffice-assistant.test.ts` 验证独立加密格式及地址约束；`backoffice-model.test.ts` 验证无默认外发、白名单、身份注入、轮数上限与权限复核；`backoffice-assistant.integration.test.ts` 验证平台/租户隔离、本人会话、配置来源变更、消息重放、并发/超时恢复和撤权。真实模型联调与人工验收单独记录。

### 较早一轮验证（配置真实模型之前）

- 类型检查、生产前端构建、76 文件 / 1401 项单测、26 文件 / 326 项数据库集成通过；覆盖新传输的验证地址、固定 DNS、拒绝重定向、响应校验与中止，以及跨租户伪造选择、权限、占用冲突、准备后订单/资金不变。
- 桌面/390px 浏览器通过：自动会话、当前三天与选择上下文、带入后客户保留且不重复选场、Esc 问题恢复、真实合成订单的改期表单预填且订单 revision/时段未变。浏览器模型回复是夹具；真实配置未设置，不能据此声称真实模型回答通过。
- 本机平台账号登录核对 `connectionAvailable=true`、`enabled=false`、`hasApiKey=false`，配置由用户自行填写。仅重启独立本地 API、更新静态预览，未部署。
- 原始未提交改动已备份，原暂存补丁保持逐字节不变。日志、截图和快照：`.local-workspace/assistant-workbench-2026-09-21/`。
