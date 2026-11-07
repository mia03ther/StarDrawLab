const clean = (value, max = 160) => String(value || "").trim().slice(0, max);

export const toCanvasAgentReference = (element) => {
  if (!element || (element.type && element.type !== "image")) return null;
  const elementId = clean(element.elementId || element.id, 80);
  if (!elementId) return null;
  const previewUrl = clean(
    element.previewUrl
      || element.src
      || element.content
      || element.url
      || element.preview_image_url
      || element.thumbnail_url
      || element.reference_preview_url
      || element.poster,
    2_048,
  );
  if (!previewUrl) return null;
  return {
    elementId,
    title: clean(element.title, 120) || "Reference image",
    previewUrl,
  };
};

export const mergeCanvasAgentReferences = (current, selected, limit = 4) => {
  const byId = new Map();
  [...(Array.isArray(current) ? current : []), ...(Array.isArray(selected) ? selected : [])]
    .map(toCanvasAgentReference)
    .filter(Boolean)
    .forEach((reference) => byId.set(reference.elementId, reference));
  return [...byId.values()].slice(0, Math.max(1, Number(limit) || 4));
};

export const serializeCanvasAgentReferences = (references) => (
  (Array.isArray(references) ? references : [])
    .map(toCanvasAgentReference)
    .filter(Boolean)
    .slice(0, 4)
    .map(({ elementId, title }) => ({ elementId, title }))
);
