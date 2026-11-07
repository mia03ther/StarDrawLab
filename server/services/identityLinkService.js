import sql from "../configs/db.js";
import { normalizeEmailAddress } from "../infrastructure/identityEmailPolicy.js";

const enabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
export const identityLinksEnabled = () => enabled(process.env.IDENTITY_LINKS_ENABLED);

const IDENTITY_PROFILE_HYDRATION_INTERVAL_MS = 10 * 60 * 1000;
const identityProfileHydrationAttempts = new Map();

const invalid = (message, code = "IDENTITY_LINK_INVALID", status = 400) => Object.assign(new Error(message), { code, status });

const normalizeValue = (value, name, maxLength = 512) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) throw invalid(`${name} is invalid`);
  return normalized;
};

const normalizeOptionalValue = (value, maxLength) => {
  const normalized = String(value || "").trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
};

/**
 * OIDC access tokens do not consistently include the provider's complete
 * profile. Claim one short-lived hydration attempt when username is absent;
 * the successful Account API response then becomes the local directory source
 * used by root/admin user views.
 */
export const shouldHydrateIdentityProfile = ({ userId, claims = {}, now = Date.now() } = {}) => {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId || claims?.username || claims?.preferred_username) return false;

  const lastAttempt = identityProfileHydrationAttempts.get(normalizedUserId);
  if (lastAttempt && now - lastAttempt < IDENTITY_PROFILE_HYDRATION_INTERVAL_MS) return false;

  identityProfileHydrationAttempts.set(normalizedUserId, now);
  if (identityProfileHydrationAttempts.size > 5000) {
    const oldest = identityProfileHydrationAttempts.keys().next().value;
    if (oldest) identityProfileHydrationAttempts.delete(oldest);
  }
  return true;
};

/**
 * Resolve an external OIDC subject to the stable StarDraw user id.
 * This path is disabled until identity_links has been migrated and populated.
 */
export const resolveIdentityUserId = async ({
  provider,
  issuer,
  subject,
  email,
  emailVerified = false,
  username,
  phoneNumber,
  db = sql,
} = {}) => {
  const normalizedSubject = normalizeValue(subject, "subject", 255);
  if (!identityLinksEnabled()) return normalizedSubject;

  const normalizedProvider = normalizeValue(provider, "provider", 64);
  const normalizedIssuer = normalizeValue(issuer, "issuer", 512);
  const normalizedEmail = normalizeEmailAddress(email);
  const normalizedUsername = normalizeOptionalValue(username, 128);
  const normalizedPhoneNumber = normalizeOptionalValue(phoneNumber, 64);

  const [existing] = await db`
    SELECT stardraw_user_id
    FROM identity_links
    WHERE provider = ${normalizedProvider}
      AND issuer = ${normalizedIssuer}
      AND subject = ${normalizedSubject}
    LIMIT 1
  `;
  if (existing?.stardraw_user_id) {
    await db`
      UPDATE identity_links
      SET email = COALESCE(NULLIF(${normalizedEmail}, ''), email),
          email_verified_at = CASE WHEN ${Boolean(emailVerified)} THEN COALESCE(email_verified_at, NOW()) ELSE email_verified_at END,
          username = COALESCE(NULLIF(${normalizedUsername || ''}, ''), username),
          phone_number = COALESCE(NULLIF(${normalizedPhoneNumber || ''}, ''), phone_number),
          last_seen_at = NOW(), updated_at = NOW()
      WHERE provider = ${normalizedProvider}
        AND issuer = ${normalizedIssuer}
        AND subject = ${normalizedSubject}
    `;
    return existing.stardraw_user_id;
  }

  let stardrawUserId = normalizedSubject;
  if (emailVerified && normalizedEmail) {
    const matches = await db`
      SELECT DISTINCT stardraw_user_id
      FROM identity_links
      WHERE LOWER(email) = ${normalizedEmail}
        AND email_verified_at IS NOT NULL
      LIMIT 2
    `;
    if (matches.length > 1) {
      throw invalid(
        "Multiple StarDraw accounts match this verified email; manual account linking is required",
        "IDENTITY_LINK_AMBIGUOUS",
        409,
      );
    }
    if (matches.length === 1) stardrawUserId = matches[0].stardraw_user_id;
  }

  const [link] = await db`
    INSERT INTO identity_links
      (provider, issuer, subject, stardraw_user_id, email, email_verified_at, last_seen_at, username, phone_number)
    VALUES
      (${normalizedProvider}, ${normalizedIssuer}, ${normalizedSubject}, ${stardrawUserId},
       NULLIF(${normalizedEmail}, ''), CASE WHEN ${Boolean(emailVerified)} THEN NOW() ELSE NULL END, NOW(),
       NULLIF(${normalizedUsername || ''}, ''), NULLIF(${normalizedPhoneNumber || ''}, ''))
    ON CONFLICT (provider, issuer, subject)
    DO UPDATE SET last_seen_at = NOW(), updated_at = NOW()
    RETURNING stardraw_user_id
  `;
  return link?.stardraw_user_id || stardrawUserId;
};

const normalizeBirthdate = (value) => {
  const normalized = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return normalized;
};

export const syncUserIdentityProfile = async ({
  userId,
  username,
  email,
  emailVerified = false,
  phoneNumber,
  fullName,
  gender,
  birthdate,
  db = sql,
} = {}) => {
  const normalizedUserId = normalizeValue(userId, "userId", 255);
  const normalizedUsername = normalizeOptionalValue(username, 128);
  const normalizedEmail = normalizeEmailAddress(email);
  const normalizedPhoneNumber = normalizeOptionalValue(phoneNumber, 64);
  const normalizedFullName = normalizeOptionalValue(fullName, 120);
  const normalizedGender = normalizeOptionalValue(gender, 32);
  const normalizedBirthdate = normalizeBirthdate(birthdate);

  // Identity-owned fields are refreshed on every successful login. This keeps
  // the admin user view current without requiring a manual profile save.
  if (normalizedUsername || normalizedEmail || normalizedPhoneNumber) {
    await db`
      UPDATE identity_links
      SET username = COALESCE(NULLIF(${normalizedUsername || ""}, ''), username),
          email = COALESCE(NULLIF(${normalizedEmail}, ''), email),
          email_verified_at = CASE WHEN ${Boolean(emailVerified)} THEN COALESCE(email_verified_at, NOW()) ELSE email_verified_at END,
          phone_number = COALESCE(NULLIF(${normalizedPhoneNumber || ""}, ''), phone_number),
          last_seen_at = NOW(), updated_at = NOW()
      WHERE stardraw_user_id = ${normalizedUserId}
    `;
  }

  if (!normalizedFullName && !normalizedGender && !normalizedBirthdate) return null;

  const [profile] = await db`
    INSERT INTO user_profiles (user_id, full_name, gender, birthdate)
    VALUES (${normalizedUserId}, ${normalizedFullName}, ${normalizedGender}, ${normalizedBirthdate})
    ON CONFLICT (user_id) DO UPDATE
    SET full_name = COALESCE(EXCLUDED.full_name, user_profiles.full_name),
        gender = COALESCE(EXCLUDED.gender, user_profiles.gender),
        birthdate = COALESCE(EXCLUDED.birthdate, user_profiles.birthdate),
        updated_at = CURRENT_TIMESTAMP
    RETURNING user_id, full_name, gender, birthdate
  `;
  return profile || null;
};
