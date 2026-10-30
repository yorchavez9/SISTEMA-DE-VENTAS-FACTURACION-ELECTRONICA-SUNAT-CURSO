import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Nunca registrar credenciales ni datos de acceso.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'req.headers["x-api-key"]',
      'req.headers["x-api-secret"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.pin',
      '*.apiKey',
      '*.apiSecret',
      '*.secret',
    ],
    censor: '[oculto]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});
