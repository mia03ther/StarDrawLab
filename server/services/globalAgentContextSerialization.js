const MAX_TEMPLATE_DESCRIPTION = 220;
const MAX_TEMPLATE_TAGS = 8;

export const MAX_GLOBAL_AGENT_CONTEXT_CHARS = 24_000;

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

const compactTemplate = (template) => {
  if (!template || typeof template !== "object" || Array.isArray(template)) return null;
  return {
    id: clean(template.id, 255),
    scene_key: clean(template.scene_key, 255),
    scene_name: clean(template.scene_name, 160),
    output_type: template.output_type === "video" ? "video" : "image",
    preview_title: clean(template.preview_title, 160),
    preview_description: clean(template.preview_description, MAX_TEMPLATE_DESCRIPTION),
    tags: Array.isArray(template.tags)
      ? template.tags.map((tag) => clean(tag, 80)).filter(Boolean).slice(0, MAX_TEMPLATE_TAGS)
      : [],
    requires_reference: Boolean(template.requires_reference),
    is_featured: Boolean(template.is_featured),
    default_model: clean(template.default_model, 120),
    default_seconds: template.default_seconds == null ? null : Number(template.default_seconds),
    default_size: clean(template.default_size, 80),
    required_membership_tier: clean(template.required_membership_tier || "free", 40),
    version: Number(template.version || 1),
    source_key: clean(template.source_key, 120) || null,
    category: clean(template.category, 120) || null,
  };
};

const compactTemplates = (templates) => (Array.isArray(templates) ? templates : [])
  .map(compactTemplate)
  .filter((template) => template?.id && template.scene_key);

const compactCurrentCanvas = (canvas) => {
  if (!canvas || typeof canvas !== "object" || Array.isArray(canvas)) return null;
  const id = clean(canvas.id, 255);
  if (!id) return null;
  return {
    id,
    title: clean(canvas.title, 120),
    updatedAt: clean(canvas.updatedAt, 64),
    workflowNodeCount: Math.max(0, Number(canvas.workflowNodeCount || 0) || 0),
  };
};

const compactAgentPreferences = (preferences) => {
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return {};
  return {
    agentModel: clean(preferences.agentModel, 100),
    imageModel: clean(preferences.imageModel, 100),
    videoModel: clean(preferences.videoModel, 100),
    imageSize: clean(preferences.imageSize, 40),
    videoSize: clean(preferences.videoSize, 40),
    videoSeconds: preferences.videoSeconds == null ? null : Number(preferences.videoSeconds),
    reasoningEffort: clean(preferences.reasoningEffort, 20),
  };
};

const compactAttachedReferenceImages = (references) => (Array.isArray(references) ? references : [])
  .slice(0, 4)
  .map((reference) => ({
    type: "image",
    title: clean(reference?.title, 160) || "参考图",
    source: ["upload", "creation", "template", "attached"].includes(reference?.source)
      ? reference.source
      : "attached",
  }));

const compactObservations = (observations) => (Array.isArray(observations) ? observations : [])
  .slice(-12)
  .map((observation) => {
    const compact = {
      stepId: clean(observation?.stepId || observation?.id, 80),
      callId: clean(observation?.callId, 80),
      toolKey: clean(observation?.toolKey, 128),
      status: clean(observation?.status, 40),
      result: observation?.result ?? null,
    };
    let serialized = JSON.stringify(compact.result);
    if (serialized.length > 8_000) compact.result = { truncated: true, summary: clean(serialized, 1_000) };
    return compact;
  })
  .filter((observation) => observation.stepId || observation.callId || observation.toolKey);

const buildContext = (context, imageTemplates, videoTemplates) => ({
  source: ["global_agent", "template_detail"].includes(context?.source) ? context.source : "global_agent",
  currentPath: clean(context?.currentPath, 500),
  currentCanvas: compactCurrentCanvas(context?.currentCanvas),
  attachedReferenceImages: compactAttachedReferenceImages(context?.attachedReferenceImages),
  agentPreferences: compactAgentPreferences(context?.agentPreferences),
  reactive: Boolean(context?.reactive),
  requestedTemplate: compactTemplate(context?.requestedTemplate),
  templates: {
    availableImages: imageTemplates,
    availableVideos: videoTemplates,
  },
  observations: compactObservations(context?.observations),
  membershipTier: clean(context?.membershipTier || "free", 40),
});

/**
 * Keep the provider context structurally valid while bounding prompt size.
 * Never truncate a serialized JSON string: doing so can cut through a quoted
 * template prompt and make the subsequent JSON.parse fail.
 */
export const serializeGlobalAgentContext = (
  context = {},
  maxChars = MAX_GLOBAL_AGENT_CONTEXT_CHARS,
) => {
  const imageTemplates = compactTemplates(context?.templates?.availableImages);
  const videoTemplates = compactTemplates(context?.templates?.availableVideos);
  let imageCount = imageTemplates.length;
  let videoCount = videoTemplates.length;
  let serialized = "";

  while (true) {
    const boundedContext = buildContext(
      context,
      imageTemplates.slice(0, imageCount),
      videoTemplates.slice(0, videoCount),
    );
    serialized = JSON.stringify(boundedContext);
    if (serialized.length <= maxChars || (imageCount === 0 && videoCount === 0)) return serialized;

    if (imageCount >= videoCount && imageCount > 0) imageCount -= 1;
    else if (videoCount > 0) videoCount -= 1;
    else break;
  }

  return serialized;
};
