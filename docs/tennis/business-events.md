# 对外业务事件与受控轮询

PMS 在自身数据库保存业务事件，供外部 Gateway / Runtime 查询。此切片只提供事件事实和轮询服务，不建立 Runtime、不主动推送、不发送真实消息，也不接收外部声明的付款成功。

## 来源及事务保证

迁移 `017_business_events.sql` 在网球业务表上设置触发器。事件与产生事件的业务状态变化位于同一事务；事务或 savepoint 回滚会同时撤销事件。事件不从内部 audit 文案推断金额或完成状态，迁移也不把历史记录批量补发成刚发生的事实。

| 事件类型 | 业务来源与含义 |
| --- | --- |
| `booking.held` | 订单建立为 `HELD`，表示已占位待付款；不等于已确认或已收款 |
| `booking.confirmed` | 订单进入 `CONFIRMED`，包含成功付款和零元订单；看 `paymentStatus` 区分 `PAID` / `NOT_REQUIRED` |
| `booking.cancelled` | 整单进入 `CANCELLED`；不等于退款完成 |
| `booking.line_cancelled` | 一条有效明细变为已取消，覆盖部分取消；整单取消也可能有各明细事件 |
| `booking.expired` | 订单实际进入 `EXPIRED`，不是仅按时间推测 |
| `booking.amended` | 改期记录实际进入 `APPLIED`；预览、暂存和待补款阶段不产生此事件 |
| `payment.result` | 付款尝试进入 `SUCCEEDED`、`FAILED`、`EXPIRED`、`CANCELLED`、`REFUND_REQUIRED`；不发布 `PENDING` |
| `topup.result` | 线上充值实际进入 `SUCCEEDED` / `FAILED`，或授权线下充值批次建立；线上入账不会再发布一条线下批次事件 |
| `refund.result` | 单笔原支付来源退款进入 `SUCCEEDED` / `FAILED`；`REQUESTED`、`PROCESSING` 和发起重试不冒充成功 |
| `conversation.handoff` | 会话 generation 改变，记录 `HUMAN` / `AGENT`、generation 与接管员工 |

结果事件的金额取自对应业务行，单位为人民币分。失败、到期、取消事件里的金额仍是该付款/充值/退款尝试的申请构成，不表示实际到账；必须结合 `status` 解释。`REFUND_REQUIRED` 表示到账异常需要处理，不等于已退款。事件不携带商户号、外部支付流水号、退款渠道凭据、Token 或会话文本。

同一资源状态未变化的重试不生成重复事件。退款失败、授权重试、再成功会留下两个不同结果事件。若业务在一个事务内发生多个有效转换，可能记录多个转换；外部不能据此重复扣款或退钱，应通过业务 API 查询当前状态。支付改期过程中一度置为成功、随后 savepoint 回滚的暂态成功不会保留。

额外重复扣款但没有改变原付款/充值状态的异常，仍以原有异常工作台为事实来源；本切片不把这类额外流水伪装成原付款再次成功。

## 事件格式

`BusinessEvent` 字段如下：

- `eventId`：随机 UUID，发布后稳定；消费者以它去重。
- `type`、`schemaVersion`：事件类型与格式版本，当前格式版本为 1。
- `tenantId`、`venueId`、`customerId`：事实归属；员工会话的 `customerId` 可以为 `null`。
- `subjectId`：源资源的发起主体，或会话所属主体；不是对当前数据库操作执行人的猜测。员工代办、退款等情况下不一定是客户主体。若外部要关联客户身份，应使用受控的客户身份绑定，不能把此字段直接当消息收件人。
- `resource: { type, id, version }`：资源标识及该资源的事件版本。事件版本从 1 递增，与业务实体自己的 revision 区分；订单 payload 另带当次 `orderRevision`，会话带 `generation`。
- `occurredAt`：事件生成时间，带时区。排序与恢复不能仅按时间进行。
- `payload`：明确的业务状态、业务 ID、金额或时段摘要；详单仍通过原受权限控制的查询 API 获取。

订单建立事件不会快照整单全部明细；只有包含所有明细和库存的完整事务提交后，外部才读得到它。退款结果按原付款来源分别发布，`refundGroupId` 可关联整组退改；不能把其中一笔成功解读为整组全部成功。

## 受控读取

导出 `pollBusinessEvents(db, actor, venueId, input)`，`actor` 必须来自服务器已核验的会话、短期委托或 Gateway 身份绑定。服务使用 `withBookingTransaction` 和场馆 `read` 权限，每次重新检查租户、客户/员工、场馆和绑定是否有效。

- 客户只看本租户、本场馆、自己的 `customerId`；会话事件还须匹配 `subjectId`。
- 员工只看有 `read` 权限的场馆；充值事件另需 `manage_members`，会话事件另需 `book`。`VIEWER` 不获得这两种额外读取权限。
- 查询参数只有 `pageSize`（1–100，默认 50）和 `cursor`（之前返回的随机事件 UUID）。不能提交 tenant/customer/subject 等参数改变身份。
- 无效或重复参数返回 `INVALID_EVENT_QUERY` / HTTP 400；不存在或当前不可见的游标返回 `INVALID_EVENT_CURSOR` / HTTP 400，不透露它属于哪个租户或客户。

返回 `{ events, nextCursor, hasMore }`。过滤所有权限条件后，按内部序号升序取 `pageSize + 1` 来确定下一页。因此第一页全是无权事件时也不会误报“没有自己的事件”。

**事件轮询和订单目录的末页语义不同：** `nextCursor` 始终保留这次最后交付的 `eventId`，空页保留输入游标；只有从未交付过事件时为 `null`。消费者持久化已处理事件的游标，再继续轮询。`hasMore=false` 仅表示目前已经追平，未来仍可能出现新事件。读取不删除事件，不替消费者确认处理完成；重试会返回相同的事件 ID，按至少一次读取设计。

权限范围改变后，旧游标可能不再可见。消费者应在当前身份范围重新建立消费位置，并通过事件 ID 去重；不要把旧租户、场馆或客户的游标挪到新范围。当前不做自动清理或时限保留；租户删除时一并删除该租户事件。正式删除/保留政策另行制定。

## 不漏事件的排序机制

`business_event_counters` 每租户一行，是普通事务性表，不使用 PostgreSQL sequence / identity 生成投递序号。触发器更新这一行后持有行锁直到提交，因此另一个同租户发布者不能拿到更大序号并先提交。回滚会恢复计数器和事件。

现有业务的租户事务锁继续生效；计数器自身也保证不依赖应用锁的写入不会倒序发布。不同租户互不共用投递计数器。API 仅以事件 UUID 恢复位置，不暴露内部序号、全局序号或全局事件总数。

## 验证

- `tests/tennis/business-events.test.ts`：查询参数、分页上限和禁止身份覆盖。
- `tests/tennis/business-events.integration.test.ts`：真实业务服务产生事件；回滚与过期；混合/纯余额支付；本金与赠送充值；退款失败、重试与成功；部分取消及未付款改期；零元订单；迟到付款；支付改期 savepoint 回滚；客户、场馆、租户、员工权限及委托撤销；并发未提交发布者的实际数据库锁与无漏读恢复。

测试只使用独立 `tennis_test` 和本次合成租户。最终验证由根任务统一运行，不把源码完成当作真实渠道已联调。
