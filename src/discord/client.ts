import { REST } from '@discordjs/rest';
import type { Config } from '../config.js';

export function createDiscordRest(config: Config): REST {
  return new REST({ version: '10' }).setToken(config.discord.token);
}
