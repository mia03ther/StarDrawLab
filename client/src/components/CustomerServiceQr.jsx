import { useEffect, useState } from "react";
import { Headphones, Maximize2, QrCode, X } from "lucide-react";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const CONTACTS = [
  {
    id: "wechat",
    title: "微信客服",
    titleEn: "WeChat support",
    description: "扫码添加客服微信",
    descriptionEn: "Scan to add WeChat support",
    sources: [
      "https://i.ibb.co/v4f99jnf/cf6808fab787c796aed1799a4d06a8cf-720.png",
      "https://i.ibb.co/s9c77VYc/cf6808fab787c796aed1799a4d06a8cf-720.png",
    ],
  },
  {
    id: "qq-group",
    title: "QQ 群",
    titleEn: "QQ group",
    description: "扫码加入官方 QQ 群",
    descriptionEn: "Scan to join the official QQ group",
    sources: [
      "https://i.ibb.co/JWFfz6hP/1e1e84317729d1493303a7d636a2fbe3-720.jpg",
      "https://i.ibb.co/xK8pM94Q/1e1e84317729d1493303a7d636a2fbe3-720.jpg",
    ],
  },
];

const CustomerServiceQr = () => {
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [open, setOpen] = useState(false);
  const [previewContactId, setPreviewContactId] = useState(null);
  const [sourceIndexes, setSourceIndexes] = useState({});
  const [unavailableContacts, setUnavailableContacts] = useState({});
  const previewContact = CONTACTS.find((contact) => contact.id === previewContactId) || null;

  useEffect(() => {
    const openSupport = () => setOpen(true);
    window.addEventListener("stardraw:open-custom-contact", openSupport);
    return () => window.removeEventListener("stardraw:open-custom-contact", openSupport);
  }, []);

  useEffect(() => {
    if (!previewContactId) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") setPreviewContactId(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewContactId]);

  const handleImageError = (contact) => {
    const currentIndex = sourceIndexes[contact.id] || 0;
    if (currentIndex < contact.sources.length - 1) {
      setSourceIndexes((current) => ({ ...current, [contact.id]: currentIndex + 1 }));
      return;
    }
    setUnavailableContacts((current) => ({ ...current, [contact.id]: true }));
  };

  return (
    <>
      <div className="fixed bottom-5 right-5 z-[80] sm:bottom-6 sm:right-6">
        {open && (
          <section
            role="dialog"
            aria-label={t("联系客服", "Contact support")}
            className="absolute bottom-full right-0 mb-3 w-[min(450px,calc(100vw-2rem))] overflow-hidden rounded-3xl p-4"
            style={{
              background: `color-mix(in srgb, ${ui.surface} 92%, transparent)`,
              border: `1px solid ${ui.lineStrong}`,
              boxShadow: "0 24px 70px rgba(0, 0, 0, .28), 0 8px 24px rgba(0, 0, 0, .12)",
              backdropFilter: "blur(24px)",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-2xl"
                  style={{ background: ui.primarySoft, color: ui.primary }}
                >
                  <QrCode size={18} />
                </span>
                <div>
                  <h2 className="text-sm font-black" style={{ color: ui.text }}>
                    {t("联系客服", "Contact support")}
                  </h2>
                  <p className="mt-0.5 text-[11px]" style={{ color: ui.faint }}>
                    {t("选择微信客服或 QQ 群", "Choose WeChat support or the QQ group")}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title={t("关闭客服卡片", "Close support card")}
                aria-label={t("关闭客服卡片", "Close support card")}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105"
                style={{ background: ui.surfaceAlt, color: ui.muted }}
              >
                <X size={15} />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              {CONTACTS.map((contact) => {
                const unavailable = unavailableContacts[contact.id];
                const sourceIndex = sourceIndexes[contact.id] || 0;
                const contactTitle = t(contact.title, contact.titleEn);
                const contactDescription = t(contact.description, contact.descriptionEn);

                return (
                  <div key={contact.id} className="min-w-0 rounded-2xl p-2.5" style={{ background: "#fff" }}>
                    <p className="mb-0.5 truncate text-center text-xs font-black" style={{ color: "#161616" }}>{contactTitle}</p>
                    <p className="mb-2 min-h-8 text-center text-[10px] leading-4" style={{ color: "#676767" }}>{contactDescription}</p>
                    {unavailable ? (
                      <div className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 rounded-xl px-3 text-center" style={{ background: "#f6f6f6" }}>
                        <QrCode size={28} style={{ color: "#8a8a8a" }} />
                        <p className="text-[11px] font-semibold" style={{ color: "#676767" }}>
                          {t("二维码暂时无法加载", "QR code unavailable")}
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="group relative block w-full overflow-hidden rounded-xl focus:outline-none focus:ring-2"
                        style={{ outlineColor: ui.primary }}
                        onClick={() => setPreviewContactId(contact.id)}
                        title={t(`放大${contact.title}二维码`, `Enlarge ${contact.titleEn} QR code`)}
                        aria-label={t(`放大${contact.title}二维码`, `Enlarge ${contact.titleEn} QR code`)}
                      >
                        <img
                          src={contact.sources[sourceIndex]}
                          alt={t(`${contact.title}二维码`, `${contact.titleEn} QR code`)}
                          referrerPolicy="no-referrer"
                          onError={() => handleImageError(contact)}
                          className="block aspect-[3/4] w-full object-cover transition-transform duration-200 group-hover:scale-[1.025]"
                        />
                        <span className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-center gap-1 rounded-lg bg-black/65 px-2 py-1.5 text-[10px] font-bold text-white opacity-0 transition-opacity group-hover:opacity-100">
                          <Maximize2 size={12} />
                          {t("点击放大", "Enlarge")}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-center text-[11px] leading-5" style={{ color: ui.faint }}>
              {t("遇到生成、支付或账号问题，可添加微信客服或加入 QQ 群。", "For generation, payment, or account help, add WeChat support or join the QQ group.")}
            </p>
          </section>
        )}

        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-label={t("联系客服", "Contact support")}
          title={t("联系客服", "Contact support")}
          className="flex h-12 items-center gap-2 rounded-full px-4 text-sm font-black transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl"
          style={{
            background: ui.buttonGradient,
            color: ui.primaryText,
            boxShadow: `0 12px 30px ${ui.primarySoft}`,
          }}
        >
          {open ? <X size={18} /> : <Headphones size={18} />}
          <span className="hidden sm:inline">{open ? t("关闭", "Close") : t("联系客服", "Support")}</span>
        </button>
      </div>

      {previewContact && !unavailableContacts[previewContact.id] && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t(`${previewContact.title}二维码预览`, `${previewContact.titleEn} QR code preview`)}
          className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md sm:p-8"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreviewContactId(null);
          }}
        >
          <div className="relative max-h-full max-w-full rounded-3xl bg-white p-3 shadow-2xl sm:p-5">
            <img
              src={previewContact.sources[sourceIndexes[previewContact.id] || 0]}
              alt={t(`${previewContact.title}二维码`, `${previewContact.titleEn} QR code`)}
              referrerPolicy="no-referrer"
              onError={() => handleImageError(previewContact)}
              className="max-h-[calc(100vh-5rem)] max-w-[calc(100vw-2rem)] rounded-2xl object-contain sm:max-h-[calc(100vh-6rem)] sm:max-w-[min(78vw,520px)]"
            />
            <button
              type="button"
              onClick={() => setPreviewContactId(null)}
              title={t("关闭预览", "Close preview")}
              aria-label={t("关闭二维码预览", "Close QR code preview")}
              className="absolute -right-2 -top-2 flex h-9 w-9 items-center justify-center rounded-full shadow-lg"
              style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.line}` }}
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default CustomerServiceQr;
