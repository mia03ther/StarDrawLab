# StarDraw 支付宝与 SMTP 配置教程

本文对应后端的会员订阅和长期积分包支付接口。请不要把支付宝私钥、支付宝公钥、SMTP 密码或任何 Provider Key 提交到 Git，也不要通过聊天发送。

> 更新时间：2026-08-06
>
> 支付宝应用审核通过，只代表应用具备继续配置和申请产品权限的资格；电脑网站支付、周期扣款/代扣等产品权限可能需要分别开通。最终以你的支付宝开放平台控制台和商户审核结果为准。

> **当前产品决定（2026-08-07）：先不开通商家扣款/自动续费。** 当前只上线用户主动发起的电脑网站支付；订阅到期前两天发送“请主动续费”邮件。下面关于周期扣款的内容是后续申请和代码改造参考，不代表当前可以打开 `ALIPAY_PERIODIC_ENABLED`。

## 重要区分：一次性支付和自动续费

StarDraw 使用两条不同的支付宝能力：

| StarDraw 能力 | 支付宝接口/产品 | 是否需要单独开通 |
| --- | --- | --- |
| 用户购买月卡/年卡 | 电脑网站支付 `alipay.trade.page.pay` | 需要开通电脑网站支付 |
| 用户同意到期自动扣款 | 周期扣款/代扣签约 `alipay.user.agreement.page.sign` | 需要单独申请周期扣款/代扣产品 |
| 到期执行自动续费 | 周期扣款 `alipay.trade.pay` + `agreementNo` | 需要周期扣款权限和有效签约协议 |
| root 发起退款 | `alipay.trade.refund` | 需要正式商户退款能力 |

如果周期扣款产品没有开通，StarDraw 仍可以提供一次性订阅购买和到期前邮件提醒，但不会伪造自动续费，也不会在没有用户签约的情况下再次扣款。

## 一、支付宝沙箱

1. 登录支付宝开放平台，创建「电脑网站支付」应用。
2. 在应用中配置异步通知能力，并记录应用 App ID。
3. 生成 RSA2 密钥对：
   - 应用私钥只放在服务器 `server/.env` 的 `ALIPAY_PRIVATE_KEY`；
   - 应用公钥上传到支付宝开放平台；
   - 将支付宝生成的支付宝公钥放到服务器 `ALIPAY_PUBLIC_KEY`。
4. 沙箱阶段使用：

   ```env
   ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do
   ```

5. 异步通知地址必须能从公网 HTTPS 访问：

   ```env
   ALIPAY_NOTIFY_URL=https://你的域名/api/public/alipay/notify
   ALIPAY_RETURN_URL=https://你的域名/ai/billing
   ```

6. 将 App ID、密钥、网关和回调地址写入 `server/.env`。不要修改 `.env.example` 来放真实密钥。
7. 只有服务端通过支付宝验签，并且回调中的订单号、金额和交易状态与数据库订单匹配后，才会开通会员和发放积分。前端跳转成功不能作为入账依据。
8. 沙箱验收期间保持 `SUBSCRIPTION_PURCHASES_ENABLED=false`。完成数据库迁移、下文全部沙箱用例和正式密钥轮换后，再设置为 `true` 开放新下单。

## 二、如何申请支付宝自动续费权限

### 2.1 进入商户应用控制台

