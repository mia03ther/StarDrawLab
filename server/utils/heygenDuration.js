export const applyHeyGenDurationDirective = (prompt, requestedSeconds) => {
  const normalizedPrompt = String(prompt || "").trim();
  if (requestedSeconds === undefined || requestedSeconds === null || requestedSeconds === "") {
    return normalizedPrompt;
  }

  const seconds = Number(requestedSeconds);
  if (!Number.isSafeInteger(seconds) || seconds < 15 || seconds > 180) {
    throw Object.assign(new Error("HeyGen duration must be an integer between 15 and 180 seconds"), {
      status: 400,
      code: "INVALID_VIDEO_DURATION",
    });
  }

  const directive = `Target duration: ${seconds} seconds. Do not exceed this duration.`;
  return normalizedPrompt.includes(directive)
    ? normalizedPrompt
    : `${normalizedPrompt}\n\n${directive}`.trim();
};

