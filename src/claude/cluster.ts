import type Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import type { BugReport, RawMessage } from '../types.js';
import { logger } from '../logger.js';
import { recordUsage } from './usage.js';
import { BUG_LIST_JSON_SCHEMA, BugListSchema } from './schemas.js';

const MAX_TOKENS = 32000;

const SYSTEM_PROMPT = `You are Argus, a triage assistant for a software project's Discord bug-reports channel. You read raw chat messages — which mix genuine bug reports with casual conversation, jokes, feature ideas, questions, and developer status updates — and extract distinct, actionable BUG reports.

A bug is a report of the software behaving incorrectly: crashes, errors, broken or unexpected behaviour, visual glitches, or things not working as intended.

Do NOT create bug reports for:
- casual conversation, jokes, or off-topic chat
- feature requests, ideas, or wishes (unless they describe an actual defect)
- developer status updates or release announcements (e.g. "0.12.5 up for testing")
- questions that are not describing a malfunction
- pure praise or reactions

Clustering rules:
- Group ALL messages discussing the SAME underlying bug into ONE report — even across multiple authors, replies, and threads. A back-and-forth diagnosing one issue is one bug, not several.
- Keep genuinely distinct bugs separate.
- When unsure whether something is a real bug, lean toward EXCLUDING it. Precision matters more than recall here — a human reviews the results.

For each bug:
- title: concise, specific, issue-ready (e.g. "Replacement guards spawn with wrong loadout after death").
- summary: one or two sentences.
- description: full detail in markdown, synthesising every related message — symptoms, context, version numbers, and conditions. Preserve concrete details reporters gave (loadouts, locations, exact steps).
- stepsToReproduce: an array of steps if the messages describe how to trigger it; omit if unknown.
- severity: one of low, medium, high, critical, unknown. Crashes or data loss are high/critical; minor cosmetic glitches are low; use unknown when unclear.
- area: the affected component or feature if identifiable (e.g. "guards", "loadout", "UI"); omit if unclear.
- sourceMessageIds: the IDs (the bracketed [id] values) of every message that contributed to this bug. Include all related messages.
- reporters: the Discord user IDs (the id=... values) of the people who reported or experienced the bug. Exclude people who only replied with jokes or unrelated chatter.

Each input message is formatted as:
[<messageId>] (<authorName> id=<authorId>) [thread:<id>]? (reply to <id>)? <content> (+attachments: ...)?

Return the structured bug list. If there are no genuine bugs, return an empty list.`;

function renderMessages(messages: RawMessage[]): string {
  return messages
    .map((m) => {
      const thread = m.threadId ? ` [thread:${m.threadId}]` : '';
      const reply = m.replyToId ? ` (reply to ${m.replyToId})` : '';
      const attachments = m.attachments.length
        ? ` (+attachments: ${m.attachments.map((a) => a.filename).join(', ')})`
        : '';
      const content = m.content.replace(/\s+/g, ' ').trim();
      return `[${m.id}] (${m.authorName} id=${m.authorId})${thread}${reply} ${content}${attachments}`;
    })
    .join('\n');
}

/**
 * Attach the verbatim source messages to a bug by looking up each of Claude's
 * sourceMessageIds in the ingested set. Ids with no matching message (rare) are
 * skipped. This gives downstream consumers (proposal card, GitHub issue) the
 * actual text without a second Discord fetch.
 */
function enrichSources(bug: BugReport, messages: RawMessage[]): BugReport {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const sourceMessages = bug.sourceMessageIds
    .map((id) => byId.get(id))
    .filter((m): m is RawMessage => m !== undefined)
    .map((m) => ({
      id: m.id,
      authorId: m.authorId,
      authorName: m.authorName,
      createdAt: m.createdAt,
      content: m.content,
      ...(m.attachments.length ? { attachments: m.attachments } : {}),
    }));
  return { ...bug, sourceMessages };
}

/**
 * Cluster raw messages into distinct bug reports via Claude with structured
 * outputs. Streams the request (large input/output), validates the result with
 * BugListSchema, and records token usage/cost.
 */
export async function clusterMessages(
  client: Anthropic,
  config: Config,
  messages: RawMessage[],
): Promise<BugReport[]> {
  if (messages.length === 0) return [];

  const stream = client.messages.stream({
    model: config.anthropic.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: renderMessages(messages) }],
    output_config: { format: { type: 'json_schema', schema: BUG_LIST_JSON_SCHEMA } },
  });

  const msg = await stream.finalMessage();
  recordUsage(config.anthropic.model, msg.usage, 'cluster');

  if (msg.stop_reason === 'refusal') {
    logger.warn('clustering refused by the model', msg.stop_details);
    return [];
  }
  if (msg.stop_reason === 'max_tokens') {
    logger.warn('clustering hit max_tokens; output may be truncated');
  }

  let text = '';
  for (const block of msg.content) {
    if (block.type === 'text') text += block.text;
  }
  if (text.trim().length === 0) {
    logger.warn('clustering produced no text output');
    return [];
  }

  try {
    const parsed = BugListSchema.parse(JSON.parse(text));
    return parsed.bugs.map((bug) => enrichSources(bug, messages));
  } catch (err) {
    logger.error(
      'failed to parse clustering output',
      err instanceof Error ? err.message : String(err),
    );
    logger.debug('raw clustering text (truncated)', text.slice(0, 2000));
    return [];
  }
}
