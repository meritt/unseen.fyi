export const isPrfCapable = async (): Promise<boolean> => {
  if (!('PublicKeyCredential' in globalThis)) {
    return false;
  }
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
};
