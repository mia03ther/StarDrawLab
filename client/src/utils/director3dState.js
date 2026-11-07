const DEFAULT_CAMERA = Object.freeze({
  position: Object.freeze({ x: 6, y: 3.5, z: 8 }),
  rotation: Object.freeze({ x: -18, y: 37, z: 0 }),
  focalLength: 50,
});

export const DEFAULT_DIRECTOR_STATE = Object.freeze({
  enabled: false,
  scene: "person",
  camera: DEFAULT_CAMERA,
  lighting: "studio|i=1.2|k=5600",
  environment: "day|bg=%23111822",
});

export const clampDirectorNumber = (value, min, max, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

export const roundDirectorNumber = (value, precision = 2) => (
  Number(Number(value).toFixed(precision))
);

export const parseDirectorPackedValue = (value, fallbackName) => {
  const [rawName, ...rawParameters] = String(value || "").split("|");
  const parameters = {};
  rawParameters.forEach((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0) return;
    const key = entry.slice(0, separator);
    try {
      parameters[key] = decodeURIComponent(entry.slice(separator + 1));
    } catch {
      parameters[key] = entry.slice(separator + 1);
    }
  });
  return { name: rawName || fallbackName, parameters };
};

export const packDirectorLighting = ({ preset, intensity, temperature }) => (
  `${preset}|i=${roundDirectorNumber(intensity, 2)}|k=${Math.round(temperature)}`
);

export const packDirectorEnvironment = ({ time, background }) => (
  `${time}|bg=${encodeURIComponent(background)}`
);

const normalizeVector = (candidate, fallback, min = -1000, max = 1000) => ({
  x: clampDirectorNumber(candidate?.x, min, max, fallback.x),
  y: clampDirectorNumber(candidate?.y, min, max, fallback.y),
  z: clampDirectorNumber(candidate?.z, min, max, fallback.z),
});

export const normalizeDirectorCamera = (candidate, fallback = DEFAULT_CAMERA) => {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  return {
    ...source,
    position: normalizeVector(source.position, fallback.position),
    rotation: normalizeVector(source.rotation, fallback.rotation, -3600, 3600),
    focalLength: clampDirectorNumber(
      source.focalLength ?? source.focal_length,
      12,
      200,
      fallback.focalLength,
    ),
  };
};

const normalizeTransform = (candidate) => {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  return {
    position: normalizeVector(source.position, { x: 0, y: 0, z: 0 }),
    rotation: normalizeVector(source.rotation, { x: 0, y: 0, z: 0 }, -3600, 3600),
    scale: normalizeVector(source.scale, { x: 1, y: 1, z: 1 }, 0.01, 100),
  };
};

const normalizeObject = (candidate, index) => {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  const sourceInfo = source.source && typeof source.source === "object" ? source.source : {};
  const type = sourceInfo.type === "local" ? "local" : "placeholder";
  const kind = String(sourceInfo.kind || source.kind || "person").slice(0, 40);
  const fileName = String(sourceInfo.fileName || source.fileName || "").slice(0, 240);
  return {
    ...source,
    id: String(source.id || `director-object-${index + 1}`).slice(0, 120),
    name: String(source.name || fileName || `Object ${index + 1}`).slice(0, 120),
    source: type === "local"
      ? {
        type,
        fileName,
        mimeType: String(sourceInfo.mimeType || "").slice(0, 120),
        localOnly: true,
      }
      : { type, kind },
    transform: normalizeTransform(source.transform),
  };
};

const normalizeKeyframe = (candidate, index, fallbackCamera) => {
  const source = candidate && typeof candidate === "object" ? candidate : {};
  return {
    ...source,
    id: String(source.id || `camera-keyframe-${index + 1}`).slice(0, 120),
    name: String(source.name || `Shot ${index + 1}`).slice(0, 120),
    time: clampDirectorNumber(source.time, 0, 3600, index),
    camera: normalizeDirectorCamera(source.camera, fallbackCamera),
  };
};

