import { z } from 'zod';

/**
 * Runtime (zod v3) validation of Claude's structured output. We validate the
 * model's JSON ourselves rather than relying on the SDK's zod-v4-based
 * `zodOutputFormat` helper, so the project stays on a single zod version.
 */
export const BugReportSchema = z.object({
  title: z.string(),
  summary: z.string(),
  description: z.string(),
  stepsToReproduce: z.array(z.string()).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical', 'unknown']),
  area: z.string().optional(),
  sourceMessageIds: z.array(z.string()),
  reporters: z.array(z.string()),
});

export const BugListSchema = z.object({
  bugs: z.array(BugReportSchema),
});

/**
 * Merge-judgement result. `issueNumber` is 0 when the bug is new (no match);
 * the orchestrator maps 0 -> null. `newInformation` is '' when nothing new.
 */
export const MatchDecisionSchema = z.object({
  issueNumber: z.number().int(),
  newInformation: z.string(),
});

export const MATCH_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    issueNumber: {
      type: 'integer',
      description:
        'The matching existing issue number, or 0 if this bug is new and not represented by any candidate.',
    },
    newInformation: {
      type: 'string',
      description:
        'Markdown describing ONLY information this report adds beyond the matched issue. Empty string if nothing new, or if issueNumber is 0.',
    },
  },
  required: ['issueNumber', 'newInformation'],
  additionalProperties: false,
};

/**
 * JSON Schema sent to the API via `output_config.format`. Must mirror
 * BugListSchema. Structured outputs require `additionalProperties: false` on
 * every object and list all non-optional fields in `required`.
 */
export const BUG_LIST_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Concise, issue-ready bug title' },
          summary: { type: 'string', description: 'One or two sentence overview' },
          description: {
            type: 'string',
            description: 'Full detail in markdown, synthesised from all related messages',
          },
          stepsToReproduce: {
            type: 'array',
            items: { type: 'string' },
            description: 'Steps to trigger the bug, if described',
          },
          severity: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical', 'unknown'],
          },
          area: {
            type: 'string',
            description: 'Affected component/feature, if identifiable',
          },
          sourceMessageIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of every message that contributed to this bug',
          },
          reporters: {
            type: 'array',
            items: { type: 'string' },
            description: 'Discord user IDs of the people who reported/experienced the bug',
          },
        },
        required: ['title', 'summary', 'description', 'severity', 'sourceMessageIds', 'reporters'],
        additionalProperties: false,
      },
    },
  },
  required: ['bugs'],
  additionalProperties: false,
};
