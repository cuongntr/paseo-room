/**
 * Deterministic notices (docs/design/runtime-coordination.md D9, §4.4).
 *
 * Audience comes from code, never from a model: assignment-local evidence goes to that
 * assignment's Lead, a page goes to the authority recipient, operator faults go to status and
 * the panel. A Peer is never a recipient, and an archived seat is never sent to, since a send would
 * unarchive it. Every notice carries a stable id in its delivered
 * text; delivery is at least once, a retry reuses the id, and a retry first checks the
 * recipient's timeline so a confirmed delivery is not sent twice.
 *
 * A notice is sent with `steer` (docs/design/runtime-coordination-attention.md §7.4), but Paseo
 * replaces — interrupts — a turn whose provider cannot take the steer, and a steer Claude does take
 * still cancels the tool call it is running. So only a page is sent into a running turn; every owner
 * notice, a Supervisor's message included, waits until the recipient's turn has ended. Paseo also
 * clears every pending permission of an agent it sends to, so a recipient holding one is not sent to
 * at all. A held notice stays pending, and `retryFor` delivers it when that permission resolves or
 * the turn ends.
 *
 * Whatever a recipient can take at that moment goes as one message, so notices held through the
 * same turn cost the recipient one turn, not one each (§4.4).
 */
import { randomBytes } from 'node:crypto';
import type { Controller, LoadedProject } from './controller.js';
import type { SentMessages } from './paseo-port.js';
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

/** An undelivered notice to a seat, with what delivery needs from its pending event. */
interface Undelivered {
  readonly noticeId: string;
  readonly agentId: string;
  readonly class: NoticeClass;
  readonly text: string;
}

const plugin = { source: 'plugin' as const };

/** A bundle's first line: every notice it carries, oldest first; the first id is the message's own. */
const BUNDLE_HEAD = /^\[paseo-room notices (ntc_[\w-]+(?: ntc_[\w-]+)+)\]$/;

/** Notice text one message carries at most; the rest waits for the recipient's next turn end. */
const BUNDLE_CHARS = 24_000;

/** Whether a notice waits for its recipient's turn to end rather than steer into it. */
function waitsForIdle(noticeClass: NoticeClass): boolean {
  return noticeClass === 'owner';
}

export function noticeText(noticeId: string, text: string): string {
  return `[paseo-room notice ${noticeId}] ${text}`;
}

/** How the text of a Supervisor's `message_lead` notice begins. */
export const SUPERVISOR_MESSAGE_PREFIX = 'Supervisor: ';

/**
 * Whether a prompt the runtime delivered carries a Supervisor's message: a notice whose text is one,
 * or a bundle whose first line lists such a notice. Only the heads of the notices themselves are
 * read, since a notice quotes what a Peer wrote.
 */
export function carriesSupervisorMessage(text: string): boolean {
  const single = /^\[paseo-room notice (ntc_[\w-]+)\] /.exec(text)?.[1];
  if (single !== undefined) return text.startsWith(noticeText(single, SUPERVISOR_MESSAGE_PREFIX));
  const listed = BUNDLE_HEAD.exec(text.split('\n', 1)[0] ?? '')?.[1]?.split(' ') ?? [];
  return listed.some(id => text.includes(`\n\n${noticeText(id, SUPERVISOR_MESSAGE_PREFIX)}`));
}

/** Two or more notices as one message: a line listing every id, then each notice as it would go alone. */
export function bundleText(notices: readonly { readonly noticeId: string; readonly text: string }[]): string {
  return [`[paseo-room notices ${notices.map(notice => notice.noticeId).join(' ')}]`, ...notices.map(notice => noticeText(notice.noticeId, notice.text))].join('\n\n');
}

/**
 * The ids a timeline shows delivered: each prompt's own, and every id on a bundle's first line when
 * the prompt's own id heads it. Nothing below that line is read, since a notice quotes what a Peer wrote.
 */
export function deliveredIds(sent: SentMessages): Set<string> {
  const ids = new Set<string>();
  for (const message of sent.messages) {
    for (const id of message.ids) ids.add(id);
    const listed = BUNDLE_HEAD.exec(message.text.split('\n', 1)[0] ?? '')?.[1]?.split(' ') ?? [];
    if (message.ids.includes(listed[0] ?? '')) for (const id of listed) ids.add(id);
  }
  return ids;
}

/** Every notice to a seat not yet delivered, oldest first; only `agentId`'s when given. */
function undelivered(loaded: LoadedProject, agentId?: string): Undelivered[] {
  return loaded.events.flatMap(event => {
    if (event.type !== 'notice.pending' || event.data.recipientAgentId === undefined) return [];
    if ((agentId !== undefined && event.data.recipientAgentId !== agentId) || loaded.state.notices.get(event.data.noticeId)?.state === 'sent') return [];
    return [{ noticeId: event.data.noticeId, agentId: event.data.recipientAgentId, class: event.data.class, text: event.data.text }];
  });
}

