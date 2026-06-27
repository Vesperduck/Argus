import type Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import type { BugReport, MatchDecision } from '../types.js';
import { logger } from '../logger.js';
import { recordUsage } from './usage.js';
import { MATCH_DECISION_JSON_SCHEMA, MatchDecisionSchema } from './schemas.js';

/** A trimmed existing issue handed to Claude as a possible match. */
export interface CandidateIssue {
  number: number;
  title: string;
  body: string;
}

const MAX_TOKENS = 8000;

const SYSTEM_PROMPT = `You decide whether a newly-reported bug is already tracked by an existing GitHub issue.

You are given one NEW bug report and a list of CANDIDATE existing issues (each with a number, title, and body). Decide:

- If the new bug describes the SAME underlying defect as one candidate, return that candidate's issueNumber, and set newInformation to a concise markdown summary of any details the new report adds that are NOT already in that issue (new reproduction steps, additional affected conditions, version specifics, etc.). If the existing issue already covers everything, set newInformation to an empty string.
- If the new bug is NOT the same as any candidate, return issueNumber 0 and newInformation "".

Rules:
- Only match when it is genuinely the SAME bug. Sharing an area or component is not enough. When in doubt, return 0 (treat as new) — wrongly merging two distinct bugs is worse than creating a new issue a human can dedupe.
- issueNumber MUST be one of the candidate numbers, or 0. Never invent a number.
- newInformation must contain only genuinely new detail, written tersely. Do not restate what the issue already says.`;

function renderBug(bug: BugReport): string {
  const lines = [
    `Title: ${bug.title}`,
    `Severity: ${bug.severity}`,
  ];
  if (bug.area) lines.push(`Area: ${bug.area}`);
  lines.push(`Summary: ${bug.summary}`);
  lines.push(`Description: ${bug.description}`);
  if (bug.stepsToReproduce?.length) {
    lines.push('Steps to reproduce:');
    lines.push(...bug.stepsToReproduce.map((s, i) => `  ${i + 1}. ${s}`));
  }
  return lines.join('\n');
}

function renderCandidates(candidates: CandidateIssue[]): string {
  return candidates
    .map((c) => `#${c.number}: ${c.title}\n${c.body}`)
    .join('\n\n---\n\n');
}

/**
 * Decide whether a bug matches one of the candidate issues, and what new
 * information it adds. Returns { issueNumber: null } when there's no match.
 * Skips the API call (and cost) when there are no candidates.
 */
export async function judgeMatch(
  client: Anthropic,
  config: Config,
  bug: BugReport,
  candidates: CandidateIssue[],
): Promise<MatchDecision> {
  if (candidates.length === 0) {
    return { issueNumber: null, newInformation: '' };
  }

  const user = `New bug report:\n${renderBug(bug)}\n\nCandidate existing issues:\n${renderCandidates(candidates)}`;

  const stream = client.messages.stream({
    model: config.anthropic.model,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: MATCH_DECISION_JSON_SCHEMA } },
  });

  const msg = await stream.finalMessage();
  recordUsage(config.anthropic.model, msg.usage, 'merge');

  if (msg.stop_reason === 'refusal') {
    logger.warn('merge judgement refused by the model', msg.stop_details);
    return { issueNumber: null, newInformation: '' };
  }

  let text = '';
  for (const block of msg.content) {
    if (block.type === 'text') text += block.text;
  }

  try {
    const parsed = MatchDecisionSchema.parse(JSON.parse(text));
    const isKnown = parsed.issueNumber > 0 && candidates.some((c) => c.number === parsed.issueNumber);
    if (parsed.issueNumber > 0 && !isKnown) {
      logger.warn(`merge judgement named unknown issue #${parsed.issueNumber}; treating as new`);
    }
    return isKnown
      ? { issueNumber: parsed.issueNumber, newInformation: parsed.newInformation.trim() }
      : { issueNumber: null, newInformation: '' };
  } catch (err) {
    logger.error(
      'failed to parse merge decision',
      err instanceof Error ? err.message : String(err),
    );
    return { issueNumber: null, newInformation: '' };
  }
}
