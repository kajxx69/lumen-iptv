import { configFromEnv } from './config.js';
import { createFakePortal } from './server.js';

const config = configFromEnv(process.env);
const portal = await createFakePortal(config);

const shutdown = (): void => {
  void portal.app.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await portal.app.listen({ host: config.host, port: config.port });
portal.app.log.info(
  { channels: portal.catalog.channels.length, entrypoints: config.entrypoints, chaos: config.chaosEnabled },
  `${config.portalName} prêt`,
);
