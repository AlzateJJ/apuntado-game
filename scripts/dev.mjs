import './check-node.mjs';
import { spawn } from 'node:child_process';
const build = spawn(
  process.execPath,
  ['node_modules/typescript/bin/tsc', '-p', 'packages/contracts/tsconfig.json'],
  { stdio: 'inherit' },
);
const code = await new Promise((resolve) => build.on('exit', resolve));
if (code !== 0) process.exit(1);
const jobs = [
  ['--watch', '--import', 'tsx', 'apps/server/src/main.ts'],
  ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts'],
  ['node_modules/typescript/bin/tsc', '-p', 'packages/contracts/tsconfig.json', '--watch'],
].map((args) => spawn(process.execPath, args, { stdio: 'inherit' }));
let stopping = false;
const stop = () => {
  if (!stopping) {
    stopping = true;
    jobs.forEach((job) => job.kill());
  }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
jobs.forEach((job) =>
  job.on('exit', (code) => {
    if (!stopping) {
      stop();
      process.exitCode = code || 0;
    }
  }),
);
