# 订单目录与今日工作台

## 查询契约

员工/客户接口 `GET /api/tennis/venues/:id/orders` 和外部智能体接口 `GET /api/tennis/agent/orders` 使用同一分页目录。外部智能体的租户、客户与场馆取自 PMS 签发的短期委托；查询参数不能扩大作用域。

| 参数 | 规则 |
| --- | --- |
| `q` | 可选，最多 200 字符；订单 ID 或客户昵称的字面子串，不区分大小写，`%` 与 `_` 没有通配含义 |
| `status` | 可选：`HELD`、`CONFIRMED`、`EXPIRED`、`CANCELLED`、`COMPLETED`；`ACTIVE` 表示 `HELD` 或 `CONFIRMED` |
| `date` | 可选，真实 `YYYY-MM-DD` 日期；按场馆 IANA 时区计算整日边界 |
| `pageSize` | 整数 1–100，默认 25 |
| `cursor` | 上一页 `nextCursor`；对应本租户、场馆及当前客户作用域内的一笔订单 |

返回 `{ orders, nextCursor }`。每笔订单保留完整 `lines` 与订单字段，增加 `customerName`、`matchingLines`；`matchingLines` 仅含未取消明细，按起始时间排序并附上当前球场名称 `courtName`。传入 `date` 时再限制为与该场馆当地日相交的明细。无下一页时 `nextCursor` 为 `null`。

所有过滤在分页之前执行，不先截取最近 100 单。排序为 `created_at DESC, id DESC`，游标比较使用数据库原始时间精度；不会因 JavaScript 毫秒精度丢失微秒而漏单。翻页期间新增的订单出现在刷新后的第一页；目录不提供跨请求的冻结快照。

重复参数、非法类型、未知参数、无效日期/状态/页大小返回 HTTP 400 / `INVALID_ORDER_QUERY`。无效或超出当前作用域的游标返回 HTTP 400 / `INVALID_ORDER_CURSOR`。身份、租户和场馆访问权限仍按原业务入口校验。查询先处理已经到期的占位，再应用状态过滤。

## 后台行为

订单页在服务端搜索与筛选，可前后翻页及返回第一页。筛选与分页位置随身份、租户、场馆作用域保存；改变查询条件从第一页开始。读取失败展示错误及重试，不显示成“没有订单”。

今日工作台使用场馆当地日期和 `ACTIVE`，显示每笔订单今日的有效明细。跨午夜明细按 `[startAt, endAt)` 与当地日的相交判断：恰好在今日零点结束的明细不属于今天，跨越零点的明细属于今天。已取消明细、只有他日有效明细的订单均不列入今日。金额明确标为“整单应付”，不冒充当日消费或收款。今日列表也支持分页；页面跨越午夜后更新日期。

## 验证覆盖

- `tests/tennis/views.test.ts`：日期边界与查询校验。
- `tests/tennis/order-directory.integration.test.ts`：超过 100 单仍可检索；微秒及同时间排序无漏单、重复；取消明细、跨午夜、半开边界和场馆时区；客户/场馆/租户/游标隔离；过期占位处理。
- `tests/tennis/api.integration.test.ts`：HTTP 分页和完整目录搜索、400 错误。
- `tests/tennis/assistant.integration.test.ts`：委托入口分页、搜索、参数限制及人工接管后撤销访问。

真实 PostgreSQL 测试使用独立 `tennis_test` 与本次合成租户，最终运行结果统一记录在项目验收状态中。
