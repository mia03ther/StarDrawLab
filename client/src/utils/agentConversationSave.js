// A successful save acknowledges a snapshot that may already be older than
// the editor. It must not act like an explicit conversation-open operation.
export const mergeAgentConversationSaveAcknowledgment = (current, saved) => {
  if (!current?.id || !saved?.id || current.id !== saved.id) return current;
  return { ...saved, runtime_state: current.runtime_state };
};
