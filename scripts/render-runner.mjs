// scripts/render-runner.mjs
import http from 'http';
import { spawn } from 'child_process';

const PORT = process.env.PORT || 3000;

console.log('===================================================');
console.log('   AETERNUM INFRASTRUCTURE UNIFIED ORCHESTRATOR   ');
console.log('===================================================');

// 1. Health server binds to Render's port immediately
http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Aeternum Infrastructure: Active');
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(PORT, () => {
  console.log(`[Orchestrator]: Health server monitoring port :${PORT}`);
});

// 2. Spawn helper
function launchWorker(name, command, args, internalPort) {
  console.log(`[Orchestrator]: Triggering launch cycle for ${name}...`);
  
  const processInstance = spawn(command, args, {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      PORT: internalPort
    }
  });

  processInstance.on('error', (error) => {
    console.error(`[Orchestrator]: ${name} execution error:`, error);
  });

  processInstance.on('exit', (code) => {
    console.warn(`[Orchestrator]: WARNING — ${name} exited (Code ${code}). Restarting in 5s...`);
    setTimeout(() => launchWorker(name, command, args, internalPort), 5000);
  });

  return processInstance;
}

// 3. Sequential Boot Sequence to prevent memory spikes colliding
// First: Fire up Ponder so it has maximum headroom to build/verify schemas
launchWorker('Ponder Indexer', 'pnpm', ['--filter', '@aeternum/indexer', 'run', 'start:prod'], '10001');

// Second: Delay Keeper engine by 30 seconds until Ponder completes initialization
console.log('[Orchestrator]: Staggering launch sequence. Keeper Engine queued for T+25s...');
setTimeout(() => {
  launchWorker('Keeper Engine', 'pnpm', ['--filter', '@aeternum/keeper', 'run', 'start:prod'], '10002');
}, 30000);