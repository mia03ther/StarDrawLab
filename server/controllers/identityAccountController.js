import logger from "../configs/logger.js";
import {
  changeIdentityPassword,
  getIdentityAccount,
  identityAccountSupported,
  updateIdentityAccount,
} from "../services/identityAccountService.js";
import { syncUserIdentityProfile } from "../services/identityLinkService.js";

const fail = (res, error, fallback) => res.status(error.status || 500).json({
  success: false,
  code: error.code || "IDENTITY_ACCOUNT_FAILED",
  message: error.status ? error.message : fallback,
});

const syncExternalProfile = async (req, profile) => {
  if (!profile || typeof profile !== "object") return;
  await syncUserIdentityProfile({
    userId: req.auth.userId,
    username: profile.username || profile.preferred_username,
    email: profile.email,
    emailVerified: profile.emailVerified === true || profile.email_verified === true,
    phoneNumber: profile.phone_number || profile.phone,
    fullName: profile.name || profile.full_name || profile.fullname,
    gender: profile.gender,
    birthdate: profile.birthdate,
  });
};

export const getIdentityAccountController = async (req, res) => {
  try {
    if (!identityAccountSupported()) {
      return res.json({ success: true, data: { available: false, status: "not_configured", provider: req.auth.identityProvider || null } });
    }
    const data = await getIdentityAccount({
      accessToken: req.authToken,
      accountAccessToken: req.identityAccountAccessToken,
    });
    await syncExternalProfile(req, data.profile);
    return res.json({ success: true, data });
  } catch (error) {
    logger.warn("identity.account.read.failed", { userId: req.auth.userId, code: error.code, error: error.message });
    return fail(res, error, "Unable to load account settings");
  }
};

export const updateIdentityAccountController = async (req, res) => {
  try {
    const data = await updateIdentityAccount({
      accessToken: req.authToken,
      accountAccessToken: req.identityAccountAccessToken,
      profile: req.body,
    });
    await syncExternalProfile(req, data);
    return res.json({ success: true, data: { available: true, status: "connected", provider: req.auth.identityProvider || null, profile: data } });
  } catch (error) {
    logger.warn("identity.account.update.failed", { userId: req.auth.userId, code: error.code, error: error.message });
    return fail(res, error, "Unable to update account profile");
  }
};

export const changeIdentityPasswordController = async (req, res) => {
  try {
    const data = await changeIdentityPassword({
      accessToken: req.authToken,
      accountAccessToken: req.identityAccountAccessToken,
      currentPassword: req.body?.current_password,
      newPassword: req.body?.new_password,
    });
    return res.json({ success: true, data });
  } catch (error) {
    logger.warn("identity.account.password.failed", { userId: req.auth.userId, code: error.code, error: error.message });
    return fail(res, error, "Unable to update account password");
  }
};
