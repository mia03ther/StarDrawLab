const ACTIVE_STATUSES = new Set(["estimating", "creating", "starting", "queued", "pending", "running", "loading"]);

export const hasWorkflowApprovalWait = (nodes) => (
  (Array.isArray(nodes) ? nodes : []).some((node) => node?.status === "waiting_approval")
);

export const isWorkflowRunBusy = (status, nodes) => (
  ACTIVE_STATUSES.has(String(status || "").toLowerCase())
  || (String(status || "").toLowerCase() === "paused" && hasWorkflowApprovalWait(nodes))
);

export const shouldUnlockWorkflowRun = (status, nodes) => {
  const normalized = String(status || "").toLowerCase();
  return ["completed", "failed", "cancelled"].includes(normalized)
    || (normalized === "paused" && !hasWorkflowApprovalWait(nodes));
};
