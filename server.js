import { config } from './src/env.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './src/db.js';
import { student } from './src/routes-student.js';
import { instructor } from './src/routes-instructor.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, 'public');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

// Security headers. No third-party scripts, fonts, or trackers are loaded anywhere.
app.use((req, res, next) => {
  const instructorArea = req.path.startsWith('/instructor') || req.path.startsWith('/api/instructor');
  const frames = instructorArea ? "'none'" : `'self' ${config.embedOrigins}`.trim();
  res.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors ${frames}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/') || req.path.startsWith('/instructor')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
  }
  next();
});

app.use('/api', express.json({ limit: '2mb' }));
app.use('/api/instructor', instructor);
app.use('/api', student);

app.get('/r/:slug', (req, res) => { res.setHeader('X-Robots-Tag', 'noindex'); res.sendFile(path.join(pub, 'student.html')); });
app.get('/instructor', (req, res) => res.sendFile(path.join(pub, 'instructor.html')));
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use(express.static(pub, { index: false }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((req, res) => res.status(404).type('text').send('Page not found.'));

// Errors: show a plain message, keep details in the server log.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  const message = err.type === 'entity.too.large' ? 'That is too large to upload.'
    : status < 500 || status === 502 ? err.message : 'Something went wrong on the server.';
  res.status(status).json({ error: message });
});

app.listen(config.port, () => {
  console.log(`Reading tutor running on port ${config.port} (${config.provider === 'mock' ? 'MOCK AI: no real tutor' : 'model: ' + config.model})`);
  console.log(`Instructor area: http://localhost:${config.port}/instructor`);
});
