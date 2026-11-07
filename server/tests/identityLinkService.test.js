import assert from "node:assert/strict";
import test from "node:test";

const makeDb = ({ existingLink = null, emailMatches = [], insertedUserId = null } = {}) => {
  const calls = [];
  const db = async (strings, ...values) => {
    const query = strings.join(" ").replace(/\s+/g, " ").trim();
    calls.push({ query, values });

    if (query.startsWith("SELECT stardraw_user_id FROM identity_links")) {
      return existingLink ? [existingLink] : [];
    }
    if (query.startsWith("UPDATE identity_links SET")) return [];
    if (query.startsWith("SELECT DISTINCT stardraw_user_id FROM identity_links")) {
      return emailMatches.map((stardrawUserId) => ({ stardraw_user_id: stardrawUserId }));
    }
    if (query.startsWith("INSERT INTO identity_links")) {
      return [{ stardraw_user_id: insertedUserId || "new-subject" }];
    }
    throw new Error(`Unexpected SQL in identity link test: ${query}`);
  };
  return { db, calls };
};

process.env.IDENTITY_LINKS_ENABLED = "true";
process.env.LOG_DIR = "/tmp/stardraw-identity-link-test-logs";
const {
  resolveIdentityUserId,
  syncUserIdentityProfile,
  shouldHydrateIdentityProfile,
} = await import("../services/identityLinkService.js");

test("mapped Logto subject resolves to the stable StarDraw user id", async () => {
  const { db, calls } = makeDb({ existingLink: { stardraw_user_id: "6a26e9b213cdd467d5dcbc75" } });

  const userId = await resolveIdentityUserId({
    provider: "oidc",
    issuer: "https://auth.stardrawai.com/oidc",
    subject: "uw8yowg8tevj",
    email: "Admin@Example.com",
    emailVerified: true,
    db,
  });

  assert.equal(userId, "6a26e9b213cdd467d5dcbc75");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].values[0], "oidc");
  assert.equal(calls[0].values[1], "https://auth.stardrawai.com/oidc");
  assert.equal(calls[0].values[2], "uw8yowg8tevj");
  assert.equal(calls[1].values[0], "admin@example.com");
  assert.equal(calls[1].values[1], true);
});

test("a verified unique email can bind a new Logto subject to an existing account", async () => {
  const { db, calls } = makeDb({
    emailMatches: ["6a26e9b213cdd467d5dcbc75"],
    insertedUserId: "6a26e9b213cdd467d5dcbc75",
  });

  const userId = await resolveIdentityUserId({
    provider: "oidc",
    issuer: "https://auth.stardrawai.com/oidc",
    subject: "new-logto-subject",
    email: " Admin@Example.com ",
    emailVerified: true,
    db,
  });

  assert.equal(userId, "6a26e9b213cdd467d5dcbc75");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].values[0], "admin@example.com");
  assert.equal(calls[2].values[3], "6a26e9b213cdd467d5dcbc75");
});

test("an unverified email cannot bind a new Logto subject to an existing account", async () => {
  const { db, calls } = makeDb({
    emailMatches: ["6a26e9b213cdd467d5dcbc75"],
    insertedUserId: "unverified-logto-subject",
  });

  const userId = await resolveIdentityUserId({
    provider: "oidc",
    issuer: "https://auth.stardrawai.com/oidc",
    subject: "unverified-logto-subject",
    email: "admin@example.com",
    emailVerified: false,
    db,
  });

  assert.equal(userId, "unverified-logto-subject");
  assert.equal(calls.length, 2);
  assert.match(calls[1].query, /INSERT INTO identity_links/);
});

test("ambiguous verified email fails closed instead of selecting an account", async () => {
  const { db } = makeDb({ emailMatches: ["account-a", "account-b"] });

  await assert.rejects(
    () => resolveIdentityUserId({
      provider: "oidc",
      issuer: "https://auth.stardrawai.com/oidc",
      subject: "ambiguous-logto-subject",
      email: "admin@example.com",
      emailVerified: true,
      db,
    }),
    (error) => error.code === "IDENTITY_LINK_AMBIGUOUS" && error.status === 409,
  );
});

test("identity profile sync persists username and identity fields without a manual save", async () => {
  const calls = [];
  const db = async (strings, ...values) => {
    const query = strings.join(" ").replace(/\s+/g, " ").trim();
    calls.push({ query, values });
    if (query.startsWith("UPDATE identity_links SET")) return [];
    if (query.startsWith("INSERT INTO user_profiles")) return [{
      user_id: "stable-user",
      full_name: "Alice Example",
      gender: "female",
      birthdate: "1990-01-01",
    }];
    throw new Error(`Unexpected SQL in identity profile test: ${query}`);
  };

  const profile = await syncUserIdentityProfile({
    userId: "stable-user",
    username: "alice",
    email: "Alice@example.com",
    emailVerified: true,
    phoneNumber: "+8613800000000",
    fullName: "Alice Example",
    gender: "female",
    birthdate: "1990-01-01",
    db,
  });

  assert.equal(profile.full_name, "Alice Example");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].values[0], "alice");
  assert.equal(calls[0].values[1], "alice@example.com");
  assert.equal(calls[0].values[2], true);
  assert.equal(calls[0].values[3], "+8613800000000");
  assert.equal(calls[0].values[4], "stable-user");
});

test("identity hydration is requested once per user when login claims omit profile fields", () => {
  const now = Date.now();
  assert.equal(shouldHydrateIdentityProfile({ userId: "hydrate-user", claims: {}, now }), true);
  assert.equal(shouldHydrateIdentityProfile({ userId: "hydrate-user", claims: {}, now: now + 1_000 }), false);
  assert.equal(shouldHydrateIdentityProfile({ userId: "hydrate-user", claims: { username: "alice" }, now: now + 1_000 }), false);
  assert.equal(shouldHydrateIdentityProfile({ userId: "hydrate-user", claims: {}, now: now + 10 * 60 * 1000 + 1 }), true);
});
