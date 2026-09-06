import { parseConfig } from './config.js';

try {
  const config = parseConfig(process.env);
  // Replaced by the real server bootstrap once http/ exists.
  console.log(`@portionium/api: config ok, ${config.NODE_ENV}, port ${config.PORT}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
