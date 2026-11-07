import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDirectorShot,
  interpolateDirectorCamera,
  normalizeDirectorState,
  packDirectorEnvironment,
  packDirectorLighting,
} from "./director3dState.js";

test("normalizes legacy director state and creates the default placeholder", () => {
  const state = normalizeDirectorState({
    enabled: true,
    scene: "product",
    camera: { position: { x: 0, y: 0, z: 0 } },
    lighting: "dramatic|i=2.5|k=4200",
    environment: "night|bg=%23010203",
  });
  assert.deepEqual(state.camera.position, { x: 6, y: 3.5, z: 8 });
  assert.equal(state.objects[0].source.kind, "product");
  assert.deepEqual(state.lighting, { preset: "dramatic", intensity: 2.5, temperature: 4200 });
  assert.deepEqual(state.environment, { time: "night", background: "#010203" });
});

test("packs persisted lighting and environment fields compatibly", () => {
  assert.equal(packDirectorLighting({ preset: "soft", intensity: 1.234, temperature: 5301 }), "soft|i=1.23|k=5301");
  assert.equal(packDirectorEnvironment({ time: "dawn", background: "#112233" }), "dawn|bg=%23112233");
});

test("interpolates camera positions and uses the shortest rotation path", () => {
  const camera = interpolateDirectorCamera([
    {
      time: 0,
      camera: {
        position: { x: 0, y: 1, z: 10 },
        rotation: { x: 0, y: 170, z: 0 },
        focalLength: 35,
      },
    },
    {
      time: 4,
      camera: {
        position: { x: 8, y: 5, z: 2 },
        rotation: { x: 20, y: -170, z: 0 },
        focalLength: 85,
      },
    },
  ], 2);
  assert.deepEqual(camera.position, { x: 4, y: 3, z: 6 });
  assert.equal(camera.rotation.y, 180);
  assert.equal(camera.focalLength, 60);
});

test("exports a serializable generation shot without local object URLs", () => {
  const shot = buildDirectorShot({
    enabled: true,
    objects: [{
      id: "asset-1",
      name: "Hero ship",
      source: {
        type: "local",
        fileName: "ship.glb",
        mimeType: "model/gltf-binary",
        objectUrl: "blob:https://example.invalid/secret",
      },
      transform: {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 45, z: 0 },
        scale: { x: 2, y: 2, z: 2 },
      },
    }],
    cameraKeyframes: [
      { time: 0, camera: { position: { x: 0, y: 2, z: 8 } } },
      { time: 3, camera: { position: { x: 3, y: 2, z: 6 } } },
    ],
  });
  assert.equal(shot.type, "director3d-shot");
  assert.equal(shot.objects[0].source.fileName, "ship.glb");
  assert.equal("objectUrl" in shot.objects[0].source, false);
  assert.equal(shot.cameraPath.length, 2);
  assert.match(shot.promptSummary, /Hero ship/);
  assert.doesNotMatch(JSON.stringify(shot), /blob:/);
});
