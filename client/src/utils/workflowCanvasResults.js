const MEDIA_NODE_TYPES = new Set(["image.generate", "video.generate"]);
const GENERATED_MEDIA_SOURCES = new Set(["canvas_agent_generation", "workflow_generation"]);

const stringId = (value) => String(value ?? "").trim();

export const mergeGeneratedCanvasMediaFromServer = ({ localElements, serverElements }) => {
  const local = Array.isArray(localElements) ? localElements : [];
  const server = Array.isArray(serverElements) ? serverElements : [];
  const additions = server.filter((element) => {
    if (!GENERATED_MEDIA_SOURCES.has(stringId(element?.source).toLowerCase())) return false;
    const id = stringId(element?.id);
    const creationId = stringId(element?.creationId || element?.creation_id);
    return !local.some((candidate) => (
      (id && stringId(candidate?.id) === id)
      || (creationId && stringId(candidate?.creationId || candidate?.creation_id) === creationId)
    ));
  });
  return {
    changed: additions.length > 0,
    elements: additions.length ? [...local, ...additions] : local,
  };
};

const canvasStateFromResult = (result) => (
  result?.revision?.canvasState
  || result?.revision?.canvas_state
  || result?.canvasState
  || result?.canvas_state
  || null
);

export const collectWorkflowCanvasMediaResults = (nodes) => (
  (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
    const result = node?.result;
    const type = stringId(node?.nodeType || node?.node_type).toLowerCase();
    const elementId = stringId(result?.canvasElementId || result?.canvas_element_id);
    const creationId = stringId(result?.creationId || result?.creation_id);
    if (node?.status !== "completed" || !MEDIA_NODE_TYPES.has(type) || !elementId) return [];

    const elements = canvasStateFromResult(result)?.elements;
    if (!Array.isArray(elements)) return [];
    const element = elements.find((candidate) => (
      stringId(candidate?.id) === elementId
      || (creationId && stringId(candidate?.creationId || candidate?.creation_id) === creationId)
    ));
    if (!element || !["image", "video"].includes(stringId(element.type).toLowerCase())) return [];

    return [{
      key: elementId,
      nodeKey: stringId(node?.nodeKey || node?.node_key),
      creationId: creationId || stringId(element.creationId || element.creation_id),
      element,
    }];
  })
);

const isFinitePoint = (value) => Number.isFinite(Number(value?.x)) && Number.isFinite(Number(value?.y));

const overlaps = (first, second, gap = 0) => (
  first.x < second.x + second.width + gap
  && first.x + first.width + gap > second.x
  && first.y < second.y + second.height + gap
  && first.y + first.height + gap > second.y
);

export const placeWorkflowCanvasMediaElement = ({
  element,
  elements,
  anchor,
  nodeKey,
  viewport,
  boardSize,
  ordinal = 0,
}) => {
  if (!element || typeof element !== "object") return null;
  const scale = Math.max(0.05, Number(viewport?.scale) || 1);
  const boardWidth = Math.max(320, Number(boardSize?.width) || 1280);
  const boardHeight = Math.max(240, Number(boardSize?.height) || 720);
  const width = Math.max(1, Number(element.width) || (element.type === "video" ? 380 : 320));
  const height = Math.max(1, Number(element.height) || (element.type === "video" ? 214 : 320));
  const normalizedNodeKey = stringId(nodeKey || element.workflowNodeKey || element.workflow_node_key);
  let x;
  let y;
  if (isFinitePoint(anchor)) {
    const anchorWidth = Math.max(1, Number(anchor.width) || 228);
    const anchorHeight = Math.max(1, Number(anchor.height) || 112);
    x = Number(anchor.x) + (anchorWidth - width) / 2;
    y = Number(anchor.y) + anchorHeight + 40;

    const safeNodeKey = normalizedNodeKey.replace(/[^A-Za-z0-9._:-]/g, "_");
    const related = (Array.isArray(elements) ? elements : []).filter((candidate) => (
      stringId(candidate?.workflowNodeKey || candidate?.workflow_node_key) === normalizedNodeKey
      || (safeNodeKey && stringId(candidate?.id).startsWith(`workflow_${safeNodeKey}_`))
    ));
    let candidate = { x, y, width, height };
    related.sort((first, second) => Number(first?.y || 0) - Number(second?.y || 0)).forEach((existing) => {
      const existingBounds = {
        x: Number(existing?.x) || 0,
        y: Number(existing?.y) || 0,
        width: Math.max(1, Number(existing?.width) || width),
        height: Math.max(1, Number(existing?.height) || height),
      };
      if (!overlaps(candidate, existingBounds, 24)) return;
      candidate = { ...candidate, y: existingBounds.y + existingBounds.height + 24 };
    });
    y = candidate.y;
  } else {
    const offset = Math.max(0, Number(ordinal) || 0) % 4;
    const centerX = (boardWidth / 2 - (Number(viewport?.x) || 0)) / scale;
    const centerY = (boardHeight / 2 - (Number(viewport?.y) || 0)) / scale;
    x = centerX - width / 2 + offset * 28;
    y = centerY - height / 2 + offset * 28;
  }

  return {
    ...element,
    creationId: stringId(element.creationId || element.creation_id),
    workflowNodeKey: normalizedNodeKey,
    x: Math.round(x),
    y: Math.round(y),
    width,
    height,
  };
};

export const mergeWorkflowCanvasMediaElement = ({
  elements,
  element,
  anchor,
  nodeKey,
  viewport,
  boardSize,
  ordinal = 0,
}) => {
  const current = Array.isArray(elements) ? elements : [];
  const incomingId = stringId(element?.id);
  const incomingCreationId = stringId(element?.creationId || element?.creation_id);
  const existing = current.find((candidate) => (
    (incomingId && stringId(candidate?.id) === incomingId)
    || (incomingCreationId && stringId(candidate?.creationId || candidate?.creation_id) === incomingCreationId)
  ));
  if (existing) return { inserted: false, element: existing, elements: current };

  const placed = placeWorkflowCanvasMediaElement({ element, elements: current, anchor, nodeKey, viewport, boardSize, ordinal });
  if (!placed || !incomingId) return { inserted: false, element: null, elements: current };
  return { inserted: true, element: placed, elements: [...current, placed] };
};
