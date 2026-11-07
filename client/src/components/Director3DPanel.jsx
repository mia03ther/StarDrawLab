import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Aperture,
  Box,
  Camera,
  Check,
  Clipboard,
  Crosshair,
  Download,
  FileBox,
  Lightbulb,
  Move,
  Pause,
  Play,
  Plus,
  Power,
  RotateCcw,
  Route,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { useLanguage } from "../contexts/LanguageContext";
import {
  buildDirectorShot,
  clampDirectorNumber,
  DEFAULT_DIRECTOR_STATE,
  interpolateDirectorCamera,
  normalizeDirectorState,
  packDirectorEnvironment,
  packDirectorLighting,
  roundDirectorNumber,
} from "../utils/director3dState";
import CanvasRoundedSelect from "./canvas/CanvasRoundedSelect";
import "./Director3DPanel.css";

const SUBJECT_OPTIONS = [
  { value: "person", zh: "人物占位", en: "Person placeholder" },
  { value: "product", zh: "产品占位", en: "Product placeholder" },
  { value: "vehicle", zh: "车辆占位", en: "Vehicle placeholder" },
  { value: "architecture", zh: "建筑占位", en: "Architecture placeholder" },
];

const directorSelectUi = {
  soft: "var(--director-bg)",
  panelStrong: "var(--director-panel-strong)",
  text: "var(--director-text)",
  muted: "var(--director-muted)",
  faint: "var(--director-muted)",
  line: "var(--director-line)",
  line2: "var(--director-line-strong)",
  gold: "var(--director-accent)",
  goldSoft: "var(--director-accent-soft)",
};

const LIGHTING_OPTIONS = [
  { value: "studio", zh: "摄影棚三点布光", en: "Studio three-point lighting" },
  { value: "soft", zh: "柔和漫射光", en: "Soft diffused light" },
  { value: "dramatic", zh: "戏剧侧光", en: "Dramatic side light" },
  { value: "natural", zh: "自然日光", en: "Natural daylight" },
  { value: "neon", zh: "霓虹轮廓光", en: "Neon rim light" },
];

const TIME_OPTIONS = [
  { value: "dawn", zh: "清晨", en: "Dawn" },
  { value: "day", zh: "日间", en: "Daytime" },
  { value: "golden", zh: "黄金时刻", en: "Golden hour" },
  { value: "night", zh: "夜景", en: "Night" },
];

const CAMERA_LIMITS = {
  x: [-30, 30],
  y: [0.2, 30],
  z: [-30, 30],
};

const OBJECT_POSITION_LIMITS = [-100, 100];
const OBJECT_ROTATION_LIMITS = [-360, 360];
const OBJECT_SCALE_LIMITS = [0.01, 100];

const createLocalId = (prefix) => {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const kelvinToColor = (kelvin) => {
  const temperature = clampDirectorNumber(kelvin, 2000, 10000, 5600) / 100;
  let red;
  let green;
  let blue;

  if (temperature <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
    blue = temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * ((temperature - 60) ** -0.1332047592);
    green = 288.1221695283 * ((temperature - 60) ** -0.0755148492);
    blue = 255;
  }

  return new THREE.Color(
    clampDirectorNumber(red, 0, 255, 255) / 255,
    clampDirectorNumber(green, 0, 255, 255) / 255,
    clampDirectorNumber(blue, 0, 255, 255) / 255,
  );
};

const disposeMaterial = (material) => {
  if (!material) return;
  Object.values(material).forEach((value) => {
    if (value?.isTexture) value.dispose?.();
  });
  material.dispose?.();
};

const disposeObject = (object) => {
  object?.traverse?.((child) => {
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach(disposeMaterial);
    else disposeMaterial(child.material);
  });
};

const createMesh = (geometry, material, position, scale) => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  if (scale) mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

const createSubject = (kind) => {
  const group = new THREE.Group();
  const primary = new THREE.MeshStandardMaterial({ color: 0x4f8ea8, roughness: 0.42, metalness: 0.12 });
  const secondary = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.5, metalness: 0.08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x202934, roughness: 0.55, metalness: 0.3 });

  if (kind === "person") {
    group.add(createMesh(new THREE.CapsuleGeometry(0.58, 1.7, 8, 16), primary, [0, 1.65, 0]));
    group.add(createMesh(new THREE.SphereGeometry(0.48, 24, 16), secondary, [0, 3.15, 0]));
  } else if (kind === "product") {
    group.add(createMesh(new THREE.CylinderGeometry(1.05, 1.05, 1.9, 32), primary, [0, 1.15, 0]));
    group.add(createMesh(new THREE.TorusGeometry(0.72, 0.09, 12, 32), secondary, [0, 2.12, 0]));
  } else if (kind === "vehicle") {
    group.add(createMesh(new THREE.BoxGeometry(3.8, 0.75, 1.8), primary, [0, 0.85, 0]));
    group.add(createMesh(new THREE.BoxGeometry(1.9, 0.72, 1.6), secondary, [0.2, 1.55, 0]));
    [[-1.25, 0.45, 0.92], [1.25, 0.45, 0.92], [-1.25, 0.45, -0.92], [1.25, 0.45, -0.92]]
      .forEach((position) => {
        const wheel = createMesh(new THREE.CylinderGeometry(0.42, 0.42, 0.25, 20), dark, position);
        wheel.rotation.x = Math.PI / 2;
        group.add(wheel);
      });
  } else if (kind === "architecture") {
    group.add(createMesh(new THREE.BoxGeometry(2.8, 3.8, 2.2), primary, [0, 1.9, 0]));
    group.add(createMesh(new THREE.BoxGeometry(1.5, 5.5, 1.5), secondary, [1.75, 2.75, 0.15]));
    group.add(createMesh(new THREE.BoxGeometry(1.1, 2.8, 1.2), dark, [-1.75, 1.4, 0.2]));
  }

  return group;
};

