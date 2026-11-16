// Assembles what is sent to the AI. The instructions live in /prompts as plain
// files and are re-read on each use, so edits take effect without a restart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const load = name => fs.readFileSync(path.join(dir, name), 'utf8').trim();

export const fixedMessages = () => JSON.parse(load('fixed-messages.json'));

const readingBlock = (course, reading) =>
  `# Assigned reading\n\nCourse: ${course.name}\nAssignment: ${reading.assignment || '(not specified)'}\n` +
  `Title: ${reading.title}\n\n<reading>\n${reading.content}\n</reading>`;

export function tutorSystem(course, reading, studentTurns, maxTurns) {
  const stable = [
    load('tutor.md'),
    `# Teaching-voice guide from the instructor\n\n${course.voice_guide.trim() || '(None provided. Use the default voice described above.)'}`,
    readingBlock(course, reading),
  ].join('\n\n');
  return [
    // The stable part is marked cacheable so repeat turns cost less.
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Progress note: the student has sent ${studentTurns} message(s). The app ends the conversation at ${maxTurns}. Around 8 to 12 student messages is a typical full conversation.` },
  ];
}

// The AI service requires a "user" turn first; the student never sees this line.
const KICKOFF = '[The student has opened the reading and is ready to begin.]';

export function tutorMessages(rows) {
  return [
    { role: 'user', content: KICKOFF },
    ...rows.map(m => ({ role: m.role === 'tutor' ? 'assistant' : 'user', content: m.content })),
  ];
}

export function transcriptText(rows) {
  let n = 0;
  return rows
    .filter(m => m.kind !== 'closing')
    .map(m => {
      if (m.role === 'tutor') return `T: ${m.content}`;
      if (m.kind === 'reflection') return `S (final reflection): ${m.content}`;
      return `S${++n}: ${m.content}`;
    })
    .join('\n\n');
}

export function reportRequest(course, reading, rows) {
  return {
    system: [{ type: 'text', text: load('report.md') + '\n\n' + readingBlock(course, reading), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `<transcript>\n${transcriptText(rows)}\n</transcript>\n\nWrite the report as JSON.` }],
  };
}

export function summaryRequest(course, reading, reports) {
  const body = reports.map((r, i) => `Student ${i + 1}:\n${JSON.stringify(r)}`).join('\n\n');
  return {
    system: [{ type: 'text', text: load('class-summary.md') }],
    messages: [{
      role: 'user',
      content: `Course: ${course.name}\nReading: ${reading.title}\nNumber of student reports: ${reports.length}\n\n<reports>\n${body}\n</reports>\n\nWrite the class summary as JSON.`,
    }],
  };
}
