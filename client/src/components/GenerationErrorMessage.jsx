import { getGenerationErrorDetail, getGenerationErrorMessage } from "../utils/generationErrors";

const GenerationErrorMessage = ({ error, t, fallback }) => {
  const message = getGenerationErrorMessage(error, t, fallback);
  const detail = getGenerationErrorDetail(error);
  return <div>
    <p>{message}</p>
    {detail && detail !== message && <details className="mt-2 text-xs">
      <summary className="cursor-pointer">{t("查看错误详情", "View error details")}</summary>
      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px]">{detail}</pre>
    </details>}
  </div>;
};

export default GenerationErrorMessage;
