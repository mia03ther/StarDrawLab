import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const editor = fs.readFileSync(path.join(root, "components/WorkflowEditorPanel.jsx"), "utf8");
const integrated = fs.readFileSync(path.join(root, "components/canvas/IntegratedCanvasWorkflow.jsx"), "utf8");
const runDialog = fs.readFileSync(path.join(root, "components/canvas/WorkflowRunDialog.jsx"), "utf8");
const studio = fs.readFileSync(path.join(root, "pages/CanvasStudio.jsx"), "utf8");

test("workflow loops use a nested visual editor and structured repeat-until controls", () => {
  assert.match(editor, /WorkflowLoopEditorDialog/);
  assert.match(editor, /showRunAction=\{false\}/);
  assert.match(editor, /selectedUntil\.left/);
  assert.match(editor, /selectedUntil\.operator/);
  assert.match(editor, /selectedUntil\.right/);
  assert.doesNotMatch(editor, /循环体工作流 JSON/);
});

test("workflow nodes and media share the same infinite canvas viewport", () => {
  assert.match(studio, /<IntegratedCanvasWorkflow/);
  assert.doesNotMatch(studio, /key: "workflow", icon: "account_tree"/);
  assert.doesNotMatch(studio, /workspaceMode === "workflow"/);
  assert.match(integrated, /viewport\?\.x/);
  assert.match(integrated, /viewport\?\.scale/);
  assert.match(integrated, /finishConnection/);
  assert.match(integrated, /condition\.rule/);
  assert.match(integrated, /WorkflowEditorPanel/);
  assert.match(integrated, /useWorkflowRun/);
  assert.match(integrated, /collectWorkflowCanvasMediaResults/);
  assert.match(studio, /onCanvasResult=\{handleWorkflowCanvasResult\}/);
  assert.match(studio, /mergeWorkflowCanvasMediaElement/);
});

test("workflow editors expose existing canvas images and videos as source nodes", () => {
  assert.match(editor, /canvas\.image/);
  assert.match(editor, /canvas\.video/);
  assert.match(editor, /选择画布素材/);
  assert.match(integrated, /canvasElements/);
  assert.match(integrated, /canvasMedia/);
  assert.match(studio, /canvasElements=\{elements\}/);
});

test("workflow input nodes are directly editable and do not start canvas gestures", () => {
  assert.match(integrated, /data-workflow-node-input/);
  assert.match(integrated, /patchNodeConfig/);
  assert.match(integrated, /value:\s*event\.target\.value/);
  assert.match(integrated, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(editor, /selectedNode\.config\?\.value/);
  assert.doesNotMatch(editor, /selectedDefinition\.kind === "input"[^\n]+selectedNode\.prompt/);
});

test("every canvas workflow node exposes manual movement and targeted editing", () => {
  assert.match(integrated, /data-workflow-node-drag-handle/);
  assert.match(integrated, /startNodeDrag\(event, node\)/);
  assert.match(integrated, /openNodeEditor\(id\)/);
  assert.match(integrated, /onDoubleClick/);
  assert.match(integrated, /initialSelectedNodeId=\{editorTargetNodeId\}/);
  assert.match(editor, /initialSelectedNodeId/);
  assert.match(editor, /setSelectedId\(requested\)/);
});

test("workflow run forms include runtime inputs declared by input nodes", () => {
  assert.match(integrated, /collectWorkflowRunInputDefinitions/);
  assert.match(integrated, /inputDefinitions/);
  assert.match(integrated, /inputs=\{pendingRun\?\.inputDefinitions/);
});

test("workflow run form is rendered above the full editor and isolates canvas gestures", () => {
  assert.match(runDialog, /createPortal/);
  assert.match(runDialog, /z-\[300\]/);
  assert.match(runDialog, /onPointerDown=\{stopPropagation\}/);
  assert.match(runDialog, /onMouseDown=\{stopPropagation\}/);
  assert.match(runDialog, /onTouchStart=\{stopPropagation\}/);
});

test("the full workflow editor owns the top interaction layer instead of sitting under canvas chrome", () => {
  assert.match(integrated, /createPortal/);
  assert.match(integrated, /z-\[280\]/);
  assert.match(integrated, /document\.body/);
  assert.match(integrated, /100dvh/);
});

test("workflow reference images use a private upload control instead of exposing element IDs", () => {
  assert.match(runDialog, /uploadCanvasAsset/);
  assert.match(runDialog, /descriptor\.type === "image"/);
  assert.match(runDialog, /上传参考图/);
  assert.match(runDialog, /upload:\$\{asset\.resourceId\}/);
  assert.doesNotMatch(runDialog, /\["image", "video"\]\.includes\(descriptor\.type\)/);
});
