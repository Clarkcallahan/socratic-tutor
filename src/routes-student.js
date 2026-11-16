// Student-facing API. Students have no accounts and no cookies: starting a
// conversation returns a private random token that the browser keeps and sends
// back with each request. Only a hash of the token is stored.
import { Router } from 'express';
import { q, db } from './db.js';
import { config } from './env.js';
import { complete } from './ai.js';
import { tutorSystem, tutorMessages, fixedMessages } from './prompts.js';
import { sha256, randomToken, rateLimiter } from './auth.js';

export const student = Router();

const MAX_MESSAGE_CHARS = 4000;
const startLimit = rateLimiter(300, 3600_000);   // conversations started per IP per hour (a whole class may share one campus IP)
const messageLimit = rateLimiter(20, 60_000);    // messages per conversation per minute

const publicReading = slug => q.get(
  `SELECT r.id, r.slug, r.title, r.assignment, r.source_url, r.is_open, c.name AS course
   FROM readings r JOIN courses c ON c.id = r.course_id WHERE r.slug = ?`, slug);

const messagesFor = id => q.all('SELECT id, role, kind, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id', id);
const addMessage = (id, role, kind, content) =>
  q.run('INSERT INTO messages (conversation_id, role, kind, content) VALUES (?, ?, ?, ?)', id, role, kind, content);

function view(conv) {
  const messages = messagesFor(conv.id);
  return {
    status: conv.status,
    student_name: conv.student_name,
    messages: messages.map(({ role, kind, content }) => ({ role, kind, content })),
    student_turns: messages.filter(m => m.role === 'student' && m.kind === 'chat').length,
    min_turns: config.minTurns,
    max_turns: config.maxTurns,
  };
}

function loadConversation(req, res, next) {
  const token = req.headers['x-conversation-token'];
  const conv = typeof token === 'string' && token.length === 64
    ? q.get('SELECT * FROM conversations WHERE token_hash = ?', sha256(token)) : null;
  if (!conv) return res.status(404).json({ error: 'Conversation not found. It may have been deleted.' });
  req.conv = conv;
  next();
}

student.get('/readings/:slug', (req, res) => {
  const r = publicReading(req.params.slug);
  if (!r) return res.status(404).json({ error: 'This reading link is not valid.' });
  res.json({ title: r.title, assignment: r.assignment, course: r.course, source_url: r.source_url, open: !!r.is_open });
});

student.post('/readings/:slug/conversations', (req, res) => {
  if (!startLimit(req.ip)) return res.status(429).json({ error: 'Too many new conversations from this network. Please try again later.' });
  const r = publicReading(req.params.slug);
  if (!r) return res.status(404).json({ error: 'This reading link is not valid.' });
  if (!r.is_open) return res.status(403).json({ error: 'This reading is not open for conversations right now.' });
  const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 100);
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
  if (req.body?.consent !== true) return res.status(400).json({ error: 'Please confirm that you have read the notice.' });

  const token = randomToken();
  const { lastInsertRowid } = q.run('INSERT INTO conversations (reading_id, token_hash, student_name) VALUES (?, ?, ?)', r.id, sha256(token), name);
  addMessage(lastInsertRowid, 'tutor', 'opening', fixedMessages().opening);
  res.status(201).json({ token, ...view(q.get('SELECT * FROM conversations WHERE id = ?', lastInsertRowid)) });
});

student.get('/conversation', loadConversation, (req, res) => res.json(view(req.conv)));

student.post('/conversation/messages', loadConversation, async (req, res) => {
  const conv = req.conv;
  if (conv.status === 'complete') return res.status(409).json({ error: 'This conversation is finished.' });
  if (!messageLimit(conv.id)) return res.status(429).json({ error: 'Please slow down a little and try again in a moment.' });
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Please write a response first.' });
  if (text.length > MAX_MESSAGE_CHARS) return res.status(400).json({ error: `Please keep each response under ${MAX_MESSAGE_CHARS} characters.` });

  const fixed = fixedMessages();

  // Final reflection: save it and close. No AI call.
  if (conv.status === 'reflection') {
    db.exec('BEGIN');
    addMessage(conv.id, 'student', 'reflection', text);
    addMessage(conv.id, 'tutor', 'closing', fixed.closing);
    q.run(`UPDATE conversations SET status = 'complete', completed_at = datetime('now') WHERE id = ?`, conv.id);
    db.exec('COMMIT');
    return res.json(view({ ...conv, status: 'complete' }));
  }

  const history = messagesFor(conv.id);
  const turns = history.filter(m => m.role === 'student').length + 1;

  // At the turn limit, move straight to the reflection question.
  if (turns >= config.maxTurns) {
    db.exec('BEGIN');
    addMessage(conv.id, 'student', 'chat', text);
    addMessage(conv.id, 'tutor', 'reflection_prompt', fixed.reflection_prompt);
    q.run(`UPDATE conversations SET status = 'reflection' WHERE id = ?`, conv.id);
    db.exec('COMMIT');
    return res.json(view({ ...conv, status: 'reflection' }));
  }

  const reading = q.get('SELECT * FROM readings WHERE id = ?', conv.reading_id);
  const course = q.get('SELECT * FROM courses WHERE id = ?', reading.course_id);
  let reply;
  try {
    reply = await complete({
      task: 'tutor',
      system: tutorSystem(course, reading, turns, config.maxTurns),
      messages: tutorMessages([...history, { role: 'student', content: text }]),
      maxTokens: 600,
    });
  } catch (err) {
    // Nothing is saved on failure, so the student can simply send again.
    return res.status(502).json({ error: 'The tutor could not respond just now. Your message was not lost: please press Send again.' });
  }
  db.exec('BEGIN');
  addMessage(conv.id, 'student', 'chat', text);
  addMessage(conv.id, 'tutor', 'chat', reply);
  db.exec('COMMIT');
  res.json(view(conv));
});

student.post('/conversation/finish', loadConversation, (req, res) => {
  const conv = req.conv;
  if (conv.status !== 'active') return res.json(view(conv));
  const turns = q.get(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = 'student'`, conv.id).n;
  if (turns < config.minTurns)
    return res.status(400).json({ error: `Please respond at least ${config.minTurns} times before finishing.` });
  addMessage(conv.id, 'tutor', 'reflection_prompt', fixedMessages().reflection_prompt);
  q.run(`UPDATE conversations SET status = 'reflection' WHERE id = ?`, conv.id);
  res.json(view({ ...conv, status: 'reflection' }));
});
