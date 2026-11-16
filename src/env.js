// Loads .env (if present) and validates configuration. Imported first by server.js.
try { process.loadEnvFile(); } catch { /* no .env file; rely on real environment variables */ }

const e = process.env;
const problems = [];
if (!e.INSTRUCTOR_PASSWORD || e.INSTRUCTOR_PASSWORD.length < 12)
  problems.push('INSTRUCTOR_PASSWORD must be set and at least 12 characters.');
if (!e.SESSION_SECRET || e.SESSION_SECRET.length < 32)
  problems.push('SESSION_SECRET must be set and at least 32 characters.');
const provider = (e.AI_PROVIDER || 'anthropic').toLowerCase();
if (!['anthropic', 'mock'].includes(provider)) problems.push('AI_PROVIDER must be "anthropic" or "mock".');
if (provider === 'anthropic' && !e.ANTHROPIC_API_KEY)
  problems.push('ANTHROPIC_API_KEY is missing. Add it, or set AI_PROVIDER=mock to try the app without it.');

if (problems.length) {
  console.error('\nConfiguration problem(s):\n- ' + problems.join('\n- ') + '\nSee .env.example.\n');
  process.exit(1);
}

export const config = {
  provider,
  apiKey: e.ANTHROPIC_API_KEY || '',
  model: e.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  port: Number(e.PORT) || 3000,
  dataDir: e.DATA_DIR || './data',
  production: e.NODE_ENV === 'production',
  embedOrigins: (e.EMBED_ORIGINS || '').trim(),
  minTurns: Math.max(1, Number(e.MIN_STUDENT_TURNS) || 4),
  maxTurns: Math.max(5, Number(e.MAX_STUDENT_TURNS) || 30),
  trustProxy: e.TRUST_PROXY === undefined ? 1 : Number(e.TRUST_PROXY) || 0,
  instructorPassword: e.INSTRUCTOR_PASSWORD,
  sessionSecret: e.SESSION_SECRET,
};
