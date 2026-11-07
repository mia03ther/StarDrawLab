#!/usr/bin/env bash
set -euo pipefail

postgres_container="${POSTGRES_CONTAINER:-stardraw-postgres}"
backup_dir="${BACKUP_DIR:-/opt/stardraw/backups}"
timestamp="$(date +%Y%m%d_%H%M%S)"
backup_name="stardraw_${timestamp}.dump"
container_file="/tmp/${backup_name}"
host_file="${backup_dir}/${backup_name}"

if [[ "${backup_dir}" != /* ]] || [[ "${backup_dir}" == "/" ]]; then
  echo "BACKUP_DIR must be a specific absolute directory" >&2
  exit 1
fi
if ! docker inspect "${postgres_container}" >/dev/null 2>&1; then
  echo "PostgreSQL container was not found: ${postgres_container}" >&2
  exit 1
fi

umask 077
mkdir -p "${backup_dir}"

cleanup() {
  docker exec "${postgres_container}" rm -f "${container_file}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker exec "${postgres_container}" sh -lc \
  "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" --format=custom --file='${container_file}'"

# Validate with the PostgreSQL 16 pg_restore bundled in the database container,
# not an older host client that may reject the custom archive format.
docker exec "${postgres_container}" pg_restore --list "${container_file}" >/dev/null
docker cp "${postgres_container}:${container_file}" "${host_file}" >/dev/null
chmod 600 "${host_file}"
sha256sum "${host_file}" > "${host_file}.sha256"
chmod 600 "${host_file}.sha256"

echo "Backup created and verified: ${host_file}"
echo "Checksum: ${host_file}.sha256"
