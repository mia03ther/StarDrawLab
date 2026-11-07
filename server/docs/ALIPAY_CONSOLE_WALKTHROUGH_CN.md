# StarDraw 支付宝电脑网站支付控制台配置手册

> 核验日期：2026-08-07  
> 适用范围：StarDraw 网页 SaaS 的电脑网站支付、退款，以及后续自动续费申请。  
> 资料范围：仅使用支付宝开放平台、支付宝开放文档、支付宝商家平台等官方来源，并对照当前 StarDraw 代码。

## 先看结论

1. StarDraw 当前支付宝 SDK 配置只支持 **密钥（普通公钥）模式 + RSA2**。在控制台的“接口加签方式”中应选择 **密钥**，不要选择“证书”。
2. 一次性订阅购买对应 **电脑网站支付**，接口是 `alipay.trade.page.pay`，当前代码的接口和产品码 `FAST_INSTANT_TRADE_PAY` 与官方文档一致。
3. `alipay.trade.query` 丢通知查询和 `alipay.trade.close` 超时关单代码已实现，但仍需应用迁移 035、启用独立 Worker 并完成沙箱验收，之后才能打开生产支付。
4. 自动续费对应 2026 年新版 **商家扣款**，不是电脑网站支付自带能力。该产品需单独申请，官方当前不支持沙箱，并有较高准入门槛。
5. 当前自动续费代码与新版商家扣款不完全匹配，必须保持 `ALIPAY_PERIODIC_ENABLED=false`，不能只填一个产品码就上线扣款。
6. 配置期间保持 `SUBSCRIPTION_PURCHASES_ENABLED=false`。不要重启线上服务，也不要把任何真实私钥提交到 Git 或发到聊天中。

## 一、从 develop/manage 进入正确应用