const prepareImportedScene = (sourceScene) => {
  const content = sourceScene || new THREE.Group();
  content.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  content.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(content);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z, 0.001);
  const normalizationScale = 3.5 / maxDimension;
  const root = new THREE.Group();
  content.scale.setScalar(normalizationScale);
  content.position.set(
    -center.x * normalizationScale,
    -bounds.min.y * normalizationScale,
    -center.z * normalizationScale,
  );
  root.add(content);
  return root;
};

const applyLighting = (sceneRefs, lighting, environment) => {
  const { ambientLight, fillLight, keyLight, rimLight, scene } = sceneRefs;
  if (!ambientLight || !keyLight || !fillLight || !rimLight || !scene) return;

  const keyColor = kelvinToColor(lighting.temperature);
  const intensity = lighting.intensity;
  const presets = {
    studio: { ambient: 0.38, key: 1, fill: 0.42, rim: 0.62, keyPosition: [5, 8, 5] },
    soft: { ambient: 0.65, key: 0.62, fill: 0.5, rim: 0.24, keyPosition: [3, 8, 4] },
    dramatic: { ambient: 0.16, key: 1.35, fill: 0.16, rim: 0.9, keyPosition: [-6, 6, 3] },
    natural: { ambient: 0.54, key: 0.85, fill: 0.28, rim: 0.3, keyPosition: [7, 10, 4] },
    neon: { ambient: 0.22, key: 0.72, fill: 0.72, rim: 1.15, keyPosition: [-4, 5, 4] },
  };
  const setup = presets[lighting.preset] || presets.studio;

  ambientLight.intensity = setup.ambient * intensity;
  keyLight.intensity = setup.key * intensity;
  fillLight.intensity = setup.fill * intensity;
  rimLight.intensity = setup.rim * intensity;
  keyLight.color.copy(keyColor);
  keyLight.position.set(...setup.keyPosition);
  fillLight.color.set(lighting.preset === "neon" ? 0x3ed8ff : 0x9dc9ff);
  rimLight.color.set(lighting.preset === "neon" ? 0xff3fa4 : 0xffc977);

  const skyColors = { dawn: 0x3a3040, day: 0x9ebad0, golden: 0x9b613d, night: 0x11182b };
  ambientLight.color.set(skyColors[environment.time] || skyColors.day);
  scene.background = new THREE.Color(environment.background);
  scene.fog = new THREE.Fog(environment.background, 24, 58);
};

