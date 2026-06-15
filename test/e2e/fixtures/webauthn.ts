import type { CDPSession, Page } from '@playwright/test';

export type AuthenticatorOptions = {
  readonly hasUserVerification?: boolean;
  readonly isUserVerified?: boolean;
  readonly hasPrf?: boolean;
};

export type VirtualAuth = { readonly cdp: CDPSession; readonly authenticatorId: string };

export const enableVirtualAuthenticator = async (
  page: Page,
  options: AuthenticatorOptions = {},
): Promise<VirtualAuth> => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: options.hasUserVerification ?? true,
      isUserVerified: options.isUserVerified ?? true,
      hasPrf: options.hasPrf ?? true,
      automaticPresenceSimulation: true,
    },
  })) as { authenticatorId: string };
  return { cdp, authenticatorId };
};
