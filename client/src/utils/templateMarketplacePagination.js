const templateKey = (template = {}) => String(template.id || template.scene_key || "").trim();

export const mergeTemplatePages = (current = [], incoming = []) => {
  const merged = new Map();
  for (const template of [...current, ...incoming]) {
    const key = templateKey(template);
    if (key) merged.set(key, template);
  }
  return [...merged.values()];
};

export const shouldShowInitialTemplateLoading = ({ loading, itemCount }) => (
  Boolean(loading) && Number(itemCount || 0) === 0
);
