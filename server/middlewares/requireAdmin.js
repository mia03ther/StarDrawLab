/** Database-authoritative administrator guard. Static X-Admin-Key elevation is intentionally removed. */
import { requireAdminOrRoot } from "./authorize.js";

export const requireAdmin = () => requireAdminOrRoot();

export default requireAdmin;
