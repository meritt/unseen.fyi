export type Role = 'initiator' | 'joiner';

export const ROLE_INITIATOR = 0x01;
export const ROLE_JOINER = 0x02;

const BYTE_BY_ROLE: Readonly<Record<Role, number>> = {
  initiator: ROLE_INITIATOR,
  joiner: ROLE_JOINER,
};

const ROLE_BY_BYTE: Readonly<Record<number, Role>> = {
  [ROLE_INITIATOR]: 'initiator',
  [ROLE_JOINER]: 'joiner',
};

export const roleToByte = (role: Role): number => BYTE_BY_ROLE[role];

export const byteToRole = (byte: number): Role | undefined => ROLE_BY_BYTE[byte];