/** The oldest notices that fit one message. The first always goes: a notice's own text is bounded. */
function bundle(ready: readonly Undelivered[]): Undelivered[] {
  const taken: Undelivered[] = [];
  let chars = 0;
  for (const notice of ready) {
    if (taken.length > 0 && chars + notice.text.length > BUNDLE_CHARS) break;
    taken.push(notice);
    chars += notice.text.length;
  }
  return taken;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown';
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
    await this.deliver(loaded, recipient.agentId, noticeId);
    return noticeId;
  }

  /** Retries every undelivered notice with its original id, or only `recipient`'s. Call inside the project's queue. */
  async retryUndelivered(loaded: LoadedProject, recipient?: string): Promise<number> {
    let retried = 0;
    for (const agentId of new Set(undelivered(loaded, recipient).map(notice => notice.agentId))) retried += await this.deliver(loaded, agentId);
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

  /**
   * Sends `agentId` what it can take now of its undelivered notices, as one message, and returns how
   * many were not found already delivered. Notices are recorded first, so a failure here leaves them
   * to retry rather than lost. `fresh` names one just recorded, which cannot have been sent yet.
   */
  private async deliver(loaded: LoadedProject, agentId: string, fresh?: string): Promise<number> {
    const waiting = undelivered(loaded, agentId);
    if (waiting.length === 0) return 0;
    // Already delivered before a crash: record it, never send a duplicate on purpose.
    const found = waiting.some(notice => notice.noticeId !== fresh) ? await this.delivered(agentId) : undefined;
    const unsent: Undelivered[] = [];
    for (const notice of waiting) {
      if (found?.ids.has(notice.noticeId) === true) await this.record(loaded, [notice], 'notice.sent');
      else unsent.push(notice);
    }
    if (unsent.length === 0) return 0;
    let running: boolean;
    try {
      const target = await this.controller.deps.paseo.getAgent(agentId);
      if (this.controller.deps.recognition.recognize(target?.provider ?? '')?.role === 'peer') {
        await this.record(loaded, unsent, 'notice.failed', 'A notice is never addressed to a Peer.');
        return unsent.length;
      }
      // Paseo unarchives an agent it is sent to. A closed seat is resumed, an archived one left alone.
      if (target !== undefined && target.archivedAt !== null) {
        await this.record(loaded, unsent, 'notice.failed', 'The recipient is archived.');
        return unsent.length;
      }
      // Sending would clear the recipient's pending permission: hold, and retry when it resolves.
      if (target !== undefined && target.pendingPermissions.length > 0) return unsent.length;
      running = target !== undefined && (target.activeTurn || target.status === 'running');
    } catch (error) {
      await this.record(loaded, unsent, 'notice.uncertain', reasonOf(error));
      return unsent.length;
    }
    // Sending could interrupt the running turn: every owner notice waits until it ends.
    const batch = bundle(running ? unsent.filter(notice => !waitsForIdle(notice.class)) : unsent);
    const head = batch[0];
    if (head === undefined) return unsent.length;
    try {
      await this.controller.deps.paseo.send(agentId, batch.length === 1 ? noticeText(head.noticeId, head.text) : bundleText(batch), head.noticeId, 'steer');
      await this.record(loaded, batch, 'notice.sent');
    } catch (error) {
      const evidence = await this.delivered(agentId);
      if (evidence?.ids.has(head.noticeId) === true) await this.record(loaded, batch, 'notice.sent');
      else await this.record(loaded, batch, evidence?.complete === true ? 'notice.failed' : 'notice.uncertain', reasonOf(error));
    }
    return unsent.length;
  }

  /** The notice ids `agentId`'s timeline shows delivered, and whether it was read to its start; undefined when unreadable. */
  private async delivered(agentId: string): Promise<{ readonly ids: ReadonlySet<string>; readonly complete: boolean } | undefined> {
    const sent = await this.controller.deps.paseo.sentMessages(agentId).catch(() => undefined);
    return sent === undefined ? undefined : { ids: deliveredIds(sent), complete: sent.complete };
  }

  private async record(loaded: LoadedProject, notices: readonly Undelivered[], type: 'notice.sent' | 'notice.failed' | 'notice.uncertain', reason?: string): Promise<void> {
    for (const { noticeId } of notices) {
      await this.controller.append(loaded, type === 'notice.sent'
        ? { type, payloadVersion: 1, actor: plugin, data: { noticeId } }
        : { type, payloadVersion: 1, actor: plugin, data: { noticeId, reason: reason ?? 'unknown' } });
    }
  }
}
