UPDATE prompt_templates
SET tags = CASE
  WHEN jsonb_typeof(tags) <> 'string' THEN tags
  WHEN trim(tags #>> '{}') = '' THEN '[]'::jsonb
  WHEN left(trim(tags #>> '{}'), 1) = '[' THEN (tags #>> '{}')::jsonb
  ELSE to_jsonb(ARRAY(
    SELECT btrim(part)
    FROM unnest(string_to_array(tags #>> '{}', ',')) AS part
    WHERE btrim(part) <> ''
  ))
END,
updated_at = NOW()
WHERE jsonb_typeof(tags) = 'string';
