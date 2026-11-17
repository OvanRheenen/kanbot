import { getDb, newId, now } from './db.ts';
import { bus } from './events.ts';
import { publishFeature } from './features.ts';
import type { ChatMessage, DecisionCard } from '../../shared/types.ts';

function rowToMessage(r: any): ChatMessage {
  let decisions: DecisionCard[] = [];
  try {
    decisions = JSON.parse(r.decisions_json || '[]');
  } catch {
    /* keep empty */
  }
  return { id: r.id, featureId: r.feature_id, role: r.role, text: r.text, decisions, runId: r.run_id ?? null, createdAt: r.created_at };
}

export function listChat(featureId: string): ChatMessage[] {
  return (getDb().prepare('SELECT * FROM chat_messages WHERE feature_id = ? ORDER BY created_at, rowid').all(featureId) as any[]).map(rowToMessage);
}

export function addChatMessage(featureId: string, role: ChatMessage['role'], text: string, opts: { decisions?: DecisionCard[]; runId?: string | null } = {}): ChatMessage {
  const id = newId('msg');
  getDb()
    .prepare('INSERT INTO chat_messages (id, feature_id, role, text, decisions_json, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, featureId, role, text, JSON.stringify(opts.decisions ?? []), opts.runId ?? null, now());
  const message = rowToMessage(getDb().prepare('SELECT * FROM chat_messages WHERE id = ?').get(id));
  bus.publish({ type: 'chat.message', message });
  publishFeature(featureId);
  return message;
}

/** Record the user's answers on the open decision cards of the latest assistant message. */
export function answerDecisions(featureId: string, answers: Record<string, string>): DecisionCard[] {
  const row = getDb().prepare("SELECT * FROM chat_messages WHERE feature_id = ? AND role = 'assistant' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(featureId) as any;
  if (!row) return [];
  const msg = rowToMessage(row);
  const answered: DecisionCard[] = [];
  for (const d of msg.decisions) {
    const a = answers[d.id]?.trim();
    if (d.answer === null && a) {
      d.answer = a;
      answered.push(d);
    }
  }
  if (answered.length) {
    getDb().prepare('UPDATE chat_messages SET decisions_json = ? WHERE id = ?').run(JSON.stringify(msg.decisions), msg.id);
    bus.publish({ type: 'chat.message', message: msg });
    publishFeature(featureId);
  }
  return answered;
}
