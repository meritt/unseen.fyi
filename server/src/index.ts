import { loadConfig } from './config.ts';
import { logger } from './log/log.ts';
import { startServer } from './server.ts';

const config = loadConfig();
const started = startServer(config);

logger.info('server_started', { port: config.port });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  logger.info('shutdown_signal', { errorClass: signal });
  await started.stop();
  process.exit(0);
};

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