const getFileLookupKeys = (value) => {
  const decoded = (() => {
    try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
  })();
  const withoutQuery = decoded.split(/[?#]/, 1)[0].replaceAll("\\", "/");
  const basename = withoutQuery.split("/").at(-1);
  return [withoutQuery.replace(/^\.\//, ""), basename].filter(Boolean);
};

const FieldHeader = ({ icon, children }) => (
  <div className="director3d-field-header">
    {createElement(icon, { size: 15, "aria-hidden": true })}
    <span>{children}</span>
  </div>
);

const RangeField = ({ label, value, min, max, step, unit, onChange }) => (
  <label className="director3d-range-field">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    <output>{value}{unit}</output>
  </label>
);

const VectorField = ({ label, value, limits, step, onChange }) => (
  <div className="director3d-vector-field">
    <span className="director3d-vector-label">{label}</span>
    <div className="director3d-vector-grid">
      {["x", "y", "z"].map((axis) => (
        <label key={axis}>
          <span>{axis.toUpperCase()}</span>
          <input
            type="number"
            min={limits[0]}
            max={limits[1]}
            step={step}
            value={value[axis]}
            onChange={(event) => onChange({
              ...value,
              [axis]: clampDirectorNumber(event.target.value, limits[0], limits[1], value[axis]),
            })}
          />
        </label>
      ))}
    </div>
  </div>
);

const Director3DPanel = ({ directorState, onChange }) => {
  const { t } = useLanguage();
  const mountRef = useRef(null);
  const fileInputRef = useRef(null);
  const pendingRelinkIdRef = useRef(null);
  const sceneRefs = useRef({});
  const runtimeAssetsRef = useRef(new Map());
  const assetUrlsRef = useRef(new Map());
  const directorStateRef = useRef(directorState);
  const onChangeRef = useRef(onChange);
  const translateRef = useRef(t);
  const syncingCameraRef = useRef(false);
  const cameraEmitFrameRef = useRef(0);
  const previewTimeRef = useRef(0);
  const mountedRef = useRef(true);
  const [webglError, setWebglError] = useState("");
  const [assetError, setAssetError] = useState("");
  const [importingAsset, setImportingAsset] = useState(false);
  const [placeholderKind, setPlaceholderKind] = useState("person");
  const [selectedObjectId, setSelectedObjectId] = useState("");
  const [keyframeTime, setKeyframeTime] = useState(0);
  const [previewTime, setPreviewTime] = useState(0);
  const [playingPath, setPlayingPath] = useState(false);
  const [copiedValue, setCopiedValue] = useState("");
  const normalized = useMemo(() => normalizeDirectorState(directorState), [directorState]);

  directorStateRef.current = directorState;
  onChangeRef.current = onChange;
  translateRef.current = t;
  previewTimeRef.current = previewTime;

  const emitChange = useCallback((patch) => {
    if (typeof onChangeRef.current !== "function") return;
    const current = normalizeDirectorState(directorStateRef.current);
    const nextBase = {
      ...(directorStateRef.current && typeof directorStateRef.current === "object" ? directorStateRef.current : {}),
      enabled: current.enabled,
      scene: current.scene,
      camera: current.camera,
      objects: current.objects,
      cameraKeyframes: current.cameraKeyframes,
      lighting: packDirectorLighting(current.lighting),
      environment: packDirectorEnvironment(current.environment),
      ...patch,
    };
    const next = { ...nextBase, shot: buildDirectorShot(nextBase) };
    directorStateRef.current = next;
    onChangeRef.current(next);
  }, []);

  const applyCameraToScene = useCallback((cameraState) => {
    const { camera, controls } = sceneRefs.current;
    if (!camera || !controls) return;
    syncingCameraRef.current = true;
    camera.position.set(cameraState.position.x, cameraState.position.y, cameraState.position.z);
    camera.rotation.order = "YXZ";
    camera.rotation.set(
      THREE.MathUtils.degToRad(cameraState.rotation.x),
      THREE.MathUtils.degToRad(cameraState.rotation.y),
      THREE.MathUtils.degToRad(cameraState.rotation.z),
      "YXZ",
    );
    camera.setFocalLength(cameraState.focalLength);
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    controls.target.copy(camera.position).addScaledVector(direction, 8);
    camera.updateProjectionMatrix();
    controls.update();
    syncingCameraRef.current = false;
  }, []);

  const releaseRuntimeAsset = useCallback((objectId) => {
    const refs = sceneRefs.current;
    const node = refs.objectNodes?.get(objectId) || runtimeAssetsRef.current.get(objectId)?.object;
    if (node) {
      refs.scene?.remove(node);
      disposeObject(node);
    }
    refs.objectNodes?.delete(objectId);
    runtimeAssetsRef.current.delete(objectId);
    const urls = assetUrlsRef.current.get(objectId) || [];
    urls.forEach((url) => URL.revokeObjectURL(url));
    assetUrlsRef.current.delete(objectId);
  }, []);

  const selectedObject = normalized.objects.find((object) => object.id === selectedObjectId)
    || normalized.objects[0]
    || null;
  const effectiveSelectedId = selectedObject?.id || "";
  const pathStart = normalized.cameraKeyframes[0]?.time ?? 0;
  const pathEnd = normalized.cameraKeyframes.at(-1)?.time ?? Math.max(1, pathStart);
  const shotDraft = useMemo(() => buildDirectorShot(normalized), [normalized]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!selectedObjectId && normalized.objects.length) setSelectedObjectId(normalized.objects[0].id);
    if (selectedObjectId && !normalized.objects.some((object) => object.id === selectedObjectId)) {
      setSelectedObjectId(normalized.objects[0]?.id || "");
    }
  }, [normalized.objects, selectedObjectId]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    const runtimeAssets = runtimeAssetsRef.current;
    const assetUrls = assetUrlsRef.current;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      setWebglError(translateRef.current("当前浏览器无法启动 WebGL 3D 预览", "This browser cannot start the WebGL 3D preview"));
      return undefined;
    }

    setWebglError("");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.minDistance = 1.2;
    controls.maxDistance = 55;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(0, 1.4, 0);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = "director3d-canvas";
    renderer.domElement.setAttribute(
      "aria-label",
      translateRef.current("3D 导演台场景预览，可拖动旋转、滚轮缩放并点击选择物体", "3D scene preview; orbit, zoom and click to select objects"),
    );
    mount.appendChild(renderer.domElement);

    const ambientLight = new THREE.HemisphereLight(0xbfd9ee, 0x252018, 0.5);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    const fillLight = new THREE.PointLight(0xa8d5ff, 0.6, 35);
    const rimLight = new THREE.DirectionalLight(0xffd18c, 0.8);
    keyLight.position.set(5, 8, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -10;
    keyLight.shadow.camera.right = 10;
    keyLight.shadow.camera.top = 10;
    keyLight.shadow.camera.bottom = -10;
    fillLight.position.set(-5, 4, 3);
    rimLight.position.set(2, 5, -6);
    scene.add(ambientLight, keyLight, fillLight, rimLight);

    const grid = new THREE.GridHelper(40, 40, 0x6f8898, 0x33414a);
    grid.position.y = 0.012;
    grid.material.transparent = true;
    grid.material.opacity = 0.48;
    scene.add(grid);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.32 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const refs = {
      ambientLight,
      camera,
      controls,
      fillLight,
      grid,
      ground,
      keyLight,
      objectNodes: new Map(),
      pathObject: null,
      renderer,
      rimLight,
      scene,
      selectionBox: null,
    };
    sceneRefs.current = refs;

    const emitCamera = () => {
      if (syncingCameraRef.current || cameraEmitFrameRef.current) return;
      cameraEmitFrameRef.current = window.requestAnimationFrame(() => {
        cameraEmitFrameRef.current = 0;
        if (syncingCameraRef.current) return;
        const current = normalizeDirectorState(directorStateRef.current);
        const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
        emitChange({
          camera: {
            ...current.camera,
            position: {
              x: roundDirectorNumber(camera.position.x),
              y: roundDirectorNumber(camera.position.y),
              z: roundDirectorNumber(camera.position.z),
            },
            rotation: {
              x: roundDirectorNumber(THREE.MathUtils.radToDeg(euler.x)),
              y: roundDirectorNumber(THREE.MathUtils.radToDeg(euler.y)),
              z: roundDirectorNumber(THREE.MathUtils.radToDeg(euler.z)),
            },
            focalLength: roundDirectorNumber(camera.getFocalLength(), 1),
          },
        });
      });
    };
    controls.addEventListener("change", emitCamera);

    const pointerStart = new THREE.Vector2();
    const onPointerDown = (event) => pointerStart.set(event.clientX, event.clientY);
    const onPointerUp = (event) => {
      if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects([...refs.objectNodes.values()], true);
      let hit = hits[0]?.object;
      while (hit && !hit.userData.directorObjectId) hit = hit.parent;
      if (hit?.userData.directorObjectId) setSelectedObjectId(hit.userData.directorObjectId);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(mount);
    window.addEventListener("resize", resize);
    resize();

    let animationFrame = 0;
    const render = () => {
      controls.update();
      refs.selectionBox?.update?.();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(render);
    };
    render();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      if (cameraEmitFrameRef.current) window.cancelAnimationFrame(cameraEmitFrameRef.current);
      cameraEmitFrameRef.current = 0;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      controls.removeEventListener("change", emitCamera);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      refs.selectionBox?.geometry?.dispose?.();
      refs.selectionBox?.material?.dispose?.();
      if (refs.pathObject) disposeObject(refs.pathObject);
      refs.objectNodes.forEach(disposeObject);
      runtimeAssets.clear();
      assetUrls.forEach((urls) => urls.forEach((url) => URL.revokeObjectURL(url)));
      assetUrls.clear();
      disposeObject(grid);
      disposeObject(ground);
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      sceneRefs.current = {};
    };
  }, [emitChange]);

  useEffect(() => {
    applyCameraToScene(normalized.camera);
  }, [applyCameraToScene, normalized.camera]);

  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs.scene || !refs.objectNodes) return;
    const desiredIds = new Set(normalized.objects.map((object) => object.id));
    [...refs.objectNodes.entries()].forEach(([objectId, node]) => {
      if (desiredIds.has(objectId)) return;
      refs.scene.remove(node);
      disposeObject(node);
      refs.objectNodes.delete(objectId);
      runtimeAssetsRef.current.delete(objectId);
      const urls = assetUrlsRef.current.get(objectId) || [];
      urls.forEach((url) => URL.revokeObjectURL(url));
      assetUrlsRef.current.delete(objectId);
    });

    normalized.objects.forEach((object) => {
      let node = refs.objectNodes.get(object.id);
      if (!node && object.source.type === "placeholder") node = createSubject(object.source.kind);
      if (!node && object.source.type === "local") node = runtimeAssetsRef.current.get(object.id)?.object;
      if (!node) return;
      if (!refs.objectNodes.has(object.id)) {
        refs.objectNodes.set(object.id, node);
        refs.scene.add(node);
      }
      node.name = object.name;
      node.userData.directorObjectId = object.id;
      node.traverse((child) => { child.userData.directorObjectId = object.id; });
      const { position, rotation, scale } = object.transform;
      node.position.set(position.x, position.y, position.z);
      node.rotation.order = "XYZ";
      node.rotation.set(
        THREE.MathUtils.degToRad(rotation.x),
        THREE.MathUtils.degToRad(rotation.y),
        THREE.MathUtils.degToRad(rotation.z),
      );
      node.scale.set(scale.x, scale.y, scale.z);
      node.updateMatrixWorld(true);
    });

    if (refs.selectionBox) {
      refs.scene.remove(refs.selectionBox);
      refs.selectionBox.geometry?.dispose?.();
      refs.selectionBox.material?.dispose?.();
      refs.selectionBox = null;
    }
    const selectedNode = refs.objectNodes.get(effectiveSelectedId);
    if (selectedNode) {
      refs.selectionBox = new THREE.BoxHelper(selectedNode, 0x49b9d1);
      refs.selectionBox.raycast = () => null;
      refs.scene.add(refs.selectionBox);
    }
  }, [effectiveSelectedId, normalized.objects]);

  useEffect(() => {
    const refs = sceneRefs.current;
    if (!refs.scene) return;
    if (refs.pathObject) {
      refs.scene.remove(refs.pathObject);
      disposeObject(refs.pathObject);
      refs.pathObject = null;
    }
    if (normalized.cameraKeyframes.length < 2) return;
    const pathObject = new THREE.Group();
    const controlPoints = normalized.cameraKeyframes.map((frame) => new THREE.Vector3(
      frame.camera.position.x,
      frame.camera.position.y,
      frame.camera.position.z,
    ));
    const curve = new THREE.CatmullRomCurve3(controlPoints, false, "centripetal");
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(Math.max(32, controlPoints.length * 20))),
      new THREE.LineBasicMaterial({ color: 0xe9ad4f, transparent: true, opacity: 0.9 }),
    );
    pathObject.add(line);
    controlPoints.forEach((point) => {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd58e }),
      );
      marker.position.copy(point);
      pathObject.add(marker);
    });
    refs.pathObject = pathObject;
    refs.scene.add(pathObject);
  }, [normalized.cameraKeyframes]);

  useEffect(() => {
    applyLighting(sceneRefs.current, normalized.lighting, normalized.environment);
  }, [normalized.environment, normalized.lighting]);

  useEffect(() => {
    if (!playingPath || normalized.cameraKeyframes.length < 2) return undefined;
    let frame = 0;
    const durationSeconds = Math.max(0.01, pathEnd - pathStart);
    const requestedTime = Math.min(pathEnd, Math.max(pathStart, previewTimeRef.current));
    const initialTime = requestedTime >= pathEnd ? pathStart : requestedTime;
    const startedAt = performance.now() - (initialTime - pathStart) * 1000;
    const tick = (now) => {
      const elapsed = (now - startedAt) / 1000;
      const nextTime = pathStart + elapsed;
      if (nextTime >= pathEnd) {
        setPreviewTime(pathEnd);
        applyCameraToScene(interpolateDirectorCamera(normalized.cameraKeyframes, pathEnd, normalized.camera));
        setPlayingPath(false);
        return;
      }
      const loopedTime = pathStart + (elapsed % durationSeconds);
      setPreviewTime(loopedTime);
      applyCameraToScene(interpolateDirectorCamera(normalized.cameraKeyframes, loopedTime, normalized.camera));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [applyCameraToScene, normalized.camera, normalized.cameraKeyframes, pathEnd, pathStart, playingPath]);

  const patchCamera = (patch) => emitChange({ camera: { ...normalized.camera, ...patch } });
  const patchLighting = (patch) => emitChange({ lighting: packDirectorLighting({ ...normalized.lighting, ...patch }) });
  const patchEnvironment = (patch) => emitChange({ environment: packDirectorEnvironment({ ...normalized.environment, ...patch }) });

  const resetCamera = () => emitChange({ camera: {
    position: { ...DEFAULT_DIRECTOR_STATE.camera.position },
    rotation: { ...DEFAULT_DIRECTOR_STATE.camera.rotation },
    focalLength: DEFAULT_DIRECTOR_STATE.camera.focalLength,
  } });

  const addPlaceholder = () => {
    const object = {
      id: createLocalId("placeholder"),
      name: t("新占位物体", "New placeholder"),
      source: { type: "placeholder", kind: placeholderKind },
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    };
    emitChange({ objects: [...normalized.objects, object] });
    setSelectedObjectId(object.id);
  };

  const openAssetPicker = (relinkObjectId = null) => {
    pendingRelinkIdRef.current = relinkObjectId;
    fileInputRef.current?.click();
  };

  const importLocalAsset = async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) {
      pendingRelinkIdRef.current = null;
      return;
    }
    const mainFile = files.find((file) => /\.(glb|gltf)$/i.test(file.name));
    if (!mainFile) {
      setAssetError(t("请选择一个 .glb 或 .gltf 主文件", "Select a .glb or .gltf main file"));
      pendingRelinkIdRef.current = null;
      return;
    }

    setImportingAsset(true);
    setAssetError("");
    const urls = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
    const urlLookup = new Map();
    urls.forEach(({ file, url }) => {
      getFileLookupKeys(file.name).forEach((key) => urlLookup.set(key, url));
      const relativePath = file.webkitRelativePath || "";
      getFileLookupKeys(relativePath).forEach((key) => urlLookup.set(key, url));
    });
    const mainUrl = urls.find(({ file }) => file === mainFile)?.url;
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((requestedUrl) => {
      const matchedKey = getFileLookupKeys(requestedUrl).find((key) => urlLookup.has(key));
      return matchedKey ? urlLookup.get(matchedKey) : requestedUrl;
    });

    try {
      const gltf = await new GLTFLoader(manager).loadAsync(mainUrl);
      const object = prepareImportedScene(gltf.scene);
      if (!mountedRef.current) {
        disposeObject(object);
        urls.forEach(({ url }) => URL.revokeObjectURL(url));
        return;
      }
      const relinkId = pendingRelinkIdRef.current;
      const objectId = relinkId || createLocalId("local-model");
      if (relinkId) releaseRuntimeAsset(relinkId);
      runtimeAssetsRef.current.set(objectId, { object });
      assetUrlsRef.current.set(objectId, urls.map(({ url }) => url));
      const previous = normalized.objects.find((item) => item.id === objectId);
      const nextObject = {
        id: objectId,
        name: previous?.name || mainFile.name.replace(/\.(glb|gltf)$/i, ""),
        source: {
          type: "local",
          fileName: mainFile.name,
          mimeType: mainFile.type || (mainFile.name.toLowerCase().endsWith(".glb") ? "model/gltf-binary" : "model/gltf+json"),
          localOnly: true,
        },
        transform: previous?.transform || {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      };
      emitChange({
        objects: relinkId
          ? normalized.objects.map((item) => (item.id === relinkId ? nextObject : item))
          : [...normalized.objects, nextObject],
      });
      setSelectedObjectId(objectId);
    } catch (error) {
      urls.forEach(({ url }) => URL.revokeObjectURL(url));
      setAssetError(t(
        `本地模型读取失败：${error?.message || "文件格式不受支持"}`,
        `Could not read local model: ${error?.message || "unsupported file format"}`,
      ));
    } finally {
      pendingRelinkIdRef.current = null;
      if (mountedRef.current) setImportingAsset(false);
    }
  };

  const deleteObject = (objectId) => {
    releaseRuntimeAsset(objectId);
    const remaining = normalized.objects.filter((object) => object.id !== objectId);
    emitChange({ objects: remaining });
    setSelectedObjectId(remaining[0]?.id || "");
  };

  const patchSelectedObject = (patch) => {
    if (!selectedObject) return;
    emitChange({
      objects: normalized.objects.map((object) => (
        object.id === selectedObject.id ? { ...object, ...patch } : object
      )),
    });
  };

  const addCameraKeyframe = () => {
    const time = clampDirectorNumber(keyframeTime, 0, 3600, 0);
    const keyframe = {
      id: createLocalId("camera-keyframe"),
      name: `${t("镜头", "Shot")} ${normalized.cameraKeyframes.length + 1}`,
      time,
      camera: normalized.camera,
    };
    emitChange({ cameraKeyframes: [...normalized.cameraKeyframes, keyframe] });
    setPreviewTime(time);
    setKeyframeTime(roundDirectorNumber(time + 1, 1));
  };

  const patchKeyframe = (keyframeId, patch) => emitChange({
    cameraKeyframes: normalized.cameraKeyframes.map((keyframe) => (
      keyframe.id === keyframeId ? { ...keyframe, ...patch } : keyframe
    )),
  });

  const previewCameraAt = (time) => {
    const nextTime = clampDirectorNumber(time, pathStart, pathEnd, pathStart);
    setPreviewTime(nextTime);
    applyCameraToScene(interpolateDirectorCamera(normalized.cameraKeyframes, nextTime, normalized.camera));
  };

  const applyPreviewCamera = () => {
    if (!normalized.cameraKeyframes.length) return;
    emitChange({ camera: interpolateDirectorCamera(normalized.cameraKeyframes, previewTime, normalized.camera) });
  };

  const copyText = async (kind, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(kind);
      window.setTimeout(() => setCopiedValue((current) => (current === kind ? "" : current)), 1600);
    } catch {
      setAssetError(t("复制失败，请手动选择文本", "Copy failed; select the text manually"));
    }
  };

  const knownLighting = LIGHTING_OPTIONS.some((option) => option.value === normalized.lighting.preset);
  const knownTime = TIME_OPTIONS.some((option) => option.value === normalized.environment.time);
  const environmentTimeLabel = TIME_OPTIONS.find((option) => option.value === normalized.environment.time);
  const selectedRuntimeMissing = selectedObject?.source.type === "local"
    && !runtimeAssetsRef.current.has(selectedObject.id);

  return (
    <section className="director3d-panel" aria-label={t("3D 导演台", "3D Director") }>
      <header className="director3d-toolbar">
        <div className="director3d-title">
          <Camera size={19} aria-hidden="true" />
          <div>
            <h2>{t("3D 导演台", "3D Director")}</h2>
            <p>{t("本地资产、多物体构图与镜头轨迹", "Local assets, multi-object staging and camera paths")}</p>
          </div>
        </div>
        <div className="director3d-toolbar-actions">
          <button type="button" className="director3d-toolbar-button" onClick={() => emitChange({ shot: shotDraft })}>
            <Download size={14} aria-hidden="true" />{t("同步镜头参数", "Sync shot")}
          </button>
          <label className="director3d-power">
            <input type="checkbox" checked={normalized.enabled} onChange={(event) => emitChange({ enabled: event.target.checked })} />
            <span aria-hidden="true"><Power size={14} /></span>
            {normalized.enabled ? t("已启用", "Enabled") : t("未启用", "Disabled")}
          </label>
        </div>
      </header>

      <div className="director3d-workspace">
        <div className="director3d-viewport">
          <div ref={mountRef} className="director3d-mount" />
          {webglError && <div className="director3d-error" role="alert">{webglError}</div>}
          <div className="director3d-viewport-hint">
            {t("拖动旋转 · 滚轮缩放 · 点击选择物体", "Orbit · zoom · click to select")}
          </div>
          <div className="director3d-viewport-badge">
            <span>{normalized.camera.focalLength} mm</span>
            <span>{normalized.objects.length} {t("个物体", "objects")}</span>
            <span>{environmentTimeLabel ? t(environmentTimeLabel.zh, environmentTimeLabel.en) : normalized.environment.time}</span>
          </div>
        </div>

        <div className="director3d-controls">
          <fieldset className="director3d-control-group">
            <legend><FieldHeader icon={Box}>{t("场景物体", "Scene objects")}</FieldHeader></legend>
            <input
              ref={fileInputRef}
              className="director3d-hidden-input"
              type="file"
              accept=".glb,.gltf,model/gltf-binary,model/gltf+json,application/octet-stream,image/*,.bin"
              multiple
              onChange={importLocalAsset}
            />
            <div className="director3d-import-row">
              <button type="button" className="director3d-primary-command" disabled={importingAsset} onClick={() => openAssetPicker()}>
                <Upload size={14} aria-hidden="true" />
                {importingAsset ? t("正在读取…", "Reading…") : t("导入 glTF / GLB", "Import glTF / GLB")}
              </button>
              <span>{t("仅在浏览器本地读取", "Browser-local only")}</span>
            </div>
            <div className="director3d-add-row">
              <CanvasRoundedSelect label={t("占位物体类型", "Placeholder type")} value={placeholderKind} onChange={setPlaceholderKind} options={SUBJECT_OPTIONS.map((option) => ({ value: option.value, label: t(option.zh, option.en) }))} ui={directorSelectUi} className="min-w-0 flex-1" triggerClassName="h-[31px] w-full rounded-[5px] px-2 text-[10px]" menuMinWidth={200} />
              <button type="button" className="director3d-icon-command director3d-inline-command" onClick={addPlaceholder}>
                <Plus size={14} aria-hidden="true" />{t("添加占位", "Add placeholder")}
              </button>
            </div>
            {assetError && <p className="director3d-inline-error" role="alert">{assetError}</p>}
            <div className="director3d-object-list">
              {normalized.objects.length === 0 && <p className="director3d-empty">{t("场景为空，可添加占位物体或本地模型。", "The scene is empty. Add a placeholder or local model.")}</p>}
              {normalized.objects.map((object) => (
                <div key={object.id} className={`director3d-object-row${object.id === effectiveSelectedId ? " is-selected" : ""}`}>
                  <button type="button" className="director3d-object-select" onClick={() => setSelectedObjectId(object.id)}>
                    {object.source.type === "local" ? <FileBox size={15} /> : <Box size={15} />}
                    <span><strong>{object.name}</strong><small>{object.source.type === "local" ? object.source.fileName : object.source.kind}</small></span>
                  </button>
                  <button type="button" className="director3d-delete-command" onClick={() => deleteObject(object.id)} aria-label={t(`删除 ${object.name}`, `Delete ${object.name}`)}>
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            {selectedObject && (
              <div className="director3d-object-editor">
                <label className="director3d-name-field">
                  <span>{t("名称", "Name")}</span>
                  <input value={selectedObject.name} maxLength={120} onChange={(event) => patchSelectedObject({ name: event.target.value })} />
                </label>
                {selectedRuntimeMissing && (
                  <div className="director3d-local-missing">
                    <span>{t("刷新后需重新选择本地文件，项目中只保存构图参数。", "Relink the local file after refresh; only staging data is persisted.")}</span>
                    <button type="button" onClick={() => openAssetPicker(selectedObject.id)}>{t("重新载入", "Relink")}</button>
                  </div>
                )}
                <VectorField label={t("位置", "Position")} value={selectedObject.transform.position} limits={OBJECT_POSITION_LIMITS} step={0.1} onChange={(position) => patchSelectedObject({ transform: { ...selectedObject.transform, position } })} />
                <VectorField label={t("旋转", "Rotation")} value={selectedObject.transform.rotation} limits={OBJECT_ROTATION_LIMITS} step={1} onChange={(rotation) => patchSelectedObject({ transform: { ...selectedObject.transform, rotation } })} />
                <VectorField label={t("缩放", "Scale")} value={selectedObject.transform.scale} limits={OBJECT_SCALE_LIMITS} step={0.1} onChange={(scale) => patchSelectedObject({ transform: { ...selectedObject.transform, scale } })} />
              </div>
            )}
          </fieldset>

          <fieldset className="director3d-control-group">
            <legend><FieldHeader icon={Move}>{t("相机机位", "Camera position")}</FieldHeader></legend>
            <VectorField
              label={t("位置", "Position")}
              value={normalized.camera.position}
              limits={[-30, 30]}
              step={0.1}
              onChange={(position) => patchCamera({ position: {
                x: clampDirectorNumber(position.x, ...CAMERA_LIMITS.x, normalized.camera.position.x),
                y: clampDirectorNumber(position.y, ...CAMERA_LIMITS.y, normalized.camera.position.y),
                z: clampDirectorNumber(position.z, ...CAMERA_LIMITS.z, normalized.camera.position.z),
              } })}
            />
            <VectorField label={t("朝向", "Orientation")} value={normalized.camera.rotation} limits={[-180, 180]} step={1} onChange={(rotation) => patchCamera({ rotation })} />
            <RangeField label={t("焦距", "Focal length")} value={normalized.camera.focalLength} min={12} max={200} step={1} unit=" mm" onChange={(focalLength) => patchCamera({ focalLength })} />
            <button type="button" className="director3d-icon-command" onClick={resetCamera}>
              <RotateCcw size={14} aria-hidden="true" />{t("重置机位", "Reset camera")}
            </button>
          </fieldset>

          <fieldset className="director3d-control-group">
            <legend><FieldHeader icon={Route}>{t("相机关键帧与轨迹", "Camera keyframes and path")}</FieldHeader></legend>
            <div className="director3d-keyframe-capture">
              <label><span>{t("时间", "Time")}</span><input type="number" min="0" max="3600" step="0.1" value={keyframeTime} onChange={(event) => setKeyframeTime(event.target.value)} /></label>
              <button type="button" className="director3d-primary-command" onClick={addCameraKeyframe}><Crosshair size={14} />{t("记录当前机位", "Capture camera")}</button>
            </div>
            <div className="director3d-keyframe-list">
              {normalized.cameraKeyframes.length === 0 && <p className="director3d-empty">{t("至少记录两个机位即可预览轨迹。", "Capture at least two cameras to preview a path.")}</p>}
              {normalized.cameraKeyframes.map((keyframe, index) => (
                <div key={keyframe.id} className="director3d-keyframe-row">
                  <button type="button" className="director3d-keyframe-jump" onClick={() => previewCameraAt(keyframe.time)}>
                    <span>{index + 1}</span><strong>{keyframe.name}</strong>
                  </button>
                  <label><input type="number" min="0" max="3600" step="0.1" value={keyframe.time} onChange={(event) => patchKeyframe(keyframe.id, { time: clampDirectorNumber(event.target.value, 0, 3600, keyframe.time) })} /><span>s</span></label>
                  <button type="button" className="director3d-keyframe-refresh" title={t("用当前机位覆盖", "Replace with current camera")} onClick={() => patchKeyframe(keyframe.id, { camera: normalized.camera })}><Aperture size={13} /></button>
                  <button type="button" className="director3d-delete-command" onClick={() => emitChange({ cameraKeyframes: normalized.cameraKeyframes.filter((item) => item.id !== keyframe.id) })}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
            {normalized.cameraKeyframes.length > 1 && (
              <div className="director3d-path-player">
                <input type="range" min={pathStart} max={pathEnd} step="0.01" value={previewTime} onChange={(event) => previewCameraAt(Number(event.target.value))} />
                <div>
                  <button type="button" className="director3d-icon-command director3d-inline-command" onClick={() => setPlayingPath((value) => !value)}>
                    {playingPath ? <Pause size={14} /> : <Play size={14} />}{playingPath ? t("暂停", "Pause") : t("预览", "Preview")}
                  </button>
                  <output>{roundDirectorNumber(previewTime, 2)} s</output>
                  <button type="button" className="director3d-icon-command director3d-inline-command" onClick={applyPreviewCamera}><Check size={14} />{t("应用机位", "Apply")}</button>
                </div>
              </div>
            )}
          </fieldset>

          <fieldset className="director3d-control-group">
            <legend><FieldHeader icon={Lightbulb}>{t("灯光", "Lighting")}</FieldHeader></legend>
            <label className="director3d-select-field">
              <span>{t("布光方案", "Lighting preset")}</span>
              <CanvasRoundedSelect label={t("布光方案", "Lighting preset")} value={normalized.lighting.preset} onChange={(value) => patchLighting({ preset: value })} options={[...(!knownLighting ? [{ value: normalized.lighting.preset, label: normalized.lighting.preset }] : []), ...LIGHTING_OPTIONS.map((option) => ({ value: option.value, label: t(option.zh, option.en) }))]} ui={directorSelectUi} className="min-w-0" triggerClassName="h-[31px] w-full rounded-[5px] px-2 text-[10px]" menuMinWidth={220} />
            </label>
            <RangeField label={t("主光强度", "Key intensity")} value={normalized.lighting.intensity} min={0.1} max={5} step={0.1} unit="" onChange={(intensity) => patchLighting({ intensity })} />
            <RangeField label={t("色温", "Temperature")} value={normalized.lighting.temperature} min={2000} max={10000} step={100} unit=" K" onChange={(temperature) => patchLighting({ temperature })} />
          </fieldset>

          <fieldset className="director3d-control-group">
            <legend><FieldHeader icon={Sun}>{t("时间与背景", "Time and background")}</FieldHeader></legend>
            <label className="director3d-select-field">
              <span>{t("场景时间", "Scene time")}</span>
              <CanvasRoundedSelect label={t("场景时间", "Scene time")} value={normalized.environment.time} onChange={(value) => patchEnvironment({ time: value })} options={[...(!knownTime ? [{ value: normalized.environment.time, label: normalized.environment.time }] : []), ...TIME_OPTIONS.map((option) => ({ value: option.value, label: t(option.zh, option.en) }))]} ui={directorSelectUi} className="min-w-0" triggerClassName="h-[31px] w-full rounded-[5px] px-2 text-[10px]" menuMinWidth={180} />
            </label>
            <label className="director3d-color-field">
              <span>{t("背景色", "Background")}</span>
              <input type="color" value={normalized.environment.background} onChange={(event) => patchEnvironment({ background: event.target.value })} />
              <output>{normalized.environment.background.toUpperCase()}</output>
            </label>
          </fieldset>

          <fieldset className="director3d-control-group director3d-shot-group">
            <legend><FieldHeader icon={Clipboard}>{t("生成镜头参数", "Generation shot")}</FieldHeader></legend>
            <p>{t("该摘要和结构化 shot 会随导演台状态保存，可供图片/视频生成流程读取。", "The prompt and structured shot persist with the director state for image/video generation.")}</p>
            <textarea readOnly value={shotDraft.promptSummary} aria-label={t("镜头提示词摘要", "Shot prompt summary")} />
            <div className="director3d-shot-actions">
              <button type="button" className="director3d-icon-command director3d-inline-command" onClick={() => copyText("prompt", shotDraft.promptSummary)}>
                {copiedValue === "prompt" ? <Check size={14} /> : <Clipboard size={14} />}{t("复制提示词", "Copy prompt")}
              </button>
              <button type="button" className="director3d-icon-command director3d-inline-command" onClick={() => copyText("json", JSON.stringify(shotDraft, null, 2))}>
                {copiedValue === "json" ? <Check size={14} /> : <Download size={14} />}{t("复制 Shot JSON", "Copy shot JSON")}
              </button>
            </div>
          </fieldset>
        </div>
      </div>
    </section>
  );
};

export default Director3DPanel;
