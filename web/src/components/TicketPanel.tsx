import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, CheckCircle2, ExternalLink, Github, Hand, Loader2, MessageCircleQuestion, Sparkles } from 'lucide-react';
import type { ChatMessage, DecisionCard, Feature } from '@shared/types.ts';
import { api } from '@/api';
import { onChatMessage, upsertFeature } from '@/store';
import { cn } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Textarea } from './ui/input';
import { Markdown } from './Markdown';
import { isActive } from './status';
import { toast, toastError } from './toast';

/**
 * Steps only the human may take (apply a migration, run the Docker tests, check a preview on a phone).
 * Shown at the top of the ticket while any is open; ticking one is a note to yourself, except for steps tied
 * to a PR label, which follow the label on the next sync.
 */
export function HumanActionsPanel({ feature }: { feature: Feature }) {
  const actions = feature.humanActions;
  if (!actions.length || feature.status === 'done') return null;
  const open = actions.filter((a) => !a.done).length;
  const toggle = async (id: string, done: boolean) => {
    try {
      upsertFeature(await api.setHumanAction(feature.id, id, done));
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <section className="border-b border-foreground/10 p-4">
      <div className={cn('overflow-hidden rounded-2xl border-2', open ? 'border-amber-500' : 'border-emerald-500/50')}>
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wide',
            open ? 'bg-amber-500 text-black' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
          )}
        >
          {open ? <Hand className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {open ? `Your action needed before merging (${open})` : 'Your steps are done'}
        </div>
        <ul className="divide-y divide-foreground/10">
          {actions.map((a) => (
            <li key={a.id} className="flex items-start gap-3 px-4 py-2.5">
              <input type="checkbox" className="mt-1" checked={a.done} onChange={(e) => toggle(a.id, e.target.checked)} aria-label={`${a.label} done`} />
              <div className={cn('min-w-0 text-sm', a.done && 'text-muted-foreground line-through')}>
                <span className="font-semibold">{a.label}</span>
                <div className="prose-report text-xs text-muted-foreground [&_p]:m-0">
                  <Markdown>{a.detail}</Markdown>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** One open choice from the writer agent: pick an option or type your own. */
function Decision({ card, value, onChange, disabled }: { card: DecisionCard; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const answered = card.answer !== null;
  const isOption = card.options.some((o) => o.label === value);
  return (
    <div className={cn('metal-surface rounded-xl p-3', !answered && 'shadow-gold-glow')}>
      <p className="flex items-start gap-2 text-sm font-semibold">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-[hsl(var(--gold))]" />
        {card.question}
      </p>
      {answered ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm">
          <Check className="h-3.5 w-3.5 text-emerald-600" /> {card.answer}
        </p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {card.options.map((o, i) => (
            <button
              key={o.label}
              type="button"
              disabled={disabled}
              onClick={() => onChange(value === o.label ? '' : o.label)}
              aria-pressed={value === o.label}
              className={cn(
                'block w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                value === o.label ? 'border-primary bg-primary/10' : 'border-foreground/15 hover:border-foreground/30',
              )}
            >
              <span className="font-medium">{o.label}</span>
              {i === 0 && <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">recommended</span>}
              {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
            </button>
          ))}
          <input
            value={isOption ? '' : value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="Something else…"
            className="metal-inset w-full rounded-lg px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70"
          />
        </div>
      )}
    </div>
  );
}

/**
 * The Ticket tab: the issue (or its draft) and the chat with the writer agent. In the Backlog the chat is
 * live: messages and decision-card answers go to the same Claude Code session, and a draft with nothing
 * open is saved to GitHub as the issue.
 */
export function TicketPanel({ feature, githubConfigured }: { feature: Feature; githubConfigured: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const writing = isActive(feature.agentStatus) && feature.run?.kind === 'refine';
  const inBacklog = feature.status === 'backlog';

  useEffect(() => {
    setMessages([]);
    setPicks({});
    setText('');
    api.chat(feature.id).then(setMessages).catch(() => {});
    return onChatMessage((m) => {
      if (m.featureId !== feature.id) return;
      setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev.map((p) => (p.id === m.id ? m : p)) : [...prev, m]));
    });
  }, [feature.id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, writing]);

  const lastAssistant = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant'), [messages]);
  const openCards = lastAssistant?.decisions.filter((d) => d.answer === null) ?? [];
  const answers = Object.fromEntries(openCards.map((d) => [d.id, picks[d.id]?.trim() ?? '']).filter(([, v]) => v));
  const canSend = !busy && !writing && (text.trim().length > 0 || Object.keys(answers).length > 0);

  const run = async (fn: () => Promise<Feature>, msg?: string) => {
    setBusy(true);
    try {
      upsertFeature(await fn());
      if (msg) toast(msg);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    canSend &&
    run(async () => {
      const f = await api.sendChat(feature.id, text, answers);
      setText('');
      setPicks({});
      return f;
    });

  const body = feature.issueNumber ? feature.description : feature.draft?.body ?? feature.description;
  const draftPending = inBacklog && !!feature.draft && !feature.issueNumber;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2">
      {/* The issue */}
      <div className="min-h-0 space-y-3 overflow-y-auto border-b border-foreground/10 p-5 lg:border-b-0 lg:border-r">
        <div className="flex flex-wrap items-center gap-2">
          {feature.issueNumber ? (
            <a href={feature.issueUrl ?? '#'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold hover:underline">
              <Github className="h-4 w-4" /> Issue #{feature.issueNumber} <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span className="text-sm font-semibold">{feature.draft ? 'Issue draft' : 'Ticket'}</span>
          )}
          {feature.issueState === 'closed' && <Badge variant="violet">closed</Badge>}
          {feature.size && (
            <Badge variant="outline" className="font-mono">
              size {feature.size}
            </Badge>
          )}
          {feature.labels.map((l) => (
            <Badge key={l} variant="gray">
              {l}
            </Badge>
          ))}
          {draftPending && (
            <Button
              size="sm"
              variant="chrome"
              className="ml-auto"
              disabled={busy || writing || !githubConfigured}
              title={githubConfigured ? 'Save the draft as a GitHub issue as it stands' : 'Add a GitHub token in Settings first'}
              onClick={() => run(() => api.publishIssue(feature.id), 'Issue saved on GitHub')}
            >
              <Github /> Create issue now
            </Button>
          )}
        </div>
        {feature.blockedBy.length > 0 && (
          <p className="text-xs text-muted-foreground">Depends on: {feature.blockedBy.map((d) => d.title).join(', ')} (not Done yet)</p>
        )}
        {body.trim() ? (
          <div className="prose-report metal-inset rounded-xl p-4 text-sm">
            <Markdown>{body}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No text yet. Tell Claude what you want in the chat.</p>
        )}
      </div>

      {/* The chat */}
      <div className="flex min-h-0 flex-col">
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {messages.length === 0 && !writing && (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                {inBacklog
                  ? 'Brainstorm this ticket with Claude. It reads the code, writes the issue with real file names and acceptance criteria, and hands you the open choices as decision cards.'
                  : 'This ticket was not drafted in the chat.'}
              </p>
              {inBacklog && (
                <Button size="sm" disabled={busy} onClick={() => run(() => api.startChat(feature.id))}>
                  <Sparkles /> Sharpen this ticket with Claude
                </Button>
              )}
            </div>
          )}
          {messages.map((m) =>
            m.role === 'system' ? (
              <p key={m.id} className="text-center text-[11px] text-muted-foreground">
                {m.text}
              </p>
            ) : (
              <div key={m.id} className={cn('space-y-2', m.role === 'user' && 'flex flex-col items-end')}>
                <div
                  className={cn(
                    'max-w-[92%] rounded-2xl px-3.5 py-2 text-sm',
                    m.role === 'user' ? 'bg-primary/15 whitespace-pre-wrap' : 'metal-surface prose-report [&_p]:my-1',
                  )}
                >
                  {m.role === 'user' ? m.text : <Markdown>{m.text}</Markdown>}
                </div>
                {m.decisions.map((d) => (
                  <Decision
                    key={d.id}
                    card={d}
                    value={picks[d.id] ?? ''}
                    onChange={(v) => setPicks((p) => ({ ...p, [d.id]: v }))}
                    disabled={!inBacklog || busy || writing || m.id !== lastAssistant?.id}
                  />
                ))}
              </div>
            ),
          )}
          {writing && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {feature.run?.currentActivity || 'Claude is reading the code and writing the issue…'}
            </p>
          )}
          <div ref={endRef} />
        </div>
        {inBacklog ? (
          <div className="border-t border-foreground/10 p-3">
            <div className="metal-surface flex items-end gap-2 rounded-2xl p-2">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={2}
                disabled={writing}
                placeholder={openCards.length ? 'Pick options above, and/or add a note…' : messages.length ? 'Reply, correct or add detail…' : 'What do you want? Rough notes are fine.'}
                className="min-h-0 flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
              />
              <Button size="icon-round" disabled={!canSend} onClick={send} aria-label="Send" title="Send (⌘/Ctrl + Enter)">
                <ArrowUp />
              </Button>
            </div>
            {openCards.length > 0 && (
              <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
                {Object.keys(answers).length} of {openCards.length} decision{openCards.length === 1 ? '' : 's'} picked. The issue is saved to GitHub once nothing is open.
              </p>
            )}
          </div>
        ) : (
          <p className="border-t border-foreground/10 p-3 text-center text-[11px] text-muted-foreground">
            The chat is for Backlog tickets. To change a ticket that is being built, send a follow-up from the Overview tab.
          </p>
        )}
      </div>
    </div>
  );
}
