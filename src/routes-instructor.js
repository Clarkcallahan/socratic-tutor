// Instructor API. Everything except /login requires the signed session cookie.
import express, { Router } from 'express';
import { q } from './db.js';
import { config } from './env.js';
import { passwordMatches, setSession, clearSession, isInstructor, requireInstructor, sameOriginOnly, rateLimiter, randomToken } from './auth.js';
import { generateReport, getReport, generateSummary, getSummary } from './reports.js';

export const instructor = Router();
instructor.use(sameOriginOnly);

const MAX_READING_CHARS = 300_000;
const loginLimit = rateLimiter(10, 15 * 60_000);
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => String(v ?? '').trim().slice(0, max);

instructor.post('/login', (req, res) => {
  if (!loginLimit(req.ip)) return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes.' });
  if (!passwordMatches(req.body?.password)) return res.status(401).json({ error: 'Incorrect password.' });
  setSession(res);
  res.json({ ok: true });
});
instructor.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });
instructor.get('/me', (req, res) => res.json({ signedIn: isInstructor(req), mock: config.provider === 'mock' }));

instructor.use(requireInstructor);

// ---- Courses ----
instructor.get('/courses', (req, res) => res.json(q.all(
  `SELECT c.id, c.name, (SELECT COUNT(*) FROM readings r WHERE r.course_id = c.id) AS readings FROM courses c ORDER BY c.id DESC`)));

instructor.post('/courses', (req, res) => {
  const name = text(req.body?.name, 200);
  if (!name) throw fail(400, 'Please give the course a name.');
  const { lastInsertRowid } = q.run('INSERT INTO courses (name, voice_guide) VALUES (?, ?)', name, text(req.body?.voice_guide, 4000));
  res.status(201).json({ id: Number(lastInsertRowid) });
});

const course = id => q.get('SELECT * FROM courses WHERE id = ?', id) || (() => { throw fail(404, 'Course not found.'); })();
const reading = id => q.get('SELECT * FROM readings WHERE id = ?', id) || (() => { throw fail(404, 'Reading not found.'); })();

instructor.get('/courses/:id', (req, res) => {
  const c = course(req.params.id);
  const readings = q.all(
    `SELECT r.id, r.title, r.assignment, r.slug, r.is_open,
            (SELECT COUNT(*) FROM conversations v WHERE v.reading_id = r.id) AS conversations
     FROM readings r WHERE r.course_id = ? ORDER BY r.id DESC`, c.id);
  res.json({ ...c, readings });
});

instructor.put('/courses/:id', (req, res) => {
  const c = course(req.params.id);
  const name = text(req.body?.name, 200);
  if (!name) throw fail(400, 'Please give the course a name.');
  q.run('UPDATE courses SET name = ?, voice_guide = ? WHERE id = ?', name, text(req.body?.voice_guide, 4000), c.id);
  res.json({ ok: true });
});

instructor.delete('/courses/:id', (req, res) => { q.run('DELETE FROM courses WHERE id = ?', course(req.params.id).id); res.json({ ok: true }); });

