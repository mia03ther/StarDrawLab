import assert from "node:assert/strict";
import test from "node:test";

import {
  collectWorkflowRunInputDefinitions,
  prepareWorkflowRunFieldDefinitions,
  runtimeInputKeyFromValue,
} from "./workflowInputNodes.js";

test("runtime input expressions become editable run fields", () => {
  const definitions = collectWorkflowRunInputDefinitions({
    nodes: [
      {
        id: "copy_input",
        type: "input",
        title: "输入宣传文案",
        config: { value: "${inputs.copy}" },
      },
      {
        id: "brief_input",
        type: "input",
        title: "输入品牌与版式要求",
        config: { value: "{{ inputs.brief }}", required: false },
      },
      {
        id: "fixed_input",
        type: "input",
        title: "固定内容",
        config: { value: "固定文案" },
      },
    ],
  });

  assert.deepEqual(Object.keys(definitions), ["copy", "brief"]);
  assert.deepEqual(definitions.copy, {
    type: "string",
    label: "输入宣传文案",
    description: "",
    default: null,
    required: true,
  });
  assert.equal(definitions.brief.required, false);
});

test("runtime input keys are strict top-level workflow input names", () => {
  assert.equal(runtimeInputKeyFromValue("${inputs.copy}"), "copy");
  assert.equal(runtimeInputKeyFromValue("{{ inputs.brief }}"), "brief");
  assert.equal(runtimeInputKeyFromValue("${inputs.profile.name}"), "");
  assert.equal(runtimeInputKeyFromValue("ordinary text"), "");
});

test("reference expressions become friendly image upload fields even for legacy ID variables", () => {
  const definition = {
    variables: {
      referenceElementId: {
        type: "string",
        label: "项链参考图元素 ID",
        required: true,
      },
    },
    nodes: [{
      id: "generate_video",
      type: "video.generate",
      config: { referenceExpression: "${variables.referenceElementId}" },
    }],
  };

  const definitions = prepareWorkflowRunFieldDefinitions(
    definition.variables,
    definition,
    "variables",
  );

  assert.equal(definitions.referenceElementId.type, "image");
  assert.equal(definitions.referenceElementId.label, "项链参考图");
  assert.equal(definitions.referenceElementId.required, true);
});

test("reference image input nodes use an image picker instead of a technical text field", () => {
  const definitions = collectWorkflowRunInputDefinitions({
    nodes: [{
      id: "reference_input",
      type: "input",
      title: "上传参考图片",
      config: { value: "${inputs.reference_image}" },
    }],
  });

  assert.equal(definitions.reference_image.type, "image");
  assert.equal(definitions.reference_image.label, "上传参考图片");
});

test("image input nodes without a value still expose a runtime upload field", () => {
  const definitions = collectWorkflowRunInputDefinitions({
    nodes: [{
      id: "reference_image",
      type: "input",
      title: "首饰参考图",
      config: {
        label: "首饰参考图",
        inputType: "image",
        required: true,
        description: "上传首饰产品图片",
      },
    }],
  });

  assert.deepEqual(definitions.reference_image, {
    type: "image",
    label: "首饰参考图",
    description: "上传首饰产品图片",
    default: null,
    required: true,
  });
});
