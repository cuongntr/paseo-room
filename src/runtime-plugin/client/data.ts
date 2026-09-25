/**
 * Panel data access: typed RPC calls plus bounded polling while a view is mounted. This is UI
 * refresh only — it drives no runtime behaviour and is not agent-status polling.
 */
import { useRpc } from '@getpaseo/plugin/client';
import { useEffect, useRef, useState } from 'react';
import {
  runtimeAbandonRpc, runtimeAssignmentRpc, runtimeAssignSupervisorRpc, runtimeHealthRpc, runtimeIncidentFeedbackRpc, runtimeLeaseReclaimRpc,
  runtimeProjectPreflightRpc, runtimeProjectRpc, runtimeQuarantineRpc, runtimeRecoverRpc, runtimeResolveOwnershipRpc, runtimeRoomRpc,
  runtimeAttentionKeyRpc, runtimeAttentionStatusRpc, runtimePeerEffortRpc, runtimeSeatsRpc, runtimeStartProjectRpc, runtimeStartSupervisorRpc, runtimeWorkspaceCloseRpc,
} from '../shared/rpc-contracts.js';

export const POLL_MS = 5_000;

export interface Unwrapped<T> {
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string; readonly recoveryAction: string };
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export function unwrap<T>(answer: unknown): Unwrapped<T> {
  const value = answer as { data?: T; error?: Unwrapped<T>['error']; warnings?: Unwrapped<T>['warnings'] };
  return { ...(value.data === undefined ? {} : { data: value.data }), ...(value.error === undefined ? {} : { error: value.error }), warnings: value.warnings ?? [] };
}

/** Loads now and every `POLL_MS` while mounted; a changed revision is the only re-render trigger. */
export function usePolled<T>(load: () => Promise<unknown>, key: string): { readonly value?: Unwrapped<T>; readonly failed?: string; readonly reload: () => void } {
  const [value, setValue] = useState<Unwrapped<T>>();
  const [failed, setFailed] = useState<string>();
  const [tick, setTick] = useState(0);
  const revision = useRef<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const run = (): void => {
      load().then(answer => {
        if (cancelled) return;
        const next = (answer as { revision?: string }).revision;
        if (next !== undefined && next === revision.current) return;
        revision.current = next;
        setFailed(undefined);
        setValue(unwrap<T>(answer));
      }, (error: unknown) => {
        if (!cancelled) setFailed(error instanceof Error ? error.message : String(error));
      });
    };
    run();
    const timer = setInterval(run, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
    // `load` is recreated each render; `key` names what is polled, so it alone re-subscribes.
  }, [key, tick]);
  return { ...(value === undefined ? {} : { value }), ...(failed === undefined ? {} : { failed }), reload: () => { revision.current = undefined; setTick(tick + 1); } };
}

export function useRuntimeRpcs() {
  return {
    health: useRpc(runtimeHealthRpc),
    project: useRpc(runtimeProjectRpc),
    assignment: useRpc(runtimeAssignmentRpc),
    recover: useRpc(runtimeRecoverRpc),
    abandon: useRpc(runtimeAbandonRpc),
    resolveOwnership: useRpc(runtimeResolveOwnershipRpc),
    quarantine: useRpc(runtimeQuarantineRpc),
    workspaceClose: useRpc(runtimeWorkspaceCloseRpc),
    leaseReclaim: useRpc(runtimeLeaseReclaimRpc),
    seats: useRpc(runtimeSeatsRpc),
    room: useRpc(runtimeRoomRpc),
    startSupervisor: useRpc(runtimeStartSupervisorRpc),
    projectPreflight: useRpc(runtimeProjectPreflightRpc),
    startProject: useRpc(runtimeStartProjectRpc),
    assignSupervisor: useRpc(runtimeAssignSupervisorRpc),
    incidentFeedback: useRpc(runtimeIncidentFeedbackRpc),
    attentionKey: useRpc(runtimeAttentionKeyRpc),
    attentionStatus: useRpc(runtimeAttentionStatusRpc),
    peerEffort: useRpc(runtimePeerEffortRpc),
  };
}

export function idempotencyKey(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
