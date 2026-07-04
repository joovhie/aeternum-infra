// scripts/render-runner.mjs
import http from 'http';
import { spawn } from 'child_process';

const PORT = process.env.PORT || 3000;

console.log('===================================================');
console.log('   AETERNUM INFRASTRUCTURE UNIFIED ORCHESTRATOR   ');
console.log('===================================================');

// 1. Start the HTTP Health Check Server immediately for Render/UptimeRobot
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

// 2. Resilient process spawning helper
function launchWorker(name, command, args) {
  console.log(`[Orchestrator]: Triggering launch cycle for ${name}...`);
  
  const processInstance = spawn(command, args, {
    stdio: 'inherit',
    shell: true
  });

  processInstance.on('error', (error) => {
    console.error(`[Orchestrator]: ${name} execution error:`, error);
  });

  processInstance.on('exit', (code) => {
    console.warn(`[Orchestrator]: WARNING — ${name} exited (Code ${code}). Restarting in 5s...`);
    setTimeout(() => launchWorker(name, command, args), 5000);
  });

  return processInstance;
}

// 3. Launch both applications using their clean production hooks
launchWorker('Ponder Indexer', 'pnpm', ['--filter', '@aeternum/indexer', 'run', 'start:prod']);
launchWorker('Keeper Engine', 'pnpm', ['--filter', '@aeternum/keeper', 'run', 'start:prod']);