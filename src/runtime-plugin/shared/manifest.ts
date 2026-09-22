/**
 * The generated room manifest (docs/design/runtime-coordination.md §3.2): the only bridge from
 * provisioning evidence to runtime recognition. Setup is its only writer; the plugin refuses
 * anything missing, broader than the policy projection, or keyed by a non-exact provider id.
 */
import { z } from 'zod';
import {
  PEER_REPORTING_TOOLS, RUNTIME_AGENTS, RUNTIME_CAPABILITIES, RUNTIME_ROLES, runtimeRolePolicy,
} from './policy.js';

export const MANIFEST_FILE = 'generated/room-manifest.json';

const generation = z.string().min(1).max(256);

const peerReportingSchema = z.strictObject({
  protocol: z.literal(1),
  tools: z.tuple([z.literal(PEER_REPORTING_TOOLS[0]), z.literal(PEER_REPORTING_TOOLS[1])]),
  qualifiedVia: z.literal('exact-room-provider'),
});

const providerSchema = z.strictObject({
  agent: z.enum(RUNTIME_AGENTS),
  role: z.enum(RUNTIME_ROLES),
  capabilities: z.array(z.enum(RUNTIME_CAPABILITIES as [string, ...string[]])),
  peerReporting: peerReportingSchema.optional(),
}).superRefine((entry, context) => {
  // A declaration is valid only when it is exactly the projection for its role: never broader,
  // never a Peer operation outside the closed tuple, never reporting on a non-Peer seat.
  const eligible = entry.role === 'peer' && entry.peerReporting !== undefined;
  const expected = runtimeRolePolicy(entry.role, eligible);
  if (JSON.stringify(entry.capabilities) !== JSON.stringify(expected.capabilities)) {
    context.addIssue({ code: 'custom', message: `capabilities do not match the ${entry.role} runtime policy` });
  }
  if (entry.peerReporting !== undefined && entry.role !== 'peer') {
    context.addIssue({ code: 'custom', message: 'peerReporting is only valid on a Peer entry' });
  }
});

/** Exact provider ids only: a runtime never matches by prefix, label, title or cwd. */
const providerId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(128);

export const runtimeRoomManifestSchema = z.strictObject({
  schema: z.literal(1),
  roomGeneration: generation,
  contractGeneration: generation,
  reportingPolicyGeneration: generation,
  providers: z.record(providerId, providerSchema),
});

export type RuntimeRoomManifestV1 = z.infer<typeof runtimeRoomManifestSchema>;
export type RuntimeManifestProvider = RuntimeRoomManifestV1['providers'][string];
