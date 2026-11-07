import assert from "node:assert/strict";
import test from "node:test";

import { resolveDatabaseSsl } from "../configs/databaseSecurity.js";

test("database TLS verifies certificates by default and supports private-network plaintext explicitly", () => {
  assert.deepEqual(resolveDatabaseSsl({}), { rejectUnauthorized: true });
  assert.equal(resolveDatabaseSsl({ DB_SSL: "false" }), false);
  assert.deepEqual(resolveDatabaseSsl({ DB_SSL: "true", DB_SSL_CA: "trusted-ca" }), {
    rejectUnauthorized: true,
    ca: "trusted-ca",
  });
  assert.deepEqual(resolveDatabaseSsl({ DB_SSL: "true", DB_SSL_VERIFY: "false" }), {
    rejectUnauthorized: false,
  });
  assert.throws(() => resolveDatabaseSsl({ DB_SSL: "maybe" }), (error) => error.code === "INVALID_DATABASE_TLS_CONFIGURATION");
});
