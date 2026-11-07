// All image/video template generations use the same server-owned price.
// Freeform scenes and non-media operations keep their configured pricing.
export const TEMPLATE_GENERATION_POINTS = 18;

export const isFixedPriceTemplate = ({ outputType, sceneKey } = {}) => {
  const type = String(outputType || "").trim().toLowerCase();
  const scene = String(sceneKey || "").trim().toLowerCase();
  return ["image", "video"].includes(type) && Boolean(scene) && scene !== `freeform_${type}`;
};

export const getTemplatePriceFields = (template) => isFixedPriceTemplate({
  outputType: template?.output_type ?? template?.outputType,
  sceneKey: template?.scene_key ?? template?.sceneKey,
}) ? {
  points_cost: TEMPLATE_GENERATION_POINTS,
  charge_points_cost: TEMPLATE_GENERATION_POINTS,
  estimated_points: TEMPLATE_GENERATION_POINTS,
  billing_type: "fixed",
  points_per_minute: null,
  price_locked: true,
} : {};
