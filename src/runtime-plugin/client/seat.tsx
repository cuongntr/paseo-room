/**
 * One seat's view (docs/design/runtime-panel-ux.md §5, panel delta 2026-10-02): where it works, how
 * full its context is, its latest turns, and what its role makes worth seeing — the assignment a
 * Peer works on, the assignments a Lead runs and what attention did with its turns, the letters a
 * Supervisor was sent and those still waiting for it. The same view backs the agent panel beside a
 * seat's conversation, which alone adds Paseo's live facts for that agent.
 */
import { useAgent, useWorkspace } from '@getpaseo/plugin/client';
import { Text, View } from 'react-native';
import type { AssignmentLine } from '../shared/panel.js';
import { useClock, usePolled, useRuntimeRpcs } from './data.js';
import { Button, Card, Empty, Facts, Glyph, Loading, Meter, MutedText, Pill, Row, SPACE, SectionLabel, Title, type Theme } from './kit.js';
import {
  ROLE_ICON, assignmentActivity, checkoutLine, contextLine, launchLabel, plural, providerLabel, seatActivity, seatName, sentence, stateTone, type SeatView,
} from './model.js';
import { TONE_ICON, assignmentTone } from './record.js';
import { ago, duration, whenLabel } from './time.js';

interface SeatTurn {
  readonly startedAt: string; readonly endedAt: string; readonly outcome: string; readonly trigger: string; readonly files: number; readonly said?: string;
}

interface Letter { readonly at: string; readonly level: string; readonly sent: boolean; readonly items: number; readonly lines?: readonly string[] }

export interface SeatDetail {
  readonly seat: SeatView;
  readonly turns: readonly SeatTurn[];
  readonly project?: { readonly key: string; readonly name: string };
  readonly projectId?: string;
  readonly assignments?: readonly AssignmentLine[];
  readonly watches?: readonly { readonly key: string; readonly name: string }[];
  readonly letters?: readonly Letter[];
  readonly held?: readonly { readonly level: string; readonly line: string; readonly createdAt: string }[];
  readonly triaged?: readonly { readonly at: string; readonly decision: string; readonly reason: string }[];
}

const ROLE_WORD: Readonly<Record<string, string>> = { lead: 'Lead', peer: 'Peer', supervisor: 'Supervisor' };

/** What started a turn, as a reader says it. */
const TRIGGER_WORD: Readonly<Record<string, string>> = {
  message: 'after a message', envelope: 'from Paseo', runtime: 'after a runtime notice', succession: 'for a Lead replacement', unknown: '',
};

const OUTCOME_STYLE: Readonly<Record<string, { readonly icon: string; readonly tone: 'muted' | 'danger' | 'warning' }>> = {
  completed: { icon: 'CircleCheck', tone: 'muted' }, failed: { icon: 'CircleX', tone: 'danger' }, canceled: { icon: 'CircleSlash', tone: 'warning' },
};

/** What attention did with a Lead's turn. */
const DECISION_WORD: Readonly<Record<string, string>> = { record: 'Kept on record', digest: 'Told in a digest', now: 'Told the Supervisor at once' };

const LEVEL_TONE: Readonly<Record<string, 'danger' | 'warning' | 'muted'>> = { page: 'danger', now: 'warning', digest: 'muted' };
const levelTone = (level: string): 'danger' | 'warning' | 'muted' => LEVEL_TONE[level] ?? 'muted';

/** When a held item goes (attention delta §7): a page after its hold, a now item when the Supervisor is idle, a digest line with the next digest. */
const HELD_WHEN: Readonly<Record<string, string>> = {
  page: 'steered in after its hold', now: 'sent when the Supervisor is idle', digest: 'goes with the next digest',
};

