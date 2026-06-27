type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveThreshold(): Level {
  const raw = (process.env.ARGUS_LOG_LEVEL ?? 'info').toLowerCase();
  return raw in ORDER ? (raw as Level) : 'info';
}

const threshold = resolveThreshold();

function emit(level: Level, msg: string, meta?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  const sink = level === 'warn' || level === 'error' ? console.error : console.log;
  if (meta !== undefined) sink(line, meta);
  else sink(line);
}

export const logger = {
  debug: (msg: string, meta?: unknown) => emit('debug', msg, meta),
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
};