export const normalizeDirectorState = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const cameraSource = source.camera && typeof source.camera === "object" ? source.camera : {};
  const hasCameraPosition = cameraSource.position && typeof cameraSource.position === "object";
  const rawCamera = normalizeDirectorCamera(cameraSource);
  const isLegacyEmptyCamera = hasCameraPosition
    && rawCamera.position.x === 0
    && rawCamera.position.y === 0
    && rawCamera.position.z === 0;
  const camera = isLegacyEmptyCamera ? normalizeDirectorCamera(DEFAULT_CAMERA) : rawCamera;
  const packedLighting = parseDirectorPackedValue(source.lighting, "studio");
  const packedEnvironment = parseDirectorPackedValue(source.environment, "day");
  const lightingSource = source.lighting && typeof source.lighting === "object"
    ? source.lighting
    : {
      preset: packedLighting.name,
      intensity: packedLighting.parameters.i,
      temperature: packedLighting.parameters.k,
    };
  const environmentSource = source.environment && typeof source.environment === "object"
    ? source.environment
    : {
      time: packedEnvironment.name,
      background: packedEnvironment.parameters.bg,
    };
  const scene = String(source.scene || DEFAULT_DIRECTOR_STATE.scene).slice(0, 120);
  const hasObjectArray = Array.isArray(source.objects);
  const objects = hasObjectArray
    ? source.objects.map(normalizeObject)
    : (scene === "none" ? [] : [normalizeObject({
      id: "default-subject",
      name: "Default subject",
      source: { type: "placeholder", kind: scene },
    }, 0)]);
  const cameraKeyframes = (Array.isArray(source.cameraKeyframes) ? source.cameraKeyframes : [])
    .map((keyframe, index) => normalizeKeyframe(keyframe, index, camera))
    .sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));

  return {
    ...source,
    enabled: Boolean(source.enabled),
    scene,
    camera,
    objects,
    cameraKeyframes,
    lighting: {
      preset: String(lightingSource.preset || "studio").slice(0, 80),
      intensity: clampDirectorNumber(lightingSource.intensity, 0.1, 5, 1.2),
      temperature: clampDirectorNumber(lightingSource.temperature, 2000, 10000, 5600),
    },
    environment: {
      time: String(environmentSource.time || "day").slice(0, 80),
      background: /^#[0-9a-f]{6}$/i.test(environmentSource.background || "")
        ? environmentSource.background
        : "#111822",
    },
  };
};

const interpolateAngle = (from, to, amount) => {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return from + delta * amount;
};

const interpolateVector = (from, to, amount, angle = false) => ({
  x: angle ? interpolateAngle(from.x, to.x, amount) : from.x + (to.x - from.x) * amount,
  y: angle ? interpolateAngle(from.y, to.y, amount) : from.y + (to.y - from.y) * amount,
  z: angle ? interpolateAngle(from.z, to.z, amount) : from.z + (to.z - from.z) * amount,
});

export const interpolateDirectorCamera = (keyframes, time, fallbackCamera = DEFAULT_CAMERA) => {
  const normalizedFrames = (Array.isArray(keyframes) ? keyframes : [])
    .map((keyframe, index) => normalizeKeyframe(keyframe, index, fallbackCamera))
    .sort((left, right) => left.time - right.time);
  if (!normalizedFrames.length) return normalizeDirectorCamera(fallbackCamera);
  if (normalizedFrames.length === 1 || time <= normalizedFrames[0].time) {
    return normalizeDirectorCamera(normalizedFrames[0].camera, fallbackCamera);
  }
  const last = normalizedFrames.at(-1);
  if (time >= last.time) return normalizeDirectorCamera(last.camera, fallbackCamera);

  const rightIndex = normalizedFrames.findIndex((frame) => frame.time >= time);
  const left = normalizedFrames[rightIndex - 1];
  const right = normalizedFrames[rightIndex];
  const duration = Math.max(0.0001, right.time - left.time);
  const amount = Math.min(1, Math.max(0, (time - left.time) / duration));
  return {
    position: interpolateVector(left.camera.position, right.camera.position, amount),
    rotation: interpolateVector(left.camera.rotation, right.camera.rotation, amount, true),
    focalLength: left.camera.focalLength + (right.camera.focalLength - left.camera.focalLength) * amount,
  };
};

const describeObject = (object) => {
  if (object.source.type === "local") return object.name || object.source.fileName || "imported 3D asset";
  const labels = {
    person: "person",
    product: "product",
    vehicle: "vehicle",
    architecture: "architecture",
  };
  return labels[object.source.kind] || object.source.kind || "subject";
};

export const buildDirectorShot = (value) => {
  const state = normalizeDirectorState(value);
  const camera = normalizeDirectorCamera(state.camera);
  const objects = state.objects.map((object) => ({
    id: object.id,
    name: object.name,
    source: { ...object.source },
    transform: normalizeTransform(object.transform),
  }));
  const cameraPath = state.cameraKeyframes.map((keyframe) => ({
    id: keyframe.id,
    name: keyframe.name,
    time: keyframe.time,
    camera: normalizeDirectorCamera(keyframe.camera, camera),
  }));
  const movement = cameraPath.length > 1
    ? `camera move across ${cameraPath.length} keyframes over ${roundDirectorNumber(cameraPath.at(-1).time - cameraPath[0].time, 1)} seconds`
    : "locked camera";
  const subjectSummary = objects.length
    ? objects.map(describeObject).join(", ")
    : "an empty set";
  const promptSummary = [
    `${subjectSummary} in a composed 3D scene`,
    `${roundDirectorNumber(camera.focalLength, 1)}mm lens`,
    `camera at (${roundDirectorNumber(camera.position.x)}, ${roundDirectorNumber(camera.position.y)}, ${roundDirectorNumber(camera.position.z)})`,
    `${state.lighting.preset} lighting at ${Math.round(state.lighting.temperature)}K`,
    `${state.environment.time} environment`,
    movement,
  ].join(", ");

  return {
    schemaVersion: 1,
    type: "director3d-shot",
    camera,
    cameraPath,
    objects,
    lighting: { ...state.lighting },
    environment: { ...state.environment },
    promptSummary,
  };
};
