import { Octokit } from '@octokit/rest';
import type { Config } from '../config.js';

export function createOctokit(config: Config): Octokit {
  return new Octokit({ auth: config.github.token });
}
