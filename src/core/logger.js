import pino from 'pino';
import { config } from '../config.js';

// In development, pino-pretty prints readable coloured lines.
// In production, plain JSON lines are written (easy to search and ship).
export const logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  transport: config.isProd || config.isTest
    ? undefined
    // req/res details are hidden here (the message already says "GET /jobs 200 12ms");
    // production JSON keeps them.
    : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname,req,res,responseTime' } },
});