// ---- Readings ----
function readingFields(body) {
  const title = text(body?.title, 300);
  const content = String(body?.content ?? '').trim();
  const source_url = text(body?.source_url, 1000);
  if (!title) throw fail(400, 'Please give the reading a title.');
  if (content.length < 200) throw fail(400, 'The reading text looks too short. Paste the full text or upload a PDF.');
  if (content.length > MAX_READING_CHARS) throw fail(400, `The reading is too long (limit ${MAX_READING_CHARS.toLocaleString()} characters). Use an excerpt.`);
  if (source_url && !/^https?:\/\//i.test(source_url)) throw fail(400, 'The link to the reading must start with http:// or https://');
  return { title, content, source_url, assignment: text(body?.assignment, 300) };
}

instructor.post('/courses/:id/readings', (req, res) => {
  const c = course(req.params.id);
  const f = readingFields(req.body);
  const { lastInsertRowid } = q.run(
    'INSERT INTO readings (course_id, slug, title, assignment, source_url, content) VALUES (?, ?, ?, ?, ?, ?)',
    c.id, randomToken(8), f.title, f.assignment, f.source_url, f.content);
  res.status(201).json({ id: Number(lastInsertRowid) });
});

const conversationList = readingId => q.all(
  `SELECT v.id, v.student_name, v.status, v.started_at, v.completed_at,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = v.id AND m.role = 'student') AS student_turns,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = v.id) AS message_count,
          rp.message_count AS report_message_count
   FROM conversations v LEFT JOIN reports rp ON rp.conversation_id = v.id
   WHERE v.reading_id = ? ORDER BY v.student_name COLLATE NOCASE, v.id`, readingId)
  .map(({ message_count, report_message_count, ...v }) => ({
    ...v, report: report_message_count == null ? 'none' : report_message_count === message_count ? 'current' : 'stale',
  }));

instructor.get('/readings/:id', (req, res) => {
  const r = reading(req.params.id);
  res.json({ ...r, course_name: course(r.course_id).name, conversations: conversationList(r.id), summary: getSummary(r.id) });
});

instructor.put('/readings/:id', (req, res) => {
  const r = reading(req.params.id);
  const f = readingFields(req.body);
  q.run('UPDATE readings SET title = ?, assignment = ?, source_url = ?, content = ?, is_open = ? WHERE id = ?',
    f.title, f.assignment, f.source_url, f.content, req.body?.is_open === false ? 0 : 1, r.id);
  res.json({ ok: true });
});

instructor.delete('/readings/:id', (req, res) => { q.run('DELETE FROM readings WHERE id = ?', reading(req.params.id).id); res.json({ ok: true }); });

instructor.delete('/readings/:id/conversations', (req, res) => {
  const r = reading(req.params.id);
  q.run('DELETE FROM conversations WHERE reading_id = ?', r.id);
  q.run('DELETE FROM class_summaries WHERE reading_id = ?', r.id);
  res.json({ ok: true });
});

// PDF upload: returns extracted text for the instructor to review before saving.
instructor.post('/extract-pdf', express.raw({ type: 'application/pdf', limit: '30mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'Please choose a PDF file.');
  let pages;
  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(req.body));
    ({ text: pages } = await extractText(pdf, { mergePages: false }));
  } catch { throw fail(400, 'That file could not be read as a PDF.'); }
  const cleaned = pages.map(p => p.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
  const body = cleaned.map((p, i) => `[Page ${i + 1}]\n${p}`).join('\n\n');
  const chars = cleaned.join('').length;
  res.json({
    text: body, pages: pages.length,
    warning: chars < 200 * pages.length
      ? 'Very little text was found. This PDF may be a scan (images of pages). Scanned PDFs need text recognition (OCR) first, or you can paste the text instead.'
      : '',
  });
});

// ---- Conversations and reports ----
const conversation = id => q.get('SELECT * FROM conversations WHERE id = ?', id) || (() => { throw fail(404, 'Conversation not found.'); })();

instructor.get('/conversations/:id', (req, res) => {
  const v = conversation(req.params.id);
  const r = reading(v.reading_id);
  const { token_hash, ...safe } = v;
  res.json({
    ...safe, reading_title: r.title, assignment: r.assignment, course_name: course(r.course_id).name,
    messages: q.all('SELECT role, kind, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id', v.id),
    report: getReport(v.id),
  });
});

instructor.delete('/conversations/:id', (req, res) => { q.run('DELETE FROM conversations WHERE id = ?', conversation(req.params.id).id); res.json({ ok: true }); });
instructor.post('/conversations/:id/report', async (req, res) => res.json(await generateReport(conversation(req.params.id).id)));
instructor.post('/readings/:id/summary', async (req, res) => res.json(await generateSummary(reading(req.params.id).id)));

// ---- Export ----
function exportReading(r) {
  const convs = q.all('SELECT id, student_name, status, started_at, completed_at FROM conversations WHERE reading_id = ? ORDER BY id', r.id);
  return {
    reading: { id: r.id, title: r.title, assignment: r.assignment, course: course(r.course_id).name },
    class_summary: getSummary(r.id),
    conversations: convs.map(v => ({
      ...v,
      messages: q.all('SELECT role, kind, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id', v.id),
      report: getReport(v.id),
    })),
  };
}
const download = (res, name, type) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
};
const stamp = () => new Date().toISOString().slice(0, 10);

instructor.get('/readings/:id/export.json', (req, res) => {
  const r = reading(req.params.id);
  download(res, `reading-${r.id}-conversations-${stamp()}.json`, 'application/json; charset=utf-8');
  res.send(JSON.stringify({ exported_at: new Date().toISOString(), ...exportReading(r) }, null, 2));
});

instructor.get('/readings/:id/export.csv', (req, res) => {
  const r = reading(req.params.id);
  // Prefix cells that a spreadsheet could read as a formula.
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const rows = q.all(
    `SELECT v.id AS conversation_id, v.student_name, v.status, m.created_at, m.role, m.kind, m.content
     FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.reading_id = ? ORDER BY v.id, m.id`, r.id);
  const header = ['conversation_id', 'student_name', 'status', 'created_at', 'role', 'kind', 'content'];
  download(res, `reading-${r.id}-conversations-${stamp()}.csv`, 'text/csv; charset=utf-8');
  res.send('﻿' + [header.join(','), ...rows.map(row => header.map(h => cell(row[h])).join(','))].join('\r\n'));
});

instructor.get('/export-all.json', (req, res) => {
  download(res, `reading-tutor-all-data-${stamp()}.json`, 'application/json; charset=utf-8');
  const courses = q.all('SELECT * FROM courses ORDER BY id').map(c => ({
    id: c.id, name: c.name, voice_guide: c.voice_guide,
    readings: q.all('SELECT * FROM readings WHERE course_id = ? ORDER BY id', c.id).map(exportReading),
  }));
  res.send(JSON.stringify({ exported_at: new Date().toISOString(), courses }, null, 2));
});
