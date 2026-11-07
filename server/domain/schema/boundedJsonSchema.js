const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const deepEqual = (left, right) => {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
};

const schemaError = (message, path, options) => Object.assign(
  new Error(`${options.messagePrefix || "Input schema validation failed"}: ${message} at ${path}`),
  {
    status: 400,
    code: options.code || "INPUT_SCHEMA_INVALID",
    path,
    ...(options.toolKey ? { toolKey: options.toolKey } : {}),
  },
);

/** Validate the deliberately bounded JSON-Schema subset used by tool ports. */
export const validateBoundedJsonSchema = (value, schema, options = {}, path = "$") => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return value;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    throw schemaError("value is not one of the allowed enum values", path, options);
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.some((candidate) => {
      try {
        validateBoundedJsonSchema(value, candidate, options, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!matched) throw schemaError("value does not match any allowed schema", path, options);
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0) {
    const matched = types.some((type) => (
      (type === "object" && isObject(value))
      || (type === "array" && Array.isArray(value))
      || (type === "string" && typeof value === "string")
      || (type === "number" && typeof value === "number" && Number.isFinite(value))
      || (type === "integer" && Number.isSafeInteger(value))
      || (type === "boolean" && typeof value === "boolean")
      || (type === "null" && value === null)
    ));
    if (!matched) throw schemaError(`expected ${types.join(" or ")}`, path, options);
  }

  if (typeof value === "string") {
    if (schema.minLength != null && value.length < Number(schema.minLength)) {
      throw schemaError("string is too short", path, options);
    }
    if (schema.maxLength != null && value.length > Number(schema.maxLength)) {
      throw schemaError("string is too long", path, options);
    }
    if (schema.pattern != null) {
      let pattern;
      try {
        pattern = new RegExp(String(schema.pattern));
      } catch {
        throw schemaError("schema pattern is invalid", path, options);
      }
      if (!pattern.test(value)) throw schemaError("string does not match the required pattern", path, options);
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum != null && value < Number(schema.minimum)) {
      throw schemaError("number is below the minimum", path, options);
    }
    if (schema.maximum != null && value > Number(schema.maximum)) {
      throw schemaError("number is above the maximum", path, options);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < Number(schema.minItems)) {
      throw schemaError("array has too few items", path, options);
    }
    if (schema.maxItems != null && value.length > Number(schema.maxItems)) {
      throw schemaError("array has too many items", path, options);
    }
    if (schema.items) {
      value.forEach((item, index) => validateBoundedJsonSchema(item, schema.items, options, `${path}[${index}]`));
    }
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key !== "string" || !Object.hasOwn(value, key)) {
        throw schemaError(`missing required property ${String(key)}`, path, options);
      }
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unknown) throw schemaError(`unknown property ${unknown}`, path, options);
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        validateBoundedJsonSchema(value[key], childSchema, options, `${path}.${key}`);
      }
    }
  }
  return value;
};
