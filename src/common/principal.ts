export const Role = { STUDENT: 'STUDENT', STAFF: 'STAFF' } as const;
export type Role = (typeof Role)[keyof typeof Role];
export class Principal { constructor(readonly userId: string, readonly role: Role) {} }