/** Paseo's own live facts for the agent. Its state hooks throw outside a workspace panel, so only the agent panel renders this. */
function LiveFacts(props: { readonly theme: Theme; readonly seat: SeatView }) {
  const { seat } = props;
  const active = useAgent(seat.agentId, agent => agent.lastActivityAt);
  const changes = useWorkspace(seat.workspaceId ?? '', workspace => (workspace.diffStat === null ? null : `+${String(workspace.diffStat.additions)} −${String(workspace.diffStat.deletions)}`));
  const items: (readonly [string, string])[] = [
    ...(active === null || ago(active) === '' ? [] : [['Last activity', ago(active)] as const]),
    ...(changes === null || seat.checkout?.linked !== true ? [] : [['Uncommitted', changes] as const]),
  ];
  return items.length === 0 ? null : <Facts theme={props.theme} items={items} />;
}

function AssignmentRows(props: { readonly theme: Theme; readonly lines: readonly AssignmentLine[]; readonly seat?: SeatView; readonly open?: (assignmentId: string) => void }) {
  const { theme } = props;
  return (
    <>
      {props.lines.map((line, index) => {
        const tone = assignmentTone(line.state);
        return (
          <Row key={line.id} theme={theme} first={index === 0}
            {...(props.open === undefined ? {} : { onPress: () => { props.open?.(line.id); }, accessibilityLabel: `Open assignment ${line.gist}` })}
            leading={<Glyph theme={theme} name={TONE_ICON[tone] ?? 'Circle'} tone={tone} size={15} />}
            title={line.gist}
            subtitle={[sentence(line.kind), line.gate === undefined || line.gate === 'running' ? undefined : `gate ${line.gate}`].filter(part => part !== undefined).join(' · ')}
            {...(line.updatedAt === undefined ? {} : { meta: `moved ${ago(line.updatedAt)}` })}
            trailing={(
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                <Pill theme={theme} tone={tone}>{assignmentActivity(line, props.seat)}</Pill>
                {props.open === undefined ? null : <Glyph theme={theme} name="ChevronRight" size={15} />}
              </View>
            )} />
        );
      })}
    </>
  );
}

function TurnRows(props: { readonly theme: Theme; readonly turns: readonly SeatTurn[] }) {
  const { theme } = props;
  return (
    <>
      {props.turns.map((turn, index) => {
        const style = OUTCOME_STYLE[turn.outcome] ?? { icon: 'Circle', tone: 'muted' as const };
        const spent = duration(Date.parse(turn.endedAt) - Date.parse(turn.startedAt));
        const why = TRIGGER_WORD[turn.trigger] ?? '';
        return (
          <Row key={`${turn.endedAt}-${String(index)}`} theme={theme} first={index === 0}
            leading={<Glyph theme={theme} name={style.icon} tone={style.tone} size={15} />}
            title={[turn.outcome === 'completed' ? 'Turn' : `Turn ${turn.outcome}`, spent === '' ? undefined : spent, why === '' ? undefined : why].filter(part => part !== undefined).join(' · ')}
            {...(turn.said === undefined ? {} : { subtitle: turn.said })}
            {...(turn.files === 0 ? {} : { meta: `edited ${plural(turn.files, 'file')}` })}
            trailing={<MutedText theme={theme}>{whenLabel(turn.endedAt)}</MutedText>} />
        );
      })}
    </>
  );
}

function LetterBlock(props: { readonly theme: Theme; readonly letter: Letter; readonly first: boolean }) {
  const { theme, letter } = props;
  const { colors } = theme;
  const lines = letter.lines ?? [];
  return (
    <View style={{ paddingVertical: 11, paddingHorizontal: SPACE.lg, gap: 4, borderTopWidth: props.first ? 0 : 1, borderColor: colors.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
        <Pill theme={theme} tone={letter.sent ? levelTone(letter.level) : 'danger'}>{letter.sent ? letter.level : 'not delivered'}</Pill>
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 12 }}>{plural(letter.items, 'item')}</Text>
        <MutedText theme={theme}>{whenLabel(letter.at)}</MutedText>
      </View>
      {lines.map((line, index) => (
        <Text key={String(index)} numberOfLines={3} style={{ color: colors.foreground, fontSize: 12.5, lineHeight: 18 }}>{line}</Text>
      ))}
    </View>
  );
}

