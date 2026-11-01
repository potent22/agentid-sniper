// Importing this entry is inert. Only direct execution starts the installation.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from './src/application.mjs';
export { createApplication };
async function main() {
  const app = createApplication({ root: dirname(fileURLToPath(import.meta.url)), initialize: process.argv.includes('--initialize'), migrateLegacy: process.argv.includes('--migrate-legacy') });
  const stop = (signal) => app.stop(signal).catch((error) => { console.error(error.message); process.exit(1); });
  const onTerm = () => void stop('SIGTERM'), onInt = () => void stop('SIGINT');
  process.once('SIGTERM', onTerm); process.once('SIGINT', onInt);
  try {
    const result = await app.run();
    if (!result.drained) { console.error('Unclean shutdown; journals and lock retained for reconciliation'); process.exit(3); }
  } finally { process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
