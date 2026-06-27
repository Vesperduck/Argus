/**
 * Standalone Discord access diagnostic — not part of the build (outside src/).
 * Run: npx tsx scripts/diagnose-discord.ts
 *
 * Checks token validity, then visibility + message-read for the SOURCE channel
 * (analysed) and the REVIEW channel (proposals posted there). When source and
 * review are the same channel, it's only checked once.
 */
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';

const token = process.env.DISCORD_BOT_TOKEN;
const sourceChannelId = process.env.DISCORD_SOURCE_CHANNEL_ID ?? process.env.DISCORD_CHANNEL_ID;
const reviewChannelId = process.env.DISCORD_REVIEW_CHANNEL_ID ?? sourceChannelId;

if (!token || !sourceChannelId) {
  console.error('Missing DISCORD_BOT_TOKEN or DISCORD_SOURCE_CHANNEL_ID/DISCORD_CHANNEL_ID in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

function describe(err: unknown): string {
  const e = err as { code?: number; status?: number; message?: string };
  return `code=${e.code ?? '?'} status=${e.status ?? '?'} ${e.message ?? String(err)}`;
}

let anyFailure = false;

// 1) Token validity + bot identity
try {
  const me = (await rest.get(Routes.user('@me'))) as { id: string; username: string };
  console.log(`[ok] token valid — bot: ${me.username} (${me.id})`);
} catch (err) {
  console.error(`[fail] token rejected: ${describe(err)}`);
  process.exit(1);
}

async function checkChannel(channelId: string, role: string, needsPost: boolean): Promise<void> {
  try {
    const ch = (await rest.get(Routes.channel(channelId))) as {
      name?: string;
      type: number;
      guild_id?: string;
    };
    console.log(`[ok] ${role} channel visible — name="${ch.name ?? '?'}" type=${ch.type}`);
  } catch (err) {
    anyFailure = true;
    console.error(`[fail] cannot access ${role} channel ${channelId}: ${describe(err)}`);
    console.error('      → bot not in the server, or lacks "View Channel" on this channel.');
    return;
  }

  try {
    const msgs = (await rest.get(Routes.channelMessages(channelId), {
      query: new URLSearchParams({ limit: '1' }),
    })) as Array<{ id: string }>;
    console.log(`[ok] ${role} channel readable — latest id: ${msgs[0]?.id ?? '(empty)'}`);
  } catch (err) {
    anyFailure = true;
    console.error(`[fail] cannot read ${role} message history: ${describe(err)}`);
    console.error('      → grant the bot "Read Message History" on this channel.');
  }

  if (needsPost) {
    console.log(
      `[info] ${role} channel also needs "Send Messages" + "Add Reactions" (not write-tested here).`,
    );
  }
}

await checkChannel(sourceChannelId, 'source', false);
if (reviewChannelId && reviewChannelId !== sourceChannelId) {
  await checkChannel(reviewChannelId, 'review', true);
} else {
  console.log('[info] review channel == source channel; it also needs Send Messages + Add Reactions.');
}

console.log(anyFailure ? '\nSome checks failed — see above.' : '\nAll checks passed.');
process.exit(anyFailure ? 1 : 0);
