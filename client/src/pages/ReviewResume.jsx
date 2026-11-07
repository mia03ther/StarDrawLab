import { useState } from "react";
import { FileText, Sparkles } from "lucide-react";
import axios from "axios";
import toast from "react-hot-toast";
import Markdown from "react-markdown";
import { useLanguage } from "../contexts/LanguageContext";

axios.defaults.baseURL = import.meta.env.VITE_BASE_URL;

const ReviewResume = () => {
  const { isZh, t } = useLanguage();
  const [_input, setInput] = useState("");

  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState("");

  const onSubmitHandler = async (e) => {
    e.preventDefault();

    try {
      setLoading(true);

      // Mocking for demo
      setTimeout(() => {
        setContent(isZh ? "### 简历评审\n\n**优势：**\n- 格式清晰\n- 经历表达明确\n\n**不足：**\n- 缺少可量化成果\n\n**建议：**\n- 在项目要点中补充更多数据。" : "### Resume Review\n\n**Strengths:**\n- Good formatting\n- Clear experience\n\n**Weaknesses:**\n- Lacks quantifiable achievements\n\n**Suggestions:**\n- Add more numbers to your bullet points.");
        setLoading(false);
        toast.success(t("演示生成成功！", "Demo generation successful!"));
      }, 1500);

    } catch (error) {
      toast.error(error.message);
      setLoading(false);
    }
  };

  return (
    <div className="h-full overflow-y-scroll p-6 flex items-start flex-wrap gap-4 text-slate-700">
      {/* Left col */}
      <form
        onSubmit={onSubmitHandler}
        className="w-full max-w-lg p-4 bg-white rounded-lg border border-gray-200"
      >
        <div className="flex items-center gap-3">
          <Sparkles className="w-6 text-[#00DA83]" />
          <h1 className="text-xl font-semibold">{t("简历评审", "Resume Review")}</h1>
        </div>
        <p className="mt-6 text-sm font-medium">{t("上传简历", "Upload Resume")}</p>

        <input
          onChange={(e) => setInput(e.target.files[0])}
          type="file"
          accept="application/pdf"
          className="w-full p-2 px-3 mt-2 outline-none text-sm rounded-md border border-gray-300 text-gray-600"
          required
        />

        <p className="text-xs text-gray-500 font-light mt-1">
          {t("仅支持 PDF 格式的简历。", "Supports PDF resume only.")}
        </p>

        <button
          disabled={loading}
          className="w-full flex justify-center items-center gap-2 bg-gradient-to-r from-[#00DA83] to-[#009BB3] text-white px-4 py-2 mt-6 text-sm rounded-lg cursor-pointer"
        >
          {loading ? (
            <span className="w-4 h-4 my-1 rounded-full border-2 border-t-transparent animate-spin"></span>
          ) : (
            <FileText className="w-5" />
          )}
          {t("评审简历", "Review Resume")}
        </button>
      </form>

      {/* Right col */}
      <div className="w-full max-w-lg p-4 bg-white rounded-lg flex flex-col border border-gray-200 min-h-96 max-h-[600px]">
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-[#00DA83]" />
          <h1 className="text-xl font-semibold">{t("分析结果", "Analysis Results")}</h1>
        </div>

        {!content ? (
          <div className="flex-1 flex justify-center items-center">
            <div className="text-sm flex flex-col items-center gap-5 text-gray-400">
              <FileText className="w-9 h-9" />
              <p>{t("上传简历，然后点击“评审简历”开始", "Upload a resume and click \"Review Resume\" to get started")}</p>
            </div>
          </div>
        ) : (
          <div className="mt-3 h-full overflow-y-scroll text-sm text-slate-600">
            <div className="reset-tw">
              <Markdown>{content}</Markdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReviewResume;
