// scripts/render-runner.mjs
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';

const PORT = process.env.PORT || 3000;

console.log('===================================================');
console.log('   AETERNUM INFRASTRUCTURE UNIFIED ORCHESTRATOR   ');
console.log('===================================================');

// 1. Start the HTTP Health Check Server immediately to clear Render's boot-timeout guard
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Aeternum Infrastructure: Online');
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[Orchestrator]: Health server monitoring port :${PORT}`);
});

// 2. Thread runner helper with an auto-restart wrapper if a worker crashes
function launchWorker(name, command, args, options = {}) {
  console.log(`[Orchestrator]: Triggering launch cycle for ${name}...`);
  
  const processInstance = spawn(command, args, {
    stdio: 'inherit',
    shell: true,
    ...options
  });

  processInstance.on('error', (error) => {
    console.error(`[Orchestrator]: ${name} failed to process encounter:`, error);
  });

  processInstance.on('exit', (code) => {
    console.warn(`[Orchestrator]: WARNING — ${name} exited with status code [${code}]. Re-spinning process engine in 5s...`);
    setTimeout(() => launchWorker(name, command, args, options), 5000);
  });

  return processInstance;
}

// 3. Spawn the Ponder Indexer via pnpm filter
launchWorker('Ponder Indexer', 'pnpm', ['--filter', '@aeternum/indexer', 'start']);

// 4. Spawn the Keeper Bot targeting its built build-output artifact
launchWorker('Keeper Engine', 'node', [path.join('apps', 'keeper', 'dist', 'index.js')]);