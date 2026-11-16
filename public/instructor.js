// Instructor area. Small hash-routed page; all content is inserted as text, never as HTML.
const app = document.getElementById('app');
const errorBox = document.getElementById('error');
const statusBox = document.getElementById('status');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat(Infinity).filter(c => c != null && c !== false));
  return node;
}

const show = (...nodes) => app.replaceChildren(...nodes.flat(Infinity).filter(c => c != null && c !== false));

async function api(path, options = {}) {
  const res = await fetch('/api/instructor' + path, {
    method: options.method || 'GET',
    headers: options.raw ? { 'Content-Type': 'application/pdf' } : { 'Content-Type': 'application/json' },
    body: options.raw || (options.body ? JSON.stringify(options.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Please sign in.'); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const setError = msg => { errorBox.textContent = msg || ''; };
const setStatus = msg => { statusBox.textContent = msg || ''; };
const guard = fn => async (...args) => { setError(''); try { await fn(...args); } catch (err) { setStatus(''); setError(err.message); } };
const when = iso => (iso ? new Date(iso.replace(' ', 'T') + 'Z').toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const field = (id, label, input, hint) => [el('label', { for: id }, label, hint && el('span', { class: 'hint' }, hint)), input];
const crumbs = (...links) => el('p', { class: 'small no-print' }, links.flatMap((l, i) => [i ? ' › ' : '', l]));
const statusWord = { active: 'In progress', reflection: 'Awaiting reflection', complete: 'Finished' };

function downloadText(filename, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Sign in ----------
function showLogin() {
  document.getElementById('nav').classList.add('hidden');
  const pw = el('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true });
  show(
    el('h1', {}, 'Instructor sign-in'),
    el('form', { onsubmit: guard(async e => { e.preventDefault(); await api('/login', { method: 'POST', body: { password: pw.value } }); start(); }) },
      field('pw', 'Password', pw),
      el('div', { class: 'row' }, el('button', { type: 'submit' }, 'Sign in'))));
  pw.focus();
}

document.getElementById('logout').addEventListener('click', guard(async () => { await api('/logout', { method: 'POST' }); showLogin(); }));

// ---------- Courses ----------
async function coursesPage() {
  const courses = await api('/courses');
  const name = el('input', { type: 'text', id: 'c-name', maxlength: 200, required: true });
  show(
    el('h1', {}, 'Courses'),
    courses.length
      ? el('ul', {}, courses.map(c => el('li', {}, el('a', { href: `#/course/${c.id}` }, c.name), ` · ${c.readings} reading${c.readings === 1 ? '' : 's'}`)))
      : el('p', { class: 'muted' }, 'No courses yet. Create your first one below.'),
    el('h2', {}, 'Create a course'),
    el('form', { onsubmit: guard(async e => { e.preventDefault(); const { id } = await api('/courses', { method: 'POST', body: { name: name.value } }); location.hash = `#/course/${id}`; }) },
      field('c-name', 'Course name', name, 'For example: COMMS 351, Fall 2026'),
      el('div', { class: 'row' }, el('button', { type: 'submit' }, 'Create course'))));
}

async function coursePage(id) {
  const c = await api(`/courses/${id}`);
  const name = el('input', { type: 'text', id: 'c-name', maxlength: 200, value: c.name, required: true });
  const voice = el('textarea', { id: 'c-voice', rows: 7, maxlength: 4000, value: c.voice_guide });
  show(
    crumbs(el('a', { href: '#/' }, 'Courses')),
    el('h1', {}, c.name),
    el('h2', {}, 'Readings'),
    c.readings.length
      ? el('div', { class: 'table-scroll' }, el('table', {},
          el('thead', {}, el('tr', {}, ['Reading', 'Assignment', 'Conversations', 'Status'].map(h => el('th', { scope: 'col' }, h)))),
          el('tbody', {}, c.readings.map(r => el('tr', {},
            el('td', {}, el('a', { href: `#/reading/${r.id}` }, r.title)), el('td', {}, r.assignment), el('td', {}, String(r.conversations)),
            el('td', {}, r.is_open ? 'Open' : 'Closed'))))))
      : el('p', { class: 'muted' }, 'No readings yet.'),
    el('div', { class: 'row' }, el('a', { class: 'button', href: `#/course/${id}/new-reading` }, 'Add a reading')),
    el('h2', {}, 'Course settings'),
    el('form', { onsubmit: guard(async e => { e.preventDefault(); await api(`/courses/${id}`, { method: 'PUT', body: { name: name.value, voice_guide: voice.value } }); setStatus('Saved.'); }) },
      field('c-name', 'Course name', name),
      field('c-voice', 'Teaching-voice guide', voice,
        'A short note on how you talk with students: tone, favorite kinds of questions, phrases you use, what you care about. The tutor follows it but always identifies itself as an AI.'),
      el('div', { class: 'row' }, el('button', { type: 'submit' }, 'Save settings'),
        el('button', { type: 'button', class: 'danger', onclick: guard(async () => {
          if (!confirm(`Delete "${c.name}" with all of its readings, student conversations, and reports? This cannot be undone.`)) return;
          await api(`/courses/${id}`, { method: 'DELETE' }); location.hash = '#/';
        }) }, 'Delete course'))));
}

// ---------- Reading form (new and edit) ----------
function readingForm(r, onSave) {
  const title = el('input', { type: 'text', id: 'r-title', maxlength: 300, value: r.title || '', required: true });
  const assignment = el('input', { type: 'text', id: 'r-assign', maxlength: 300, value: r.assignment || '' });
  const url = el('input', { type: 'url', id: 'r-url', maxlength: 1000, value: r.source_url || '' });
  const content = el('textarea', { id: 'r-content', rows: 14, value: r.content || '', required: true });
  const open = el('input', { type: 'checkbox', checked: r.is_open !== 0 });
  const pdfNote = el('p', { class: 'small muted', role: 'status' });
  const pdf = el('input', { type: 'file', id: 'r-pdf', accept: 'application/pdf', onchange: guard(async () => {
    const file = pdf.files[0]; if (!file) return;
    if (content.value.trim() && !confirm('Replace the text in the box with the text from this PDF?')) return;
    pdfNote.textContent = 'Reading the PDF…';
    const out = await api('/extract-pdf', { method: 'POST', raw: file });
    content.value = out.text;
    pdfNote.textContent = `Extracted ${out.pages} page${out.pages === 1 ? '' : 's'}. ${out.warning || 'Please skim the text below and tidy anything that came through badly (headers, footnotes, columns).'}`;
  }) });
  return el('form', { onsubmit: guard(async e => {
      e.preventDefault();
      await onSave({ title: title.value, assignment: assignment.value, source_url: url.value, content: content.value, is_open: open.checked });
    }) },
    field('r-title', 'Reading title', title),
    field('r-assign', 'Assignment name', assignment, 'Optional. For example: Week 3 reading.'),
    field('r-url', 'Link to the reading', url, 'Optional. Shown to students so they can open the reading. The text below is never shown to students; it is only given to the tutor.'),
    field('r-pdf', 'Upload a PDF', pdf, 'Optional. The text is extracted into the box below with [Page N] markers so the tutor can point to pages.'),
    pdfNote,
    field('r-content', 'Reading text', content, 'Paste the text, or upload a PDF above. Keep section headings if you can: the tutor uses them to point students to passages.'),
    r.id && el('label', { class: 'check' }, open, el('span', {}, 'Open for new student conversations')),
    el('div', { class: 'row' }, el('button', { type: 'submit' }, r.id ? 'Save reading' : 'Add reading')));
}

async function newReadingPage(courseId) {
  const c = await api(`/courses/${courseId}`);
  show(
    crumbs(el('a', { href: '#/' }, 'Courses'), el('a', { href: `#/course/${courseId}` }, c.name)),
    el('h1', {}, 'Add a reading'),
    readingForm({}, async body => { const { id } = await api(`/courses/${courseId}/readings`, { method: 'POST', body }); location.hash = `#/reading/${id}`; }));
}

// ---------- Reading: conversations, summary, export, delete ----------
async function readingPage(id) {
  const r = await api(`/readings/${id}`);
  const link = `${location.origin}/r/${r.slug}`;
  const embed = `<iframe src="${link}" title="Reading conversation: ${r.title.replace(/"/g, '&quot;')}" style="width:100%;height:85vh;border:0"></iframe>`;
  const withText = r.conversations.filter(v => v.student_turns > 0);
  const needReport = withText.filter(v => v.report !== 'current');

  const buildSummary = guard(async () => {
    if (!withText.length) throw new Error('No student has responded yet.');
    let done = 0;
    for (const v of needReport) {
      setStatus(`Writing student reports: ${++done} of ${needReport.length}…`);
      await api(`/conversations/${v.id}/report`, { method: 'POST' });
    }
    setStatus('Writing the class summary…');
    await api(`/readings/${id}/summary`, { method: 'POST' });
    setStatus('');
    location.hash = `#/summary/${id}`;
  });

  show(
    crumbs(el('a', { href: '#/' }, 'Courses'), el('a', { href: `#/course/${r.course_id}` }, r.course_name)),
    el('p', { class: 'eyebrow' }, r.assignment || 'Reading'),
    el('h1', {}, r.title),
    el('p', { class: 'muted' }, r.is_open ? 'Open for student conversations.' : 'Closed: students cannot start new conversations.'),

    el('h2', {}, 'Student link'),
    el('p', {}, 'Give students this link (for example, on your course page or in your LMS):'),
    el('code', { class: 'block' }, link),
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'secondary', onclick: guard(async () => { await navigator.clipboard.writeText(link); setStatus('Link copied.'); }) }, 'Copy link'),
      el('a', { class: 'button secondary', href: link, target: '_blank', rel: 'noopener' }, 'Preview as a student')),
    el('details', {}, el('summary', {}, 'Embed on a web page'),
      el('p', { class: 'small' }, 'Paste this into a Custom HTML block. The site you embed on must be listed in EMBED_ORIGINS on the server.'),
      el('code', { class: 'block' }, embed)),

    el('h2', {}, `Conversations (${r.conversations.length})`),
    r.conversations.length
      ? el('div', { class: 'table-scroll' }, el('table', {},
          el('thead', {}, el('tr', {}, ['Student', 'Started', 'Status', 'Responses', 'Report'].map(h => el('th', { scope: 'col' }, h)))),
          el('tbody', {}, r.conversations.map(v => el('tr', {},
            el('td', {}, el('a', { href: `#/conversation/${v.id}` }, v.student_name)),
            el('td', {}, when(v.started_at)), el('td', {}, statusWord[v.status] || v.status), el('td', {}, String(v.student_turns)),
            el('td', {}, v.report === 'current' ? 'Ready' : v.report === 'stale' ? 'Out of date' : 'Not written'))))))
      : el('p', { class: 'muted' }, 'No conversations yet.'),

    el('h2', {}, 'Class summary'),
    r.summary
      ? el('p', {}, `Written ${when(r.summary.generated_at)} from ${r.summary.students_included} student report${r.summary.students_included === 1 ? '' : 's'}.`,
          r.summary.stale && ' Reports have changed since then.')
      : el('p', { class: 'muted' }, 'Not written yet.'),
    el('div', { class: 'row' },
      r.summary && el('a', { class: 'button', href: `#/summary/${id}` }, 'View class summary'),
      el('button', { type: 'button', class: r.summary ? 'secondary' : '', onclick: buildSummary },
        r.summary ? 'Rewrite summary' : 'Write class summary'),
      needReport.length > 0 && el('span', { class: 'small muted' }, `This will first write ${needReport.length} student report${needReport.length === 1 ? '' : 's'}.`)),

    el('h2', {}, 'Export and delete'),
    el('div', { class: 'row' },
      el('a', { class: 'button secondary', href: `/api/instructor/readings/${id}/export.json` }, 'Export everything (JSON)'),
      el('a', { class: 'button secondary', href: `/api/instructor/readings/${id}/export.csv` }, 'Export transcripts (CSV)'),
      el('button', { type: 'button', class: 'danger', onclick: guard(async () => {
        if (!confirm('Delete ALL student conversations and reports for this reading? This cannot be undone. Export first if you need a copy.')) return;
        await api(`/readings/${id}/conversations`, { method: 'DELETE' }); route();
      }) }, 'Delete all conversations'),
      el('button', { type: 'button', class: 'danger', onclick: guard(async () => {
        if (!confirm('Delete this reading and all of its conversations and reports? This cannot be undone.')) return;
        await api(`/readings/${id}`, { method: 'DELETE' }); location.hash = `#/course/${r.course_id}`;
      }) }, 'Delete reading')),

    el('details', {}, el('summary', {}, 'Edit reading'),
      readingForm(r, async body => { await api(`/readings/${id}`, { method: 'PUT', body }); setStatus('Saved.'); route(); })));
}

// ---------- Report rendering ----------
const supportLabel = { strong: 'Well supported', moderate: 'Some support', limited: 'Limited evidence: tentative' };
const tag = s => el('span', { class: `tag ${s}` }, supportLabel[s] || s);
const quote = (text, verified) => text && [
  el('blockquote', {}, `“${text}”`),
  verified === false && el('p', { class: 'unverified' }, 'Note: this quote could not be matched word for word in the transcript. Check it against the conversation.')];
const empty = () => el('p', { class: 'muted' }, 'Nothing noted.');
const findings = (list, render) => (list.length ? list.map(render) : empty());

function reportView(rp) {
  return [
    el('div', { class: 'notice' },
      el('strong', {}, 'How to read this report. '),
      'It is an AI-drafted description of what this student showed in one conversation, not a grade. Each point is tagged by how well the conversation supports it. Ideas that never came up are untested, not misunderstood.',
      rp.evidence_note && el('p', { class: 'gap-top' }, el('strong', {}, 'Amount of evidence: '), rp.evidence_note,
        ` (${rp.student_turns} student response${rp.student_turns === 1 ? '' : 's'}; conversation ${rp.conversation_status === 'complete' ? 'finished' : 'not finished'}.)`)),
    el('h3', {}, 'Explained accurately'),
    findings(rp.accurate, f => el('div', { class: 'finding' }, el('strong', {}, f.idea), ' ', tag(f.support), quote(f.evidence, f.evidence_verified))),
    el('h3', {}, 'Understood partially or unclearly'),
    findings(rp.partial, f => el('div', { class: 'finding' }, el('strong', {}, f.idea), ' ', tag(f.support),
      f.what_is_unclear && el('p', { class: 'tight' }, f.what_is_unclear), quote(f.evidence, f.evidence_verified))),
    el('h3', {}, 'Possible misconceptions'),
    findings(rp.possible_misconceptions, f => el('div', { class: 'finding' }, el('strong', {}, f.description), ' ', tag(f.support), quote(f.evidence, f.evidence_verified))),
    el('h3', {}, 'Open questions'),
    rp.open_questions.length ? el('ul', {}, rp.open_questions.map(x => el('li', {}, x))) : empty(),
    el('h3', {}, 'Final reflection'),
    rp.final_reflection.summary ? [el('p', {}, rp.final_reflection.summary), quote(rp.final_reflection.quote, rp.final_reflection.verified)] : el('p', { class: 'muted' }, 'No final reflection was written.'),
    el('h3', {}, 'Main ideas that did not come up'),
    rp.not_discussed.length ? el('ul', {}, rp.not_discussed.map(x => el('li', {}, x))) : empty(),
    el('h3', {}, 'Initial reaction to the reading'),
    el('p', { class: 'small muted' }, 'Kept separate: a reaction is not evidence of comprehension.'),
    rp.initial_reaction.summary ? [el('p', {}, rp.initial_reaction.summary), quote(rp.initial_reaction.quote, rp.initial_reaction.verified)] : empty(),
    el('p', { class: 'small muted' }, `Report drafted ${when(rp.generated_at)} by ${rp.model}.`),
  ];
}

function reportMarkdown(v, rp) {
  const items = (list, f) => (list.length ? list.map(f).join('\n') : '- Nothing noted.');
  const ev = (q, ok) => (q ? `\n  > "${q}"${ok === false ? ' (quote not matched word for word in transcript)' : ''}` : '');
  return [
    `# Reading conversation report: ${v.student_name}`,
    `${v.course_name} · ${v.reading_title}${v.assignment ? ' · ' + v.assignment : ''}`,
    `AI-drafted description of one conversation. Not a grade. ${rp.evidence_note}`,
    `## Explained accurately\n${items(rp.accurate, f => `- ${f.idea} [${supportLabel[f.support]}]${ev(f.evidence, f.evidence_verified)}`)}`,
    `## Understood partially or unclearly\n${items(rp.partial, f => `- ${f.idea} [${supportLabel[f.support]}]${f.what_is_unclear ? '\n  ' + f.what_is_unclear : ''}${ev(f.evidence, f.evidence_verified)}`)}`,
    `## Possible misconceptions\n${items(rp.possible_misconceptions, f => `- ${f.description} [${supportLabel[f.support]}]${ev(f.evidence, f.evidence_verified)}`)}`,
    `## Open questions\n${items(rp.open_questions, x => `- ${x}`)}`,
    `## Final reflection\n${rp.final_reflection.summary || 'None written.'}${ev(rp.final_reflection.quote, rp.final_reflection.verified)}`,
    `## Main ideas that did not come up\n${items(rp.not_discussed, x => `- ${x}`)}`,
    `## Initial reaction (separate from comprehension)\n${rp.initial_reaction.summary || 'None noted.'}${ev(rp.initial_reaction.quote, rp.initial_reaction.verified)}`,
    `Drafted ${when(rp.generated_at)} by ${rp.model}.`,
  ].join('\n\n') + '\n';
}

async function conversationPage(id) {
  const v = await api(`/conversations/${id}`);
  const rp = v.report;
  const write = guard(async () => { setStatus('Writing the report…'); await api(`/conversations/${id}/report`, { method: 'POST' }); setStatus(''); route(); });
  const kindLabel = { reflection_prompt: ' (final reflection question)', reflection: ' (final reflection)' };
  show(
    crumbs(el('a', { href: '#/' }, 'Courses'), el('a', { href: `#/reading/${v.reading_id}` }, v.reading_title)),
    el('p', { class: 'eyebrow' }, `${v.course_name} · ${v.reading_title}`),
    el('h1', {}, v.student_name),
    el('p', { class: 'muted' }, `${statusWord[v.status]} · started ${when(v.started_at)}${v.completed_at ? ' · finished ' + when(v.completed_at) : ''}`),
    el('div', { class: 'row no-print' },
      el('button', { type: 'button', class: rp ? 'secondary' : '', onclick: write }, rp ? 'Rewrite report' : 'Write report'),
      rp && el('button', { type: 'button', class: 'secondary', onclick: () => window.print() }, 'Print'),
      rp && el('button', { type: 'button', class: 'secondary', onclick: () => downloadText(`report-${v.student_name.replace(/\W+/g, '-')}.md`, reportMarkdown(v, rp)) }, 'Download report'),
      el('button', { type: 'button', class: 'danger', onclick: guard(async () => {
        if (!confirm(`Delete ${v.student_name}'s conversation and report? This cannot be undone.`)) return;
        await api(`/conversations/${id}`, { method: 'DELETE' }); location.hash = `#/reading/${v.reading_id}`;
      }) }, 'Delete conversation')),
    el('h2', {}, 'Report'),
    rp ? [rp.stale && el('div', { class: 'notice warning no-print' }, 'The student has written more since this report was drafted. Rewrite it to include the new responses.'), reportView(rp)]
       : el('p', { class: 'muted' }, 'No report yet. Reports are drafted on request so you control when student text is analyzed.'),
    el('h2', {}, 'Conversation'),
    el('ol', { class: 'chat' }, v.messages.map(m => el('li', { class: m.role },
      el('span', { class: 'who' }, (m.role === 'tutor' ? 'AI tutor' : v.student_name) + (kindLabel[m.kind] || '')), m.content))));
}

// ---------- Class summary ----------
async function summaryPage(id) {
  const r = await api(`/readings/${id}`);
  const s = r.summary;
  if (!s) { location.hash = `#/reading/${id}`; return; }
  const pattern = p => el('div', { class: 'finding' }, el('strong', {}, p.topic), ' ', tag(p.support),
    p.approx_students && el('span', { class: 'small muted' }, ` ${p.approx_students}`), p.detail && el('p', { class: 'tight' }, p.detail));
  const md = () => {
    const items = (list, f) => (list.length ? list.map(f).join('\n') : '- Nothing noted.');
    const pat = p => `- ${p.topic} [${supportLabel[p.support]}${p.approx_students ? '; ' + p.approx_students : ''}]${p.detail ? '\n  ' + p.detail : ''}`;
    return [`# Class summary: ${r.title}`, `${r.course_name}${r.assignment ? ' · ' + r.assignment : ''} · ${s.students_included} student report(s)`,
      `AI-drafted from individual conversation reports. Not a grade. ${s.caveats}`,
      `## Topics to address in class\n${items(s.topics_for_class, t => `- ${t.topic}${t.why ? ': ' + t.why : ''}`)}`,
      `## Common areas of understanding\n${items(s.common_understanding, pat)}`,
      `## Common areas of confusion\n${items(s.common_confusion, pat)}`,
      `## Recurring questions\n${items(s.recurring_questions, x => `- ${x}`)}`,
      `## Initial reactions (separate from comprehension)\n${s.initial_reactions || 'None noted.'}`,
      `Drafted ${when(s.generated_at)} by ${s.model}.`].join('\n\n') + '\n';
  };
  show(
    crumbs(el('a', { href: '#/' }, 'Courses'), el('a', { href: `#/reading/${id}` }, r.title)),
    el('p', { class: 'eyebrow' }, `${r.course_name} · class summary`),
    el('h1', {}, r.title),
    el('div', { class: 'row no-print' },
      el('button', { type: 'button', class: 'secondary', onclick: () => window.print() }, 'Print'),
      el('button', { type: 'button', class: 'secondary', onclick: () => downloadText(`class-summary-reading-${id}.md`, md()) }, 'Download summary')),
    s.stale && el('div', { class: 'notice warning no-print' }, 'Student reports have changed since this summary was drafted. Rewrite it from the reading page to include them.'),
    el('div', { class: 'notice' },
      el('strong', {}, 'How to read this summary. '),
      `It is an AI-drafted synthesis of ${s.students_included} individual conversation report${s.students_included === 1 ? '' : 's'}, not a measure of the class. Counts are approximate.`,
      s.students_included < 5 && ' With this few students, treat every pattern as tentative.',
      s.caveats && el('p', { class: 'gap-top' }, el('strong', {}, 'Limits: '), s.caveats)),
    el('h2', {}, 'Useful topics to address in class'),
    s.topics_for_class.length ? el('ul', {}, s.topics_for_class.map(t => el('li', {}, el('strong', {}, t.topic), t.why && `: ${t.why}`))) : empty(),
    el('h2', {}, 'Common areas of understanding'), findings(s.common_understanding, pattern),
    el('h2', {}, 'Common areas of confusion'), findings(s.common_confusion, pattern),
    el('h2', {}, 'Recurring questions'),
    s.recurring_questions.length ? el('ul', {}, s.recurring_questions.map(x => el('li', {}, x))) : empty(),
    el('h2', {}, 'Initial reactions to the reading'),
    el('p', { class: 'small muted' }, 'Kept separate: reactions are not evidence of comprehension.'),
    s.initial_reactions ? el('p', {}, s.initial_reactions) : empty(),
    el('p', { class: 'small muted' }, `Summary drafted ${when(s.generated_at)} by ${s.model}.`));
}

// ---------- Router ----------
const route = guard(async () => {
  setStatus('');
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [a, b, c] = parts;
  if (a === 'course' && b && c === 'new-reading') await newReadingPage(b);
  else if (a === 'course' && b) await coursePage(b);
  else if (a === 'reading' && b) await readingPage(b);
  else if (a === 'conversation' && b) await conversationPage(b);
  else if (a === 'summary' && b) await summaryPage(b);
  else await coursesPage();
  window.scrollTo(0, 0);
  app.querySelector('h1')?.setAttribute('tabindex', '-1');
  app.querySelector('h1')?.focus({ preventScroll: true });
});

async function start() {
  setError('');
  const me = await fetch('/api/instructor/me').then(r => r.json());
  document.getElementById('mock-banner').classList.toggle('hidden', !me.mock);
  if (!me.signedIn) return showLogin();
  document.getElementById('nav').classList.remove('hidden');
  route();
}
window.addEventListener('hashchange', route);
start();
