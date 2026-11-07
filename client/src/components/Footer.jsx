import { assets } from "../assets/assets";

const Footer = () => {
  return (
    <footer className="mt-24 w-full px-6 pt-12 text-slate-400 md:px-16 lg:px-24 xl:px-32">
      <div className="flex flex-col gap-10 border-b border-white/10 pb-10 md:flex-row md:justify-between">
        <div className="md:max-w-96">
          <div className="inline-flex rounded-md bg-white/90 px-2 py-1">
            <img className="h-8" src={assets.logo} alt="logo" />
          </div>
          <p className="mt-5 text-sm leading-6">
            面向电商与营销场景的 AI 资产生成平台。快速生成商品主图与推广视频，
            一键导出可直接用于投放的素材。
          </p>
          {/* 商务联系 */}
          <div className="mt-6 space-y-2 text-sm">
            <p className="font-semibold text-slate-300">商务合作 / 定制需求</p>
            <p>
              邮件：{" "}
              <a href="mailto:business@quickai.example.com" className="hover:text-slate-200 underline-offset-2 hover:underline">
                business@quickai.example.com
              </a>
            </p>
            <p>
              Telegram：{" "}
              <a href="https://t.me/quickai_support" target="_blank" rel="noreferrer" className="hover:text-slate-200 underline-offset-2 hover:underline">
                @quickai_support
              </a>
            </p>
          </div>
        </div>

        <div className="flex flex-1 items-start gap-14 md:justify-end">
          <div>
            <h2 className="mb-5 text-sm font-semibold text-slate-200">产品</h2>
            <ul className="space-y-2 text-sm">
              <li><a className="hover:text-slate-200" href="/">首页</a></li>
              <li><a className="hover:text-slate-200" href="/ai">工作台</a></li>
              <li><a className="hover:text-slate-200" href="/ai/billing">积分充值</a></li>
            </ul>
          </div>
          <div>
            <h2 className="mb-5 text-sm font-semibold text-slate-200">支持</h2>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  className="hover:text-slate-200"
                  href="https://t.me/quickai_support"
                  target="_blank"
                  rel="noreferrer"
                >
                  联系我们
                </a>
              </li>
              <li><a className="hover:text-slate-200" href="#">隐私政策</a></li>
              <li><a className="hover:text-slate-200" href="#">服务条款</a></li>
            </ul>
          </div>
        </div>
      </div>

      <p className="pb-8 pt-6 text-center text-xs md:text-sm">
        Copyright 2026 © QuickAI MVP · 生成记录保留 30 天
      </p>
    </footer>
  );
};

export default Footer;