打开 [支付宝开放平台控制台](https://open.alipay.com/develop/manage) 并用已经实名认证、拥有 StarDraw 应用权限的账号登录。

1. 在应用列表选择 **网页/移动应用**，不要选择小程序、生活号或第三方应用。
2. 找到 StarDraw 对应应用，点击应用或 **详情**。
3. 先确认这是“自研应用”，不是替其他商家代开发的第三方应用。
4. 记录应用名称下方的数字串，这就是 `APPID`，对应 `ALIPAY_APP_ID`。
5. 进入应用内的 **开发 > 开发设置 > 开发信息**。

支付宝官方的[创建网页/移动应用](https://opendocs.alipay.com/open/009yp4)文档说明，应用创建后处于“开发中”，创建时生成唯一 APPID；密钥和 APPID 一一对应，不同应用不能混用。官方[查询 APPID](https://opendocs.alipay.com/common/0i24qo)文档也确认，应用名称下方的数字串即 APPID。

如果还没有正确的网页应用，可直接从官方[电脑网站支付接入准备](https://opendocs.alipay.com/open/01didh)中的“创建应用”入口创建。创建时填写真实应用名称、图标、网站和经营信息，网站应已上线并可正常访问。

## 二、配置接口加签：选择“密钥”，不是“证书”

在 StarDraw 应用详情页按以下路径操作：

**开发 > 开发设置 > 开发信息 > 接口加签方式（密钥/证书）> 设置**

然后执行：

1. 阅读提示并点击 **确认**。
2. 加签方式选择 **密钥**。
3. 加签算法选择 **RSA2**。
4. 下载并安装官方[支付宝开放平台密钥工具](https://opendocs.alipay.com/open/02kipk)。
5. 在密钥工具选择 **生成密钥 > 密钥 > RSA2**，生成应用公钥和应用私钥。
6. 将 **应用私钥** 保存到离线、安全的位置。支付宝平台不会保存应用私钥，丢失后无法从控制台找回。
7. 复制 **应用公钥**，回到控制台粘贴到“上传应用公钥”，完成短信验证码或支付密码验证。
8. 配置成功后，点击保存或下载 **支付宝公钥**。

完整控制台步骤见支付宝官方[设置密钥加签方式](https://opendocs.alipay.com/common/02kdnc)。官方明确区分了三个不同对象：

| 名称 | 用途 | StarDraw 配置 |
| --- | --- | --- |
| 应用私钥 | StarDraw 给请求签名，只能由你保管 | `ALIPAY_PRIVATE_KEY` |
| 应用公钥 | 上传给支付宝，支付宝用它验证 StarDraw 请求 | 不写入当前 `.env` |
| 支付宝公钥 | StarDraw 验证支付宝响应和异步通知 | `ALIPAY_PUBLIC_KEY` |

最常见的错误是把“应用公钥”填进 `ALIPAY_PUBLIC_KEY`。这里必须填 **支付宝公钥**。

### 普通公钥与证书模式的区别

支付宝官方[接口加签方式说明](https://opendocs.alipay.com/common/02kf5p)规定，一个 APPID 同一时间只能选择一种方式：

| 模式 | 所需材料 | 特点 | 当前 StarDraw |
| --- | --- | --- | --- |
| 密钥/普通公钥 | 应用私钥、应用公钥、支付宝公钥 | 安全性、真实性 | **支持，应选择** |
| 公钥证书 | 应用私钥、应用公钥证书、支付宝公钥证书、支付宝根证书 | 额外提供抗抵赖能力，部分资金支出接口强制要求 | **不支持** |

证书模式需要上传 CSR，并在 SDK 中配置三份证书路径；官方步骤见[设置证书加签方式](https://opendocs.alipay.com/common/056zub)。当前 `server/providers/alipayAPI.js` 只向 SDK 传入 `appId`、`privateKey`、`alipayPublicKey` 和 `gateway`，`server/.env.example` 也没有三个证书路径，因此不能选择证书模式。

如果控制台当前已经是证书模式，不要把 `.crt` 内容硬塞进 `ALIPAY_PUBLIC_KEY`。应先保持支付关闭，再决定将控制台变更为密钥模式，或后续为 StarDraw 增加证书模式适配。支付宝官方[更新密钥/证书](https://opendocs.alipay.com/common/05wt1i)说明，变更加签方式存在旧方式的过渡期，切换必须配合代码和密钥轮换完成。

## 三、获取 PID / seller_id

`PID` 是签约商家的支付宝唯一标识，通常是以 `2088` 开头的 16 位数字，对应 StarDraw 的 `ALIPAY_SELLER_ID`。

官方路径：登录开放平台，右上角进入 **账户中心 > 密钥管理 > mapi 网关产品密钥**，页面中以 2088 开头的 ID 即 PID。见支付宝官方[查询 PID](https://opendocs.alipay.com/common/0i23eu)。部分新版页面也会在 **账户中心 > 主账号信息 > 账号 ID** 展示同一商家账号标识。

必须保证以下三者属于同一套正式环境授权关系：

- `ALIPAY_APP_ID`：StarDraw 正式应用 APPID；
- `ALIPAY_SELLER_ID`：实际开通电脑网站支付并收款的商家 PID；
- 应用与商家账号的绑定关系。

如果开发者账号和收款商家账号不是同一个入口，登录[支付宝商家平台](https://b.alipay.com/page/home)，按 **账号中心 > 绑定 > APPID 绑定 > 添加绑定**，输入 APPID。支付宝官方[绑定应用](https://opendocs.alipay.com/open/0128wr)说明，支付和资金产品需要将 APPID 与商家 PID 绑定，且不同主体账号不能绑定。

## 四、上线应用并开通“电脑网站支付”

电脑网站支付的官方申请条件包括：网站能正常访问、经营内容和商品信息完整、完成 ICP 备案，并且备案主体与支付宝账号主体一致；主体不一致时需上传授权函。详见[电脑网站支付产品介绍](https://opendocs.alipay.com/open/00dn7j)。

按以下顺序操作：

1. 在开放平台应用详情中补齐应用名称、图标、网站和开发设置。
2. 点击 **提交审核**。官方预计审核时间约 1 个工作日。
3. 审核通过后确认应用状态为 **已上线**。只有“已上线”应用才能在正式环境调用接口，见[上线应用](https://opendocs.alipay.com/open/009yp8)。
4. 登录[支付宝商家平台产品中心](https://b.alipay.com/page/product-mall/all-product)。
5. 搜索并进入 **电脑网站支付**，点击 **立即开通**。
6. 按页面要求提交网站、经营内容、备案和主体材料，同意协议并提交审核。
7. 审核通过后，在[产品开通情况](https://mrchportalweb.alipay.com/dynlink/productSign/signManage.htm)确认状态为 **已开通**。

官方电脑网站支付产品的[直接开通入口](https://b.alipay.com/page/product-mall/product-detail/I1080300001000041203)和通用[开通产品流程](https://opendocs.alipay.com/open/009ypa)均说明：自研应用先上线，再由商家账号在产品中心开通产品。不要只在 `develop/manage` 里看到应用审核通过就认为支付产品已经开通。

## 五、配置异步通知与返回页面

StarDraw 的正式配置应使用：

```env
ALIPAY_NOTIFY_URL=https://你的正式域名/api/public/alipay/notify
ALIPAY_RETURN_URL=https://你的正式域名/ai/billing
```

两者作用不同：

- `notify_url`：支付宝服务器以 POST 方式通知 StarDraw，支付入账必须以验签后的异步通知或主动查询为准。
- `return_url`：用户支付后浏览器跳回的页面，只用于用户体验，不能作为付款成功依据。

支付宝官方[电脑网站支付快速接入](https://opendocs.alipay.com/open/00dn7k)要求：同步跳转不可靠，必须验签异步通知，核对 `app_id`、`out_trade_no`、`total_amount` 等字段；没有收到通知时必须调用 `alipay.trade.query` 查询。

通知 URL 必须满足：

1. 从公网可访问，推荐 HTTPS；
2. 不需要用户登录态；
3. 不做 301/302 重定向；
4. 不带空格或 HTML；
5. 处理成功后响应纯文本 `success`；
6. 能安全处理支付宝重复通知。

官方[电脑网站支付异步通知说明](https://opendocs.alipay.com/open/00dn7l)指出，未收到 `success` 时支付宝会按 4 分钟、10 分钟、10 分钟、1 小时、2 小时、6 小时、15 小时的频率重试，并要求验签后继续核对订单号、金额、seller_id 和 app_id。

### “应用网关”不是支付 notify_url

应用详情中的 **开发 > 开发设置 > 开发信息 > 应用网关** 用于部分被动消息和 From 蚂蚁消息。支付宝官方[应用网关](https://opendocs.alipay.com/common/02qibh)特别说明：支付结果通知使用支付 API 参数中的 `notify_url`，不是仅靠控制台应用网关。

仅接入电脑网站支付时，“应用网关”是可选项，应保持为空；不要把支付 `notify_url` 填成应用网关。这两类回调协议不同，当前 StarDraw 也没有为其他支付宝消息提供独立处理路由。如果后续产品强制要求应用网关，应先增加独立路由并按该产品的消息协议完成验签和响应。无论应用网关如何配置，支付 API 中的 `notify_url` 都必须正确传入。

## 六、沙箱配置

打开支付宝官方[沙箱控制台](https://open.alipay.com/develop/sandbox/app)：

1. 选择同步到沙箱的 StarDraw 应用。
2. 在应用信息中复制沙箱 APPID、沙箱应用私钥和沙箱支付宝公钥。
3. 在沙箱账号区域取得对应环境的商家/卖家 ID 和买家账号。
4. 配置沙箱网关：`https://openapi-sandbox.dl.alipaydev.com/gateway.do`。
5. 电脑网站扫码支付必须使用沙箱钱包；PC 登录支付使用沙箱买家账号。
6. 沙箱只支持余额支付，不支持银行卡、余额宝或花呗。

支付宝官方[沙箱环境](https://opendocs.alipay.com/common/02kkv7)说明，沙箱控制台会提供 APPID、默认应用私钥、支付宝公钥和网关；沙箱与生产数据完全隔离。电脑网站支付的[沙箱调试说明](https://opendocs.alipay.com/open/00dn7o)还要求：沙箱调通后必须在生产环境重新验收。

沙箱环境示例：

```env
SUBSCRIPTION_PURCHASES_ENABLED=false
ALIPAY_APP_ID=从沙箱控制台复制
ALIPAY_SELLER_ID=沙箱商家或通知中的seller_id
ALIPAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n沙箱应用私钥\n-----END PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n沙箱支付宝公钥\n-----END PUBLIC KEY-----"
ALIPAY_GATEWAY=https://openapi-sandbox.dl.alipaydev.com/gateway.do
ALIPAY_NOTIFY_URL=https://你的正式可访问测试域名/api/public/alipay/notify
ALIPAY_RETURN_URL=https://你的测试域名/ai/billing
ALIPAY_PERIODIC_ENABLED=false
```

不要把正式 APPID 与沙箱密钥混用，也不要把沙箱 seller_id 与正式 PID 混用。只把真实值写入服务器 `server/.env`，不要写进 `.env.example`。

## 七、正式环境变量映射

正式上线前，将同一正式应用、同一商家主体下取得的值写入 `server/.env`：

```env
SUBSCRIPTION_PURCHASES_ENABLED=false

ALIPAY_APP_ID=正式应用APPID
ALIPAY_SELLER_ID=正式商家PID
ALIPAY_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n正式应用私钥\n-----END PRIVATE KEY-----"
ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n正式支付宝公钥\n-----END PUBLIC KEY-----"
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do
ALIPAY_NOTIFY_URL=https://你的正式域名/api/public/alipay/notify
ALIPAY_RETURN_URL=https://你的正式域名/ai/billing

ALIPAY_PERIODIC_ENABLED=false
ALIPAY_PERIODIC_PRODUCT_CODE=
```

当前代码在 `server/providers/alipayAPI.js` 中读取这些变量，并通过 `server/server.js` 将支付通知挂载为 `POST /api/public/alipay/notify`。填写 `.env` 本身不会使当前运行进程自动获得新变量；但在完成全部代码和支付验收前，不应重启生产服务或打开功能开关。

## 八、自动续费：申请路径与当前阻塞项

支付宝在 2026-03-28 升级了 **商家扣款**，旧版商家扣款/周期扣款不再接受新场景。官方[新版商家扣款产品介绍](https://opendocs.alipay.com/open/0izsmy)列出的主要准入条件包括：

- 仅支持支付宝企业账号；
- 企业注册资本不少于 2000 万元人民币；
- 已开通支付宝收单产品，且近半年每月主动支付用户数不少于 300；
- 企业无相关经营风险；
- 单协议单笔扣款不超过 100 元，并受日/月限额、扣款时间和周期规则约束。

申请路径为：**支付宝商家平台 > 产品中心 > 商家扣款 > 立即开通**。审核通过后，按官方说明进入 **商家平台 > 产品大全 > 商家扣款 > 功能管理 > 修改 > 设置模板**，新增模板和场景码。完整接入准备见[商家扣款接入准备](https://opendocs.alipay.com/open/0izne4)。

官方[支付并签约接入](https://opendocs.alipay.com/open/0iztfw)明确说明：

- 新版商家扣款暂不支持沙箱；
- `product_code` 固定为 `GENERAL_WITHHOLDING`；
- 周期个人签约产品码为 `CYCLE_PAY_AUTH_P`；
- 必须传 `access_params` 和 `period_rule_params`，包括周期、周期类型和单次最大金额；
- PC 网页支付并签约使用 App 支付接口生成签约字符串，再生成二维码让支付宝 App 扫码，并非普通电脑网站支付页面直接附带自动续费。

当前 StarDraw 自动续费存在以下不匹配：

1. 只有一个 `ALIPAY_PERIODIC_PRODUCT_CODE`，却同时被用于签约个人产品码和后续扣款销售产品码；官方要求这是两个不同值。
2. `createPeriodicAgreement` 未传必需的 `access_params` 和 `period_rule_params`。
3. 当前固定场景码 `INDUSTRY|DIGITAL_CONTENT` 未与商家平台审核通过的模板场景码绑定。
4. 当前 PC 端使用独立 `alipay.user.agreement.page.sign`，与 2026 新版“支付并签约”的官方 PC 二维码流程不一致。
5. 新版商家扣款没有沙箱，必须在获得产品权限后以受控的小额正式订单验收。

因此，即使商家平台显示商家扣款审批通过，也必须保持：

```env
ALIPAY_PERIODIC_ENABLED=false
```

待代码按新版接口改造、增加独立产品码和周期规则、完成真实环境验收后，才能讨论开启自动续费。

## 九、当前上线前检查表

- [ ] StarDraw 应用类型为“网页/移动应用”，且为自研应用。
- [ ] APPID、应用私钥、支付宝公钥属于同一应用、同一环境。
- [ ] 控制台接口加签方式为“密钥 + RSA2”。
- [ ] PID 来自实际收款商家，APPID 已绑定该商家账号。
- [ ] 应用状态为“已上线”。
- [ ] 商家平台“电脑网站支付”状态为“已开通”。
- [ ] 正式网站可访问、已备案，主体资料与支付宝账号一致或已提交授权函。
- [ ] `notify_url` 公网 HTTPS 可达、不重定向，并能返回纯文本 `success`。
- [ ] 已完成正确签名、错误签名、金额不符、APPID/PID 不符和重复通知测试。
- [ ] 已补齐 `alipay.trade.query` 查询兜底并测试“付款成功但通知丢失”。
- [ ] 已应用迁移 035，并在独立 Worker 中启用支付查单补偿。
- [ ] 已完成数据库迁移、退款补偿和幂等验收。
- [ ] 自动续费仍为关闭状态。
- [ ] 所有真实密钥只在服务器 Secret/`.env`，未进入 Git、截图、工单或聊天记录。
- [ ] 上述项目全部通过后，才在维护窗口切换正式密钥、重启对应进程并打开 `SUBSCRIPTION_PURCHASES_ENABLED`。

## 官方来源索引

- [创建网页/移动应用](https://opendocs.alipay.com/open/009yp4)
- [电脑网站支付产品介绍](https://opendocs.alipay.com/open/00dn7j)
- [电脑网站支付接入准备](https://opendocs.alipay.com/open/01didh)
- [电脑网站支付快速接入](https://opendocs.alipay.com/open/00dn7k)
- [电脑网站支付异步通知](https://opendocs.alipay.com/open/00dn7l)
- [电脑网站支付沙箱调试](https://opendocs.alipay.com/open/00dn7o)
- [设置密钥加签方式](https://opendocs.alipay.com/common/02kdnc)
- [设置证书加签方式](https://opendocs.alipay.com/common/056zub)
- [查看密钥/证书](https://opendocs.alipay.com/common/057aqe)
- [查询 APPID](https://opendocs.alipay.com/common/0i24qo)
- [查询 PID](https://opendocs.alipay.com/common/0i23eu)
- [绑定应用](https://opendocs.alipay.com/open/0128wr)
- [上线应用](https://opendocs.alipay.com/open/009yp8)
- [开通产品](https://opendocs.alipay.com/open/009ypa)
- [应用网关说明](https://opendocs.alipay.com/common/02qibh)
- [支付宝沙箱环境](https://opendocs.alipay.com/common/02kkv7)
- [2026 新版商家扣款](https://opendocs.alipay.com/open/0izsmy)
- [商家扣款支付并签约](https://opendocs.alipay.com/open/0iztfw)
- [个人协议页面签约接口](https://opendocs.alipay.com/open/08bntw)
- [商家扣款常见问题](https://opendocs.alipay.com/open/0izne6)
