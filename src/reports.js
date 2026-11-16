// Builds instructor reports from stored conversations. Reports are kept
// separate from the conversations themselves and can be regenerated any time.
import { q } from './db.js';
import { config } from './env.js';
import { complete } from './ai.js';
import { reportRequest, summaryRequest } from './prompts.js';

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw Object.assign(new Error('The AI reply was not in the expected format. Please try again.'), { status: 502 });
  try { return JSON.parse(text.slice(a, b + 1)); }
  catch { throw Object.assign(new Error('The AI reply was not in the expected format. Please try again.'), { status: 502 }); }
}

const norm = s => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const arr = v => (Array.isArray(v) ? v : []);
const str = v => (typeof v === 'string' ? v : '');
const support = v => (['strong', 'moderate', 'limited'].includes(v) ? v : 'limited');

// Check each quoted piece of evidence against what the student actually wrote.
function checker(rows) {
  const studentText = norm(rows.filter(m => m.role === 'student').map(m => m.content).join(' \n '));
  return quote => {
    const n = norm(quote).replace(/^"|"$/g, '').replace(/ ?\.\.\.$/, '').trim();
    return n.length > 0 && studentText.includes(n);
  };
}

export async function generateReport(conversationId) {
  const conv = q.get('SELECT * FROM conversations WHERE id = ?', conversationId);
  if (!conv) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
  const rows = q.all('SELECT role, kind, content FROM messages WHERE conversation_id = ? ORDER BY id', conversationId);
  if (!rows.some(m => m.role === 'student'))
    throw Object.assign(new Error('This student has not written anything yet, so there is nothing to report.'), { status: 400 });
  const reading = q.get('SELECT * FROM readings WHERE id = ?', conv.reading_id);
  const course = q.get('SELECT * FROM courses WHERE id = ?', reading.course_id);

  const raw = parseJson(await complete({ task: 'report', ...reportRequest(course, reading, rows), maxTokens: 3000 }));
  const verified = checker(rows);
  const quoted = (o, field = 'quote') => ({ summary: str(o?.summary), [field]: str(o?.[field]), verified: verified(o?.[field]) });
  const item = (o, extra) => ({ ...extra(o), evidence: str(o?.evidence), support: support(o?.support), evidence_verified: verified(o?.evidence) });

  const data = {
    initial_reaction: quoted(raw.initial_reaction),
    accurate: arr(raw.accurate).map(o => item(o, o => ({ idea: str(o?.idea) }))),
    partial: arr(raw.partial).map(o => item(o, o => ({ idea: str(o?.idea), what_is_unclear: str(o?.what_is_unclear) }))),
    possible_misconceptions: arr(raw.possible_misconceptions).map(o => item(o, o => ({ description: str(o?.description) }))),
    open_questions: arr(raw.open_questions).map(str).filter(Boolean),
    final_reflection: quoted(raw.final_reflection),
    not_discussed: arr(raw.not_discussed).map(str).filter(Boolean),
    evidence_note: str(raw.evidence_note),
    student_turns: rows.filter(m => m.role === 'student').length,
    conversation_status: conv.status,
  };

  q.run(`INSERT INTO reports (conversation_id, data, message_count, model, generated_at) VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(conversation_id) DO UPDATE SET data = excluded.data, message_count = excluded.message_count, model = excluded.model, generated_at = excluded.generated_at`,
    conversationId, JSON.stringify(data), rows.length, config.provider === 'mock' ? 'mock' : config.model);
  return getReport(conversationId);
}

export function getReport(conversationId) {
  const r = q.get('SELECT * FROM reports WHERE conversation_id = ?', conversationId);
  if (!r) return null;
  const count = q.get('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?', conversationId).n;
  return { ...JSON.parse(r.data), generated_at: r.generated_at, model: r.model, stale: count !== r.message_count };
}

export async function generateSummary(readingId) {
  const reading = q.get('SELECT * FROM readings WHERE id = ?', readingId);
  if (!reading) throw Object.assign(new Error('Reading not found.'), { status: 404 });
  const course = q.get('SELECT * FROM courses WHERE id = ?', reading.course_id);
  const rows = q.all(
    `SELECT rp.data FROM reports rp JOIN conversations c ON c.id = rp.conversation_id WHERE c.reading_id = ? ORDER BY c.id`, readingId);
  if (!rows.length) throw Object.assign(new Error('Generate at least one student report first.'), { status: 400 });

  // Send only the findings. Names are never included, and verification flags are dropped.
  const reports = rows.map(r => {
    const d = JSON.parse(r.data);
    const strip = list => list.map(({ evidence_verified, ...rest }) => rest);
    return {
      initial_reaction: d.initial_reaction.summary,
      accurate: strip(d.accurate), partial: strip(d.partial),
      possible_misconceptions: strip(d.possible_misconceptions),
      open_questions: d.open_questions, final_reflection: d.final_reflection.summary,
      not_discussed: d.not_discussed, evidence_note: d.evidence_note,
    };
  });

  const raw = parseJson(await complete({ task: 'summary', ...summaryRequest(course, reading, reports), maxTokens: 3000 }));
  const pattern = o => ({ topic: str(o?.topic), detail: str(o?.detail), approx_students: str(o?.approx_students), support: support(o?.support) });
  const data = {
    students_included: reports.length,
    common_understanding: arr(raw.common_understanding).map(pattern),
    common_confusion: arr(raw.common_confusion).map(pattern),
    recurring_questions: arr(raw.recurring_questions).map(str).filter(Boolean),
    topics_for_class: arr(raw.topics_for_class).map(o => ({ topic: str(o?.topic), why: str(o?.why) })),
    initial_reactions: str(raw.initial_reactions),
    caveats: str(raw.caveats),
  };
  q.run(`INSERT INTO class_summaries (reading_id, data, model, generated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(reading_id) DO UPDATE SET data = excluded.data, model = excluded.model, generated_at = excluded.generated_at`,
    readingId, JSON.stringify(data), config.provider === 'mock' ? 'mock' : config.model);
  return getSummary(readingId);
}

export function getSummary(readingId) {
  const r = q.get('SELECT * FROM class_summaries WHERE reading_id = ?', readingId);
  if (!r) return null;
  const total = q.get('SELECT COUNT(*) AS n FROM reports rp JOIN conversations c ON c.id = rp.conversation_id WHERE c.reading_id = ?', readingId).n;
  const d = JSON.parse(r.data);
  return { ...d, generated_at: r.generated_at, model: r.model, stale: total !== d.students_included };
}
