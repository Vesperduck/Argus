import { makeURLSearchParams, type REST } from '@discordjs/rest';
import { MessageType, Routes } from 'discord-api-types/v10';
import type { APIMessage, APIThreadChannel } from 'discord-api-types/v10';
import type { Config } from '../config.js';
import type { Cursor, IngestResult, RawMessage } from '../types.js';
import { logger } from '../logger.js';

/** Safety bound so a runaway channel can't loop forever within one source. */
const MAX_PAGES_PER_SOURCE = 50;
const PAGE_SIZE = 100;

interface MessageSource {
  id: string; // channel id to read messages from (main channel or a thread)
  threadId?: string; // set when the source is a thread
}

/** Minimal shape of the thread-list endpoints we read. */
interface ThreadList {
  threads: APIThreadChannel[];
  has_more?: boolean;
}

function snowflakeAsc(a: RawMessage, b: RawMessage): number {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

function normalizeMessage(
  m: APIMessage,
  sourceChannelId: string,
  threadId?: string,
): RawMessage | null {
  if (m.author.bot) return null; // ignore bots, including Argus's own proposals
  if (m.type !== MessageType.Default && m.type !== MessageType.Reply) return null; // skip system messages
  const content = m.content ?? '';
  if (content.trim().length === 0 && m.attachments.length === 0) return null; // nothing usable

  return {
    id: m.id,
    channelId: sourceChannelId,
    threadId,
    authorId: m.author.id,
    authorName: m.author.global_name ?? m.author.username,
    createdAt: m.timestamp,
    content,
    attachments: m.attachments.map((a) => ({
      url: a.url,
      filename: a.filename,
      contentType: a.content_type,
    })),
    replyToId: m.referenced_message?.id ?? m.message_reference?.message_id ?? undefined,
  };
}

/** Page a single channel/thread forward from `after`, collecting normalised messages. */
async function fetchAfter(
  rest: REST,
  source: MessageSource,
  after: string,
): Promise<RawMessage[]> {
  const out: RawMessage[] = [];
  let cursor = after;

  for (let page = 0; page < MAX_PAGES_PER_SOURCE; page++) {
    const batch = (await rest.get(Routes.channelMessages(source.id), {
      query: makeURLSearchParams({ after: cursor, limit: PAGE_SIZE }),
    })) as APIMessage[];

    if (batch.length === 0) break;

    // Advance by the raw max id (pre-filter) so pagination never stalls on a
    // window that was entirely bots/system messages.
    let maxId = cursor;
    for (const m of batch) {
      if (BigInt(m.id) > BigInt(maxId)) maxId = m.id;
      const norm = normalizeMessage(m, source.id, source.threadId);
      if (norm) out.push(norm);
    }
    cursor = maxId;

    if (batch.length < PAGE_SIZE) break;
  }

  return out;
}

/** The channel's most recent message id, used to set the first-run watermark. */
async function latestMessageId(rest: REST, channelId: string): Promise<string | undefined> {
  const batch = (await rest.get(Routes.channelMessages(channelId), {
    query: makeURLSearchParams({ limit: 1 }),
  })) as APIMessage[];
  return batch[0]?.id;
}

async function getGuildId(rest: REST, channelId: string): Promise<string | undefined> {
  const channel = (await rest.get(Routes.channel(channelId))) as { guild_id?: string };
  return channel.guild_id;
}

/**
 * Collect thread sources for the channel: active threads (guild-scoped, filtered
 * to this channel) plus the first page of archived public threads. Threads with
 * no messages newer than `after` are skipped. Failures degrade to "main channel
 * only" rather than aborting the run.
 */
async function collectThreadSources(
  rest: REST,
  channelId: string,
  after: string,
): Promise<MessageSource[]> {
  const seen = new Set<string>();
  const sources: MessageSource[] = [];

  const consider = (t: APIThreadChannel): void => {
    if (t.parent_id !== channelId) return;
    if (seen.has(t.id)) return;
    const last = t.last_message_id;
    if (last && BigInt(last) <= BigInt(after)) return; // nothing new in this thread
    seen.add(t.id);
    sources.push({ id: t.id, threadId: t.id });
  };

  try {
    const guildId = await getGuildId(rest, channelId);
    if (guildId) {
      const active = (await rest.get(
        `/guilds/${guildId}/threads/active` as `/${string}`,
      )) as ThreadList;
      for (const t of active.threads) consider(t);
    }

    const archived = (await rest.get(
      `/channels/${channelId}/threads/archived/public` as `/${string}`,
      { query: makeURLSearchParams({ limit: PAGE_SIZE }) },
    )) as ThreadList;
    for (const t of archived.threads) consider(t);
  } catch (err) {
    logger.warn(
      'thread enumeration failed; ingesting main channel only',
      err instanceof Error ? err.message : String(err),
    );
  }

  return sources;
}

/**
 * Fetch new messages from one source channel and its threads since that
 * channel's cursor.
 *
 * - No cursor (first run for this channel): set the watermark to the channel's
 *   latest message and process nothing — Argus "watches from now" rather than
 *   backfilling history.
 * - Otherwise: page the main channel + threads after the cursor, merge, sort by
 *   snowflake, and cap at `maxMessages` (keeping the oldest, carrying overflow).
 */
export async function fetchNewMessages(
  rest: REST,
  config: Config,
  channelId: string,
  cursor: Cursor,
): Promise<IngestResult> {
  if (!cursor.lastMessageId) {
    const watermark = await latestMessageId(rest, channelId);
    logger.info('first run for channel — establishing watermark, no history processed', {
      channelId,
      watermark,
    });
    return { messages: [], newCursor: watermark };
  }

  const after = cursor.lastMessageId;
  const sources: MessageSource[] = [{ id: channelId }];
  sources.push(...(await collectThreadSources(rest, channelId, after)));
  logger.debug(`ingesting from ${sources.length} source(s)`, {
    channelId,
    threads: sources.length - 1,
  });

  const all: RawMessage[] = [];
  for (const source of sources) {
    all.push(...(await fetchAfter(rest, source, after)));
  }
  all.sort(snowflakeAsc);

  const max = config.behavior.maxMessages;
  const capped = all.length > max ? all.slice(0, max) : all;
  if (all.length > max) {
    logger.warn(`message cap hit (${max}); ${all.length - max} carried to the next run`);
  }

  const newCursor = capped.at(-1)?.id ?? after;
  return { messages: capped, newCursor };
}
