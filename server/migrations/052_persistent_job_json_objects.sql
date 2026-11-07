-- Normalize legacy double-encoded durable job JSON and prevent recurrence.
-- Application startup never applies migrations.

BEGIN;

UPDATE persistent_jobs
SET payload = CASE
      WHEN jsonb_typeof(payload) = 'string' THEN (payload #>> '{}')::jsonb
      ELSE payload
    END,
    input_refs = CASE
      WHEN jsonb_typeof(input_refs) = 'string' THEN (input_refs #>> '{}')::jsonb
      ELSE input_refs
    END,
    metadata = CASE
      WHEN jsonb_typeof(metadata) = 'string' THEN (metadata #>> '{}')::jsonb
      ELSE metadata
    END,
    result_snapshot = CASE
      WHEN result_snapshot IS NOT NULL AND jsonb_typeof(result_snapshot) = 'string'
        THEN (result_snapshot #>> '{}')::jsonb
      ELSE result_snapshot
    END,
    updated_at = NOW()
WHERE jsonb_typeof(payload) = 'string'
   OR jsonb_typeof(input_refs) = 'string'
   OR jsonb_typeof(metadata) = 'string'
   OR (result_snapshot IS NOT NULL AND jsonb_typeof(result_snapshot) = 'string');

ALTER TABLE persistent_jobs
  ADD CONSTRAINT persistent_jobs_payload_object_check
    CHECK (jsonb_typeof(payload) = 'object') NOT VALID,
  ADD CONSTRAINT persistent_jobs_input_refs_array_check
    CHECK (jsonb_typeof(input_refs) = 'array') NOT VALID,
  ADD CONSTRAINT persistent_jobs_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object') NOT VALID;

ALTER TABLE persistent_jobs VALIDATE CONSTRAINT persistent_jobs_payload_object_check;
ALTER TABLE persistent_jobs VALIDATE CONSTRAINT persistent_jobs_input_refs_array_check;
ALTER TABLE persistent_jobs VALIDATE CONSTRAINT persistent_jobs_metadata_object_check;

COMMIT;
