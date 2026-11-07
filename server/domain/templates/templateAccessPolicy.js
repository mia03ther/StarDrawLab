export const TEMPLATE_MEMBERSHIP_TIER_RANK = Object.freeze({
  free: 0,
  basic: 1,
  pro: 2,
  max: 3,
  enterprise: 4,
});

export const normalizeMembershipTier = (value) => {
  const tier = String(value || "free").trim().toLowerCase();
  return Object.hasOwn(TEMPLATE_MEMBERSHIP_TIER_RANK, tier) ? tier : "free";
};

export const isTemplateMembershipAllowed = ({ template, userId, membershipTier = "free" } = {}) => {
  if (template?.owner_user_id != null && String(template.owner_user_id) === String(userId)) return true;
  const requiredTier = normalizeMembershipTier(template?.required_membership_tier);
  const actualTier = normalizeMembershipTier(membershipTier);
  return TEMPLATE_MEMBERSHIP_TIER_RANK[actualTier] >= TEMPLATE_MEMBERSHIP_TIER_RANK[requiredTier];
};

export const assertTemplateMembership = ({ template, userId, membershipTier = "free" } = {}) => {
  if (isTemplateMembershipAllowed({ template, userId, membershipTier })) return;
  const requiredTier = normalizeMembershipTier(template?.required_membership_tier);
  throw Object.assign(new Error(`This template requires ${requiredTier} membership or above`), {
    status: 403,
    code: "TEMPLATE_MEMBERSHIP_REQUIRED",
    required_tier: requiredTier,
  });
};