1. 打开支付宝开放平台：[https://open.alipay.com/](https://open.alipay.com/)。
2. 使用创建应用的企业支付宝账号登录。
3. 进入「控制台」或「开发者中心」中的「我的应用」/「应用列表」。
4. 打开 StarDraw 对应的应用，确认应用状态为已审核通过或可上线。
5. 进入「产品绑定」「产品中心」「能力管理」或类似入口。支付宝控制台不同账号类型和版本的菜单名称可能略有不同。
6. 搜索以下关键词之一：
   - `周期扣款`
   - `代扣`
   - `自动扣款`
   - `周期性扣款`

### 2.2 申请/绑定周期扣款产品

1. 选择与数字内容、软件订阅或 SaaS 服务匹配的周期扣款/代扣产品。
2. 按支付宝要求填写经营主体、网站地址、服务说明、用户协议、隐私政策、退款规则和客服信息。
3. 在产品权限中确认允许：
   - 用户页面签约；
   - 商户发起周期扣款；
   - 异步通知；
   - 签约解约或取消续费；
   - 与当前应用 App ID 绑定。
4. 提交审核，并保存审核通过后的：
   - 周期扣款产品名称；
   - `personalProductCode`/产品码；
   - 签约场景要求；
   - 沙箱和正式环境是否分别开通；
   - 是否有月度/年度扣款金额、次数或行业限制。

> 不要直接把 `GENERAL_WITHHOLDING` 当成你的正式产品码。它只是代码和示例中的常见占位值，实际必须以支付宝为你的商户和产品返回的产品码为准。

如果控制台中没有「周期扣款/代扣」入口，通常意味着当前商户主体、应用行业、签约产品或环境尚未获得该权限。此时应在支付宝开放平台工单/商家服务中询问：

> “我有一个已审核通过的企业 SaaS 数字内容订阅应用，需要用户主动签约并按月/年周期扣款。请确认应申请的周期扣款/代扣产品、签约产品码、签约场景、接口权限和沙箱开通方式。”

### 2.3 配置 StarDraw 的自动续费能力

拿到支付宝确认的周期扣款产品码后，在服务器 `server/.env` 中配置：

```env
ALIPAY_PERIODIC_ENABLED=true
ALIPAY_PERIODIC_PRODUCT_CODE=支付宝审核后提供的真实产品码
```

在此之前必须保持：

```env
ALIPAY_PERIODIC_ENABLED=false
```

StarDraw 会通过 `alipay.user.agreement.page.sign` 让用户在支付宝页面明确签约。签约成功后，支付宝异步通知中的协议号会绑定到当前用户的订阅；到期续费时才会使用该协议号调用 `alipay.trade.pay`。同步接口返回只表示支付宝已受理扣款请求，不会直接延长会员或发放积分；只有验签、金额和订单快照校验全部通过的异步通知才能完成续费入账。没有有效协议号、签约失败、用户取消签约或支付宝拒绝扣款时，系统不会继续扣款，并会按失败流程处理。

### 2.4 用户侧自动续费流程

用户体验应是：

1. 用户购买月度/年度套餐；
2. 用户在支付宝授权页面主动同意周期扣款；
3. StarDraw 保存签约状态，不保存支付宝登录密码；
4. 到期前两天发送邮件提醒；
5. 到期时按原订阅周期和金额发起续费；
6. 支付宝异步通知验签成功后才延长会员周期并发放当期赠送积分；
7. 续费失败时不延长会员、不发放新赠送积分，并通知用户重新购买或重新签约。

用户在 StarDraw 取消续费后，当前已付款周期继续有效，到期后不再发起下一次扣款。

支付宝官方入口和文档：

- [支付宝开放平台控制台](https://open.alipay.com/)
- [支付宝开放文档中心](https://opendocs.alipay.com/)
- [电脑网站支付接口：`alipay.trade.page.pay`](https://opendocs.alipay.com/)
- [周期签约接口：`alipay.user.agreement.page.sign`](https://opendocs.alipay.com/)
- [周期扣款接口：`alipay.trade.pay`](https://opendocs.alipay.com/)
- [退款接口：`alipay.trade.refund`](https://opendocs.alipay.com/)

开放文档需要按照接口名称搜索，部分产品文档和申请页面必须登录商户账号后才能看到。

## 三、自动续订

支付宝自动续订不是普通电脑网站支付自动具备的能力，需要商户单独开通周期扣款/代扣/签约产品，并确认应用具有对应权限。

商户确认开通后，再配置：

```env
ALIPAY_PERIODIC_ENABLED=true
ALIPAY_PERIODIC_PRODUCT_CODE=支付宝商户审核后提供的真实产品编码
```

在没有开通并验收周期扣款前，保持：

```env
ALIPAY_PERIODIC_ENABLED=false
```

此时系统可以正常创建订阅订单、接收一次性支付回调，并通过邮件提醒用户手动续费；不会伪造自动扣款，也不会在没有用户授权的情况下重复扣款。

## 四、正式环境切换

沙箱完成以下一次性支付测试后再切正式：

- 支付成功但浏览器断开；
- 支付宝重复发送异步通知；
- 异步通知晚于前端跳转；
- 金额不匹配；
- 非法签名；
- 订单重复激活；
- 后台退款和重复退款请求。

周期协议签约、自动扣款及其失败流程属于后续商家扣款版本，当前不作为上线前置条件；
在该版本完成并重新验收前，`ALIPAY_PERIODIC_ENABLED` 必须保持 `false`。

正式环境只需将网关改为：

```env
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
```

并替换正式应用的 App ID、应用私钥和支付宝公钥。切换密钥前先停止开放新支付功能，完成轮换后再打开支付开关。

支付通知可能因网络问题丢失。应用迁移 `035_subscription_payment_reconciliation.sql` 后，可在独立 Worker 中配置：

```env
SUBSCRIPTION_PAYMENT_RECONCILIATION_ENABLED=true
SUBSCRIPTION_PAYMENT_RECONCILIATION_INTERVAL_MS=60000
SUBSCRIPTION_PAYMENT_RECONCILIATION_LIMIT=50
SUBSCRIPTION_PAYMENT_RECONCILIATION_MIN_AGE_MS=120000
SUBSCRIPTION_PAYMENT_CLOSE_AFTER_MS=2100000
```

Worker 会通过 `alipay.trade.query` 查询待支付订单；成功结果必须再次核对 APPID、PID、订单号、交易号和金额，之后才幂等开通会员并发放积分。查询超时或状态未知会按退避策略重试，超过关单时间的未支付订单会先调用 `alipay.trade.close`，确认关闭后才取消本地订单。迁移、沙箱用例和 Worker 编排完成前保持该开关为 `false`。

## 五、SMTP 到期与主动续费提醒

在 SMTP 服务商创建专用发信账号，然后配置：

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your_smtp_user
SMTP_PASSWORD=your_smtp_password
SMTP_FROM=StarDraw <no-reply@example.com>
APP_TIMEZONE=Asia/Shanghai
```

系统在订阅到期前两天提醒用户登录 StarDraw 主动续费，不会表述为自动续订；所有有效订阅都会扫描，不依赖自动续费状态。同一订阅通过数据库时间戳防止重复发送。SMTP 未配置时不会伪造“发送成功”，后台日志会明确记录配置缺失。

## 六、退款状态补偿

退款请求先在数据库中预占本次应退的未消费积分，再调用支付宝。网络超时、支付宝处理中或系统错误无法证明退款结果时，退款记录会保持待处理，积分继续冻结，不会被释放，也不会被扣回。

完成迁移 `033_subscription_refund_reconciliation.sql` 后，在独立 Worker 的环境中设置 `SUBSCRIPTION_REFUND_RECONCILIATION_ENABLED=true`，由 Worker 定时调用服务导出的 `processPendingRefundReconciliations({ limit })`。该扫描具备以下保护：

- 每轮最多扫描 50 条，使用 PostgreSQL `FOR UPDATE SKIP LOCKED`，多实例不会重复领取同一批记录；
- 每条记录保存尝试次数、租约、最后错误和下次重试时间，退避时间逐次增加并封顶；
- provider 明确返回成功时才扣回预占积分；明确失败时才释放积分；查询仍不确定时继续冻结；
- 相同 `X-Idempotency-Key` 只能对应同一订单和同一退款参数，复用到其他订单或参数会返回冲突；
- 日志只记录退款编号、状态和错误摘要，不记录支付宝私钥、完整 provider payload 或敏感凭证。

建议先在沙箱用例中验证：退款请求超时后查询成功、查询明确失败、查询再次超时、重复扫描、两个 Worker 并发扫描以及同一个幂等键切换订单。未完成这些测试前保持退款入口关闭。

## 七、配置后的检查

配置完成后，在服务器上进行只读检查，确认变量已设置但不要打印变量值：

```bash
awk -F= '/^(ALIPAY|SMTP)_/{print $1 "=<configured>"}' server/.env
```

然后使用测试账号走完整沙箱流程。不要使用 `echo $ALIPAY_PRIVATE_KEY`、`docker inspect` 或其他会把密钥输出到终端/日志的命令。
