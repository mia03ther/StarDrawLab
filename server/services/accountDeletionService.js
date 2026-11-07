// Account deletion is intentionally disabled. Product deletion semantics are
// content-only and are implemented by contentRecycleService. These exports are
// retained as fail-closed compatibility shims so an old route cannot erase an
// identity, points, orders, payments or subscriptions if accidentally mounted.

const disabled = () => {
  throw Object.assign(new Error("Account deletion is not supported; delete individual content instead"), {
    status: 410,
    code: "ACCOUNT_DELETION_DISABLED",
  });
};

export const getDeletionStatus = async () => ({
  enabled: false,
  policy: "content_only",
});

export const requestAccountDeletion = async () => disabled();
export const restoreAccount = async () => disabled();
export const purgeExpiredAccounts = async () => ({ scanned: 0, purged: 0, disabled: true });
