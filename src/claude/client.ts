import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';

export function createAnthropic(config: Config): Anthropic {
  return new Anthropic({ apiKey: config.anthropic.apiKey });
}
