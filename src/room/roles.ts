import { z } from 'zod';

export const ROOM_ROLES = ['supervisor', 'lead', 'peer'] as const;
export const roomRoleSchema = z.enum(ROOM_ROLES);
export type RoomRole = z.infer<typeof roomRoleSchema>;
export const MANAGED_PROVIDER_IDS = ['codex-supervisor', 'codex-lead', 'codex-peer'] as const;
export const managedProviderIdSchema = z.enum(MANAGED_PROVIDER_IDS);
export type ManagedProviderId = z.infer<typeof managedProviderIdSchema>;
export const MANAGED_PROVIDER_BY_ROLE = {
  supervisor: 'codex-supervisor', lead: 'codex-lead', peer: 'codex-peer',
} as const satisfies Record<RoomRole, ManagedProviderId>;
export const ROLE_PASEO_TOOLS = {
  supervisor: true, lead: true, peer: false,
} as const satisfies Record<RoomRole, boolean>;
