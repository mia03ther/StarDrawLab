// Retry hints only control timing; they never turn authorization or cancellation
// failures into transient errors.
export const agentRetryDelayMs = (value) => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const milliseconds = Number(value);
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.min(60_000, milliseconds)
    : null;
};

export const isAgentRequestCancelled = (error) => (
  error?.name === "AbortError"
  || error?.code === "ABORT_ERR"
  || error?.code === "ERR_CANCELED"
  || error?.cause?.name === "AbortError"
);

export const isRetryableAgentError = (error) => {
  if (isAgentRequestCancelled(error)) return false;
  const status = Number(error?.status);
  if (status >= 400 && status < 500) return status === 429;
  return (status >= 500 && status < 600) || agentRetryDelayMs(error?.retryAfterMs) !== null;
};
