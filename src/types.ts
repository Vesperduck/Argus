/**
 * Shared domain types for Argus. These define the interfaces between modules so
 * each phase can be built and tested in isolation.
 */

export type BugSeverity = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export interface MessageAttachment {
  url: string;
  filename: string;
  contentType?: string;
}

/** A Discord message normalised for downstream processing. */
export interface RawMessage {
  id: string; // snowflake (globally time-ordered; also our cursor)
  channelId: string; // parent channel or thread id the message lives in
  threadId?: string; // set when the message came from a thread
  authorId: string;
  authorName: string;
  createdAt: string; // ISO 8601
  content: string;
  attachments: MessageAttachment[];
  replyToId?: string;
}

/**
 * A verbatim source message folded into a bug, captured at cluster time so a
 * developer resolving the bug can see exactly what was said (not just an id).
 */
export interface SourceMessage {
  id: string;
  authorId: string;
  authorName: string;
  createdAt: string; // ISO 8601
  content: string;
  attachments?: MessageAttachment[];
}

/** A single distinct bug, distilled by Claude from one or more messages. */
export interface BugReport {
  title: string;
  summary: string;
  description: string;
  stepsToReproduce?: string[];
  severity: BugSeverity;
  area?: string;
  // Kept for the fingerprint/dedup system (issue markers key off these ids).
  sourceMessageIds: string[];
  // The verbatim messages behind those ids, for developer context on resolution.
  sourceMessages: SourceMessage[];
  reporters: string[]; // Discord user IDs
}

/** Claude's decision on whether a bug matches an existing issue. */
export interface MatchDecision {
  issueNumber: number | null; // null => no match, create new
  newInformation: string; // '' when nothing new to add
}

/** The GitHub action a proposal will execute once approved. */
export type ProposalAction =
  | { kind: 'create' }
  | { kind: 'merge'; issueNumber: number; newInformation: string };

export type ProposalState = 'pending' | 'approved' | 'rejected' | 'expired';

/** A bug awaiting human confirmation in Discord. */
export interface Proposal {
  id: string; // argus-internal uuid
  discordMessageId: string; // the proposal message posted in the channel
  channelId?: string; // channel the proposal message lives in (optional for legacy state)
  bug: BugReport;
  action: ProposalAction;
  state: ProposalState;
  proposedAt: string; // ISO 8601
}

export interface Cursor {
  lastMessageId?: string;
  lastRunAt?: string;
}

/** The full durable state persisted between runs. */
export interface ArgusState {
  cursor: Cursor;
  pendingProposals: Proposal[];
}

/** Result of an ingestion pass: new messages plus the watermark to persist. */
export interface IngestResult {
  messages: RawMessage[];
  /**
   * The cursor to persist on success. May advance even when `messages` is empty
   * (first-run bootstrap), and may trail the channel's newest message when the
   * per-run cap left overflow for the next run.
   */
  newCursor?: string;
}

export interface IssueRef {
  number: number;
  url: string;
}

/** What happened to a single bug during a run — collected for the summary. */
export type SyncOutcome =
  | { action: 'created'; issue: IssueRef; bug: BugReport }
  | { action: 'updated'; issue: IssueRef; bug: BugReport }
  | { action: 'proposed'; proposal: Proposal }
  | { action: 'skipped'; reason: string; bug: BugReport }
  | { action: 'failed'; error: string; bug: BugReport };
