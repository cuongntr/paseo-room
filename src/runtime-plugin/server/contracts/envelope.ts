/**
 * The bridge transport envelope (docs/design/runtime-coordination.md §3.4). The bridge process
 * fills it; a Peer's tool input is only `payload` and never carries identity. `capability` is
 * the opaque binding the bridge reads at call time; the server resolves everything else.
 */
import { z } from 'zod';

export const BRIDGE_PROTOCOL = 1;

export const bridgeRequestSchema = z.strictObject({
  protocol: z.literal(BRIDGE_PROTOCOL),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  operation: z.string().min(1).max(64),
  payload: z.unknown(),
  correlation: z.string().min(1).max(512),
  capability: z.string().min(1).max(512).optional(),
});
export type BridgeRequestV1 = z.infer<typeof bridgeRequestSchema>;

export const bridgeReplySchema = z.strictObject({
  protocol: z.literal(BRIDGE_PROTOCOL),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  ok: z.boolean(),
  result: z.unknown(),
});
export type BridgeReplyV1 = z.infer<typeof bridgeReplySchema>;
