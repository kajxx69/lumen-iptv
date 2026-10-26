import { configFromEnv } from './config.js';
import { createServer } from './server.js';

const config = configFromEnv(process.env);
const server = await createServer(config);

const shutdown = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.app.listen({ host: config.host, port: config.port });
