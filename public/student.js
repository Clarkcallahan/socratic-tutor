// Student page. All text is inserted with textContent (never as HTML).
const slug = location.pathname.split('/').filter(Boolean).pop();
const $ = id => document.getElementById(id);
const KEY = `reading-tutor:${slug}`;

// The private conversation token is kept in this browser so a refresh does not lose the conversation.
const store = {
  get() { try { return localStorage.getItem(KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(KEY, v); } catch { /* storage blocked: conversation lasts until the tab closes */ } },
  clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
};
let token = store.get();
let state = null;
let busy = false;

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Conversation-Token': token } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status });
  return data;
}

function bubble(role, text, pending) {
  const li = document.createElement('li');
  li.className = role + (pending ? ' pending' : '');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = role === 'tutor' ? 'AI tutor' : 'You';
  li.append(who, document.createTextNode(text));
  return li;
}

function render(scroll = true) {
  $('intro').classList.add('hidden');
  $('conversation').classList.remove('hidden');
  $('who').textContent = state.student_name;
  const chat = $('chat');
  chat.replaceChildren(...state.messages.map(m => bubble(m.role, m.content)));

  const complete = state.status === 'complete';
  $('composer').classList.toggle('hidden', complete);
  $('done').classList.toggle('hidden', !complete);
  const reflecting = state.status === 'reflection';
  $('text-label').textContent = reflecting ? 'Your final reflection' : 'Your response';
  $('finish').classList.toggle('hidden', reflecting);
  const remaining = state.min_turns - state.student_turns;
  $('finish').disabled = remaining > 0;
  $('finish-hint').textContent = reflecting ? '' : remaining > 0
    ? `You can finish after ${remaining} more response${remaining === 1 ? '' : 's'}.`
    : 'Finish whenever you are ready. You will be asked for one short reflection.';
  if (scroll) chat.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (!complete) $('text').focus({ preventScroll: true });
}

function setBusy(on) {
  busy = on;
  $('send').disabled = on;
  $('finish').disabled = on || (state && state.min_turns - state.student_turns > 0);
}

async function send() {
  if (busy) return;
  const text = $('text').value.trim();
  $('send-error').textContent = '';
  if (!text) { $('send-error').textContent = 'Please write a response first.'; return; }
  setBusy(true);
  const chat = $('chat');
  const mine = bubble('student', text);
  const waiting = bubble('tutor', 'Thinking…', true);
  chat.append(mine, waiting);
  waiting.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  try {
    state = await api('/conversation/messages', { method: 'POST', body: { text } });
    $('text').value = '';
    setBusy(false);
    render();
  } catch (err) {
    mine.remove(); waiting.remove();   // the text stays in the box so nothing is lost
    $('send-error').textContent = err.message;
    setBusy(false);
  }
}

$('composer').addEventListener('submit', e => { e.preventDefault(); send(); });
$('text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});

$('finish').addEventListener('click', async () => {
  if (busy) return;
  if ($('text').value.trim() && !confirm('You have an unsent response. Finish without sending it?')) return;
  setBusy(true);
  $('send-error').textContent = '';
  try { state = await api('/conversation/finish', { method: 'POST' }); $('text').value = ''; }
  catch (err) { $('send-error').textContent = err.message; }
  setBusy(false);
  render();
});

$('print').addEventListener('click', () => window.print());

$('start-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('start-error').textContent = '';
  try {
    const data = await api(`/readings/${slug}/conversations`, {
      method: 'POST', body: { name: $('name').value, consent: $('consent').checked },
    });
    token = data.token; store.set(token);
    state = data;
    render();
  } catch (err) { $('start-error').textContent = err.message; }
});

(async function init() {
  let reading;
  try { reading = await api(`/readings/${slug}`); }
  catch (err) { $('title').textContent = 'Reading not found'; $('page-error').textContent = err.message; return; }
  $('course').textContent = reading.course;
  $('title').textContent = reading.title;
  $('assignment').textContent = reading.assignment;
  document.title = `${reading.title} · Reading Conversation`;
  if (reading.source_url) {
    const a = document.createElement('a');
    a.href = reading.source_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open the reading';
    $('source').append(a, ' (opens in a new tab)');
    $('source').classList.remove('hidden');
  }
  if (token) {
    try { state = await api('/conversation'); render(false); return; }
    catch (err) { if (err.status === 404) { token = null; store.clear(); } else { $('page-error').textContent = err.message; return; } }
  }
  if (!reading.open) { $('page-error').textContent = 'This reading is not open for conversations right now.'; return; }
  $('intro').classList.remove('hidden');
})();
