// The only file that talks to the AI service. To use a different provider,
// replace the body of callAnthropic() and keep the complete() signature.
import { config } from './env.js';

/**
 * @param {object} o
 * @param {'tutor'|'report'|'summary'} o.task
 * @param {Array<{type:'text',text:string,cache_control?:object}>} o.system
 * @param {Array<{role:'user'|'assistant',content:string}>} o.messages
 * @param {number} o.maxTokens
 * @returns {Promise<string>}
 */
export async function complete(o) {
  return config.provider === 'mock' ? mock(o) : callAnthropic(o);
}

async function callAnthropic({ system, messages, maxTokens }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: config.model, max_tokens: maxTokens, system, messages }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`AI request failed (${res.status}): ${detail.slice(0, 500)}`);
    const err = new Error('The AI service returned an error.');
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!text) { const err = new Error('The AI service returned an empty reply.'); err.status = 502; throw err; }
  return text;
}

// ---- Mock provider: lets you click through the whole app with no API key. ----
const MOCK_QUESTIONS = [
  '[Mock tutor] Thanks for sharing that. In your own words, what would you say is the main claim the author is making?',
  '[Mock tutor] Good start. What evidence or example from the reading best supports that claim?',
  '[Mock tutor] Which concept in the reading seemed most important to you, and how does it connect to the main claim?',
  '[Mock tutor] Was there anything you found confusing, surprising, or especially persuasive?',
  '[Mock tutor] How might these ideas apply to a new example the author did not mention? When you feel ready, you can press "Finish conversation".',
];

function mock({ task, messages }) {
  if (task === 'tutor') {
    const n = messages.filter(m => m.role === 'user').length - 2; // minus the hidden kickoff, zero-based
    return MOCK_QUESTIONS[Math.max(0, n) % MOCK_QUESTIONS.length];
  }
  if (task === 'report') {
    const m = /S1: ([^\n]{1,80})/.exec(messages[0].content);
    const quote = m ? m[1].trim() : '';
    return JSON.stringify({
      initial_reaction: { summary: '(Mock report) The student shared an opening reaction.', quote },
      accurate: [{ idea: '(Mock) Placeholder idea, not a real analysis', evidence: quote, support: 'limited' }],
      partial: [], possible_misconceptions: [], open_questions: [],
      final_reflection: { summary: '', quote: '' },
      not_discussed: [],
      evidence_note: 'This is a mock report produced without an AI service. Set AI_PROVIDER=anthropic for real reports.',
    });
  }
  return JSON.stringify({
    common_understanding: [], common_confusion: [], recurring_questions: [],
    topics_for_class: [], initial_reactions: '',
    caveats: 'This is a mock summary produced without an AI service.',
  });
}