export interface SeatScreenProps {
  readonly theme: Theme;
  readonly agentId: string;
  /** Opens the agent in Paseo; absent beside its own conversation. */
  readonly openAgent?: (agentId: string) => void;
  readonly openAssignment: (projectId: string, assignmentId: string) => void;
  readonly openProject?: (key: string) => void;
  /** Beside the agent's conversation, where the host supplies its live state. */
  readonly live?: boolean;
}

export function SeatScreen(props: SeatScreenProps) {
  const rpc = useRuntimeRpcs();
  const polled = usePolled<SeatDetail>(() => rpc.seatView({ agentId: props.agentId }), `seat:${props.agentId}`);
  useClock();
  const { theme } = props;
  const detail = polled.value?.data;
  if (detail === undefined) {
    const error = polled.value?.error;
    if (error?.code === 'seat_unknown') {
      return <Card theme={theme}><Empty theme={theme} icon="UserX" title="Not a room seat">{error.message} The Room runtime describes Supervisors, Leads and Peers of the room.</Empty></Card>;
    }
    return <Card theme={theme}><Loading theme={theme} label={error?.message ?? polled.failed ?? 'Loading the seat…'} /></Card>;
  }
  const { seat, projectId } = detail;
  const runs = launchLabel(seat);
  const context = contextLine(seat);
  const where = checkoutLine(seat) ?? seat.displayCwd;
  const openAssignment = projectId === undefined ? undefined : (assignmentId: string) => { props.openAssignment(projectId, assignmentId); };
  const assignments = detail.assignments ?? [];
  const lastTurn = seat.lastTurn === undefined ? undefined : `${seat.lastTurn.outcome} ${ago(seat.lastTurn.endedAt)}`;
  return (
    <View>
      <Title theme={theme}
        leading={<Glyph theme={theme} name={ROLE_ICON[seat.role] ?? 'Bot'} boxed tone={seat.role === 'lead' ? 'accent' : seat.state === 'running' ? 'success' : 'muted'} />}
        subtitle={[ROLE_WORD[seat.role] ?? seat.role, detail.project?.name, providerLabel(seat.provider), runs === '' ? undefined : runs].filter(part => part !== undefined).join(' · ')}
        trailing={(
          <>
            <Pill theme={theme} tone={stateTone(seat.state)}>{seatActivity(seat)}</Pill>
            {props.openAgent === undefined ? null : <Button theme={theme} small label="Open in Paseo" icon="ExternalLink" onPress={() => { props.openAgent?.(seat.agentId); }} />}
          </>
        )}>{seatName(seat)}</Title>

      <Card theme={theme}>
        <Facts theme={theme} items={[
          ['Works in', sentence(where)],
          ...(context === undefined ? [] : [['Context', context.text] as const]),
          ...(lastTurn === undefined ? [] : [['Last turn', lastTurn] as const]),
          ...(seat.pendingPermissions === 0 ? [] : [['Waiting', `${plural(seat.pendingPermissions, 'permission')} — answer it in the conversation`] as const]),
        ]} />
        {seat.context === undefined || context === undefined ? null : (
          <View style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.md, marginLeft: 132 + SPACE.md }}>
            <Meter theme={theme} percent={seat.context.percent} mark={seat.context.rotateAtPercent ?? seat.context.compactAtPercent} tone={context.tone} width={160} />
          </View>
        )}
        {props.live === true ? <LiveFacts theme={theme} seat={seat} /> : null}
      </Card>

      {seat.role === 'peer' ? (
        <View>
          <SectionLabel theme={theme}>Assignment</SectionLabel>
          <Card theme={theme}>
            {assignments.length === 0
              ? <Empty theme={theme} icon="ClipboardList" title="No runtime assignment">This Peer was not dispatched through the runtime's assignment tools.</Empty>
              : <AssignmentRows theme={theme} lines={assignments} seat={seat} {...(openAssignment === undefined ? {} : { open: openAssignment })} />}
          </Card>
        </View>
      ) : null}

      {seat.role === 'lead' ? (
        <View>
          <SectionLabel theme={theme}>In flight</SectionLabel>
          <Card theme={theme}>
            {projectId === undefined
              ? <Empty theme={theme} icon="ClipboardList" title="No runtime record yet">It starts when this Lead first uses the runtime's assignment tools.</Empty>
              : assignments.length === 0
              ? <Empty theme={theme} icon="CircleCheck" title="Nothing in flight">Every dispatched assignment has been decided.</Empty>
              : <AssignmentRows theme={theme} lines={assignments} {...(openAssignment === undefined ? {} : { open: openAssignment })} />}
          </Card>
          {(detail.triaged ?? []).length === 0 ? null : (
            <View>
              <SectionLabel theme={theme}>Its turns, as attention saw them · last 24 h</SectionLabel>
              <Card theme={theme}>
                {(detail.triaged ?? []).map((entry, index) => (
                  <Row key={`${entry.at}-${String(index)}`} theme={theme} first={index === 0}
                    leading={<Glyph theme={theme} name={entry.decision === 'record' ? 'Archive' : 'Send'} tone={entry.decision === 'now' ? 'warning' : 'muted'} size={15} />}
                    title={DECISION_WORD[entry.decision] ?? entry.decision} subtitle={entry.reason}
                    trailing={<MutedText theme={theme}>{whenLabel(entry.at)}</MutedText>} />
                ))}
              </Card>
            </View>
          )}
        </View>
      ) : null}

      {seat.role === 'supervisor' ? (
        <View>
          <SectionLabel theme={theme}>Watches</SectionLabel>
          <Card theme={theme}>
            {(detail.watches ?? []).length === 0
              ? <Empty theme={theme} icon="Eye" title="No project yet">Assign it a project from that project's screen.</Empty>
              : (detail.watches ?? []).map((project, index) => (
                <Row key={project.key} theme={theme} first={index === 0} title={project.name}
                  {...(props.openProject === undefined ? {} : { onPress: () => { props.openProject?.(project.key); }, accessibilityLabel: `Open ${project.name}`, trailing: <Glyph theme={theme} name="ChevronRight" size={15} /> })} />
              ))}
          </Card>
          {(detail.held ?? []).length === 0 ? null : (
            <View>
              <SectionLabel theme={theme}>Waiting to be sent</SectionLabel>
              <Card theme={theme}>
                {(detail.held ?? []).map((item, index) => (
                  <Row key={`${item.createdAt}-${String(index)}`} theme={theme} first={index === 0} title={item.line}
                    meta={`queued ${ago(item.createdAt)} · ${HELD_WHEN[item.level] ?? 'sent when the Supervisor is idle'}`}
                    trailing={<Pill theme={theme} tone={levelTone(item.level)}>{item.level}</Pill>} />
                ))}
              </Card>
            </View>
          )}
          <SectionLabel theme={theme}>Letters · last 24 h</SectionLabel>
          <Card theme={theme}>
            {(detail.letters ?? []).length === 0
              ? <Empty theme={theme} icon="Mail" title="No letters">Nothing reached this Supervisor in the last day.</Empty>
              : (detail.letters ?? []).map((letter, index) => <LetterBlock key={`${letter.at}-${String(index)}`} theme={theme} letter={letter} first={index === 0} />)}
          </Card>
        </View>
      ) : null}

      <SectionLabel theme={theme}>Recent turns</SectionLabel>
      <Card theme={theme}>
        {detail.turns.length === 0
          ? <Empty theme={theme} icon="History" title="No turn seen yet">Turns are listed from when the runtime last started.</Empty>
          : <TurnRows theme={theme} turns={detail.turns} />}
      </Card>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: SPACE.md }}>
        The runtime keeps a seat's last few turns in memory only; the conversation in Paseo is the full record.
      </Text>
    </View>
  );
}
