#!/usr/bin/env bash
set -euo pipefail

api_container="${API_CONTAINER:-quickai_api}"
required_migration_version="${REQUIRED_MIGRATION_VERSION:-63}"

if docker inspect "${api_container}" >/dev/null 2>&1 \
  && [[ "$(docker inspect -f '{{.State.Running}}' "${api_container}")" == "true" ]]; then
  REQUIRED_MIGRATION_VERSION="${required_migration_version}" \
    docker exec "${api_container}" wget -qO- http://127.0.0.1:5000/ready \
    | node -e '
      let body = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => {
        const data = JSON.parse(body);
        const required = Number(process.env.REQUIRED_MIGRATION_VERSION || 63);
        if (data.status !== "ready" || Number(data.database?.migration) < required) process.exit(1);
        console.log(`Database ready: migration capability ${data.database.migration}`);
      });
    '
  exit 0
fi

node scripts/checkReleaseDatabase.js
