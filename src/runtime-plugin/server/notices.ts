/**
 * Deterministic notices (docs/design/runtime-coordination.md D9, §4.4).
 *
 * Audience comes from code, never from a model: assignment-local evidence goes to that
 * assignment's Lead, a page goes to the authority recipient, operator faults go to status and
 * the panel. A Peer is never a recipient. Every notice carries a stable id in its delivered
 * text; delivery is at least once, a retry reuses the id, and a retry first checks the
 * recipient's timeline so a confirmed delivery is not sent twice.
 *
 * A notice never interrupts (docs/design/runtime-coordination-attention.md §7.4): it is sent with
 * `steer`, so a running recipient receives it inside its turn. Paseo clears every pending
 * permission of an agent it sends to, so a recipient holding one is not sent to at all: the notice
 * stays pending and `retryFor` delivers it when that permission resolves or the turn ends.
 */
import { randomBytes } from 'node:crypto';
import type { Controller, LoadedProject } from './controller.js';
import { ProjectStore } from './store/project.js';

export type NoticeClass = 'record' | 'owner' | 'operator' | 'page';
export type NoticeDisposition = 'record' | 'panel' | 'lead-now' | 'supervisor-digest' | 'supervisor-now' | 'operator-now' | 'human-required';

export interface NoticeRequest {
  readonly kind: string;
  readonly class: NoticeClass;
  readonly disposition: NoticeDisposition;
  readonly text: string;
  readonly assignmentId?: string;
  /** A Supervisor or Lead agent; omitted for notices shown only on status and the panel. */
  readonly recipient?: { readonly agentId: string; readonly role: 'supervisor' | 'lead' };
}

const plugin = { source: 'plugin' as const };

export function noticeText(noticeId: string, text: string): string {
  return `[paseo-room notice ${noticeId}] ${text}`;
}

export class Notices {
  constructor(private readonly controller: Controller) {}

  /** Records the notice, then delivers it when it has a recipient. Call inside the project's queue. */
  async notify(loaded: LoadedProject, request: NoticeRequest): Promise<string> {
    const recipient = request.recipient;
    const noticeId = `ntc_${randomBytes(9).toString('base64url')}`;
    await this.controller.append(loaded, {
      type: 'notice.pending', payloadVersion: 1, actor: plugin,
      ...(request.assignmentId === undefined ? {} : { assignmentId: request.assignmentId }),
      data: {
        noticeId, kind: request.kind, class: request.class, disposition: request.disposition, text: request.text.slice(0, 8_000),
        ...(recipient === undefined ? {} : { recipientAgentId: recipient.agentId, recipientRole: recipient.role }),
      },
    });
    if (recipient === undefined) {
      // Status and the panel read the ledger directly: recording is the delivery.
      await this.controller.append(loaded, { type: 'notice.sent', payloadVersion: 1, actor: plugin, data: { noticeId } });
      return noticeId;
    }
    await this.deliver(loaded, noticeId, recipient.agentId, request.text);
    return noticeId;
  }

  /** Recorded first, so a failure here leaves a notice to retry rather than none at all. */
  private async deliver(loaded: LoadedProject, noticeId: string, agentId: string, text: string): Promise<void> {
    try {
      const target = await this.controller.deps.paseo.getAgent(agentId);
      if (this.controller.deps.recognition.recognize(target?.provider ?? '')?.role === 'peer') {
        await this.controller.append(loaded, { type: 'notice.failed', payloadVersion: 1, actor: plugin, data: { noticeId, reason: 'A notice is never addressed to a Peer.' } });
        return;
      }
      // Sending would clear the recipient's pending permission: hold, and retry when it resolves.
      if (target !== undefined && target.pendingPermissions.length > 0) return;
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown';
      await this.controller.append(loaded, { type: 'notice.uncertain', payloadVersion: 1, actor: plugin, data: { noticeId, reason } });
      return;
    }
    try {
      await this.controller.deps.paseo.send(agentId, noticeText(noticeId, text), noticeId, 'steer');
      await this.controller.append(loaded, { type: 'notice.sent', payloadVersion: 1, actor: plugin, data: { noticeId } });
    } catch (error) {
      const evidence = await this.controller.deps.paseo.promptDelivered(agentId, noticeId).catch(() => 'unknown' as const);
      if (evidence === 'delivered') {
        await this.controller.append(loaded, { type: 'notice.sent', payloadVersion: 1, actor: plugin, data: { noticeId } });
        return;
      }
      const reason = error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown';
      await this.controller.append(loaded, evidence === 'absent'
        ? { type: 'notice.failed', payloadVersion: 1, actor: plugin, data: { noticeId, reason } }
        : { type: 'notice.uncertain', payloadVersion: 1, actor: plugin, data: { noticeId, reason } });
    }
  }

  /** Retries every undelivered notice with its original id, or only `recipient`'s. Call inside the project's queue. */
  async retryUndelivered(loaded: LoadedProject, recipient?: string): Promise<number> {
    let retried = 0;
    for (const notice of [...loaded.state.notices.values()]) {
      if (notice.state === 'sent') continue;
      const event = loaded.events.find(entry => entry.type === 'notice.pending' && entry.data.noticeId === notice.noticeId);
      if (event?.type !== 'notice.pending' || event.data.recipientAgentId === undefined) continue;
      const agentId = event.data.recipientAgentId;
      if (recipient !== undefined && agentId !== recipient) continue;
      // Already delivered before a crash: record it, never send a duplicate on purpose.
      if (await this.controller.deps.paseo.promptDelivered(agentId, notice.noticeId).catch(() => 'unknown' as const) === 'delivered') {
        await this.controller.append(loaded, { type: 'notice.sent', payloadVersion: 1, actor: plugin, data: { noticeId: notice.noticeId } });
        continue;
      }
      await this.deliver(loaded, notice.noticeId, agentId, event.data.text);
      retried += 1;
    }
    return retried;
  }

  /** Retries the notices held for one recipient, in every project, each inside its own queue. */
  async retryFor(agentId: string): Promise<number> {
    let retried = 0;
    for (const store of await ProjectStore.list(this.controller.deps.runtimeRoot, this.controller.deps.now)) {
      retried += await this.controller.serial(store.meta.projectId, async () => {
        const loaded = await this.controller.load(store);
        if (!loaded.ok) return 0;
        const waiting = [...loaded.value.state.notices.values()].some(notice => notice.state === 'pending');
        return waiting ? await this.retryUndelivered(loaded.value, agentId) : 0;
      });
    }
    return retried;
  }
}
