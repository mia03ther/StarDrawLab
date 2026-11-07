export const shouldStartAutomaticLogin = ({ isLoading, isSignedIn, isLoggingOut }) => (
  !isLoading && !isSignedIn && !isLoggingOut
);

export const startLogoutRedirect = async ({
  sdk,
  hasSdkLoginState,
  logoutUri,
  replaceLocation,
}) => {
  if (sdk && hasSdkLoginState) {
    try {
      await sdk.logoutWithRedirect({ redirectUri: logoutUri });
      return "provider";
    } catch (error) {
      console.error("Authing logout failed, using local redirect:", error);
    }
  }

  replaceLocation(logoutUri);
  return hasSdkLoginState ? "fallback" : "local";
};
