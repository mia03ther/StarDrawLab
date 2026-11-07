const IMAGE_QUALITIES = new Set(["1k", "2k", "4k"]);

const normalizedText = (value) => String(value ?? "").trim().toLowerCase();

export const normalizeImageQuality = (value, { allowNull = true } = {}) => {
  const normalized = normalizedText(value);
  if (!normalized && allowNull) return null;
  if (!IMAGE_QUALITIES.has(normalized)) return null;
  return normalized;
};

export const inferImageQuality = ({ model, size } = {}) => {
  const modelMatch = normalizedText(model).match(/(?:^|[-_])(1k|2k|4k)$/);
  if (modelMatch) return modelMatch[1];

  const [width, height] = normalizedText(size).split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const longestSide = Math.max(width, height);
  if (longestSide >= 3000) return "4k";
  if (longestSide >= 1500) return "2k";
  return "1k";
};

// Shared SQL expression for template/catalog estimates. Invalid legacy sizes
// deliberately return NULL instead of raising a database cast error.
export const imageQualityFromSizeSql = (db, sizeExpression) => db`
  CASE
    WHEN ${sizeExpression} !~ '^[0-9]+x[0-9]+$' THEN NULL
    WHEN GREATEST(
      CAST(split_part(${sizeExpression}, 'x', 1) AS INTEGER),
      CAST(split_part(${sizeExpression}, 'x', 2) AS INTEGER)
    ) >= 3000 THEN '4k'
    WHEN GREATEST(
      CAST(split_part(${sizeExpression}, 'x', 1) AS INTEGER),
      CAST(split_part(${sizeExpression}, 'x', 2) AS INTEGER)
    ) >= 1500 THEN '2k'
    ELSE '1k'
  END
`;

export const IMAGE_QUALITIES_LIST = Object.freeze(["1k", "2k", "4k"]);
