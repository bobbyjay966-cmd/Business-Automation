#!/usr/bin/env node
/**
 * `npm run tunnel` — one-command dev workflow.
 *
 *   1. Verifies ngrok is installed.
 *   2. Refuses to run if port $PORT (default 3000) is already busy so
 *      the user doesn't see EADDRINUSE from a stale `npm run dev`.
 *   3. Spawns ngrok http $PORT in the background.
 *   4. Polls http://127.0.0.1:4040/api/tunnels for the public HTTPS URL.
 *      (Polling the local Ngrok HTTP API is dramatically more reliable
 *      than parsing ngrok's updog-shaped stdout, which varies between
 *      CLI versions and OSes.)
 *   5. Writes the URL into .env as APP_URL="<url>", preserving every
 *      other line in the file.
 *   6. Spawns `npm run dev` so the Express server picks up the new
 *      APP_URL on boot and registers the right CallRail/Stripe
 *      webhook endpoints.
 *   7. Forwards Ctrl-C / SIGTERM to both children so a single keystroke
 *      tears down the tunnel + the dev server cleanly.
 *
 * Usage:
 *   npm run tunnel
 *   PORT=4000 npm run tunnel
 *
 * Prerequisites:
 *   - ngrok installed (brew install ngrok / snap install ngrok /
 *     winget install Ngrok.Ngrok / https://ngrok.com/download)
 *   - ngrok authenticated (`ngrok authtoken <token>`)
 *   - .env file present (created from .env.example with real values)
 *
 * Read the resulting APP_URL via http://127.0.0.1:4040 in another tab
 * to watch incoming webhook traffic from CallRail / Stripe / etc.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const NGROK_API = 'http://127.0.0.1:4040';
const NGROK_TUNNELS_PATH = '/api/tunnels';
const ENV_FILE = path.resolve(process.cwd(), '.env');
const TUNNEL_POLL_MS = 500;
const TUNNEL_TIMEOUT_MS = 30_000;

const log = (...a) => console.log('[tunnel]', ...a);
const err = (...a) => console.error('[tunnel]', ...a);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hasNgrok() {
  try {
    // timeout: 5s — if ngrok is half-installed or hangs on Windows
    // (NTFS / toast notification registry weirdness), the script must
    // not block forever.
    const out = execFileSync(
      'ngrok',
      ['version'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
    )
      .toString()
      .trim();
    log(`Found ${out}`);
    return true;
  } catch {
    return false;
  }
}

function isPortBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', (e) => resolve(e.code === 'EADDRINUSE'))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, host);
  });
}

function fetchJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Bad JSON from ${url}: ${body.slice(0, 200)}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

async function waitForTunnelUrl() {
  const deadline = Date.now() + TUNNEL_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const data = await fetchJson(`${NGROK_API}${NGROK_TUNNELS_PATH}`);
      const tunnel = (data.tunnels || []).find((t) => t.proto === 'https');
      if (tunnel && tunnel.public_url) return tunnel.public_url;
    } catch (e) {
      lastErr = e;
    }
    await sleep(TUNNEL_POLL_MS);
  }
  throw new Error(
    `Timed out after ${TUNNEL_TIMEOUT_MS}ms waiting for ngrok to publish a tunnel on :${PORT}. ` +
    `Last error: ${lastErr ? lastErr.message : 'no tunnel yet'}`,
  );
}

function updateEnvFile(url) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = `APP_URL="${url}"`;
  const re = /^APP_URL=.*$/m;
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    const sep = text.length && !text.endsWith('\n') ? '\n' : '';
    text += `${sep}${line}\n`;
  }
  fs.writeFileSync(ENV_FILE, text, 'utf8');
  log(`Wrote APP_URL=${url} to ${path.relative(process.cwd(), ENV_FILE)}`);
}

function installSignalForwarding(child, label) {
  child.stdout?.on('data', (b) => process.stdout.write(`[${label}] ${b}`));
  child.stderr?.on('data', (b) => process.stderr.write(`[${label}] ${b}`));
}

async function main() {
  if (!hasNgrok()) {
    err('ngrok is not installed or not on PATH.\n');
    console.error([
      'Install ngrok for your OS:',
      '  macOS:   brew install ngrok',
      '  Linux:   snap install ngrok',
      '           or download from https://ngrok.com/download',
      '  Windows: winget install Ngrok.Ngrok',
      '           or scoop install ngrok',
      '',
      'After installing, authenticate once:',
      '  ngrok authtoken <your_token_from https://dashboard.ngrok.com>',
      '',
    ].join('\n'));
    process.exit(127);
  }

  if (await isPortBusy(PORT)) {
    err(`Port ${PORT} is already in use.`);
    console.error([
      '',
      '`npm run tunnel` will spawn `npm run dev`, which needs :' + PORT + ' free.',
      'Stop the existing dev server (Ctrl-C in its terminal) and re-run,',
      'or run `npm run tunnel` with a different PORT:',
      '  PORT=4000 npm run tunnel',
      '',
    ].join('\n'));
    process.exit(1);
  }

  // Shared teardown: kills ngrok AND dev no matter WHICH one exits
  // unexpectedly. Without this, an ngrok crash would leave the dev
  // server running orphaned; without this on Windows, SIGINT from
  // Ctrl-C wouldn't reliably kill the spawn('npm', ['run','dev']) child.
  let ngrok = null;
  let dev = null;
  let cleanedUp = false;
  const killAll = (reason, exitCode) => {
    if (cleanedUp) return;
    cleanedUp = true;
    log(`${reason} — stopping ngrok + dev server.`);
    for (const child of [ngrok, dev]) {
      if (child && child.exitCode === null && !child.killed) {
        try { child.kill('SIGTERM'); } catch {}
      }
    }
    // Give both children 250ms to exit cleanly, then drop the curtain.
    // setImmediate prevents the timer from holding the loop open if
    // both children exited already.
    setTimeout(() => process.exit(exitCode), 250);
  };

  log(`Starting ngrok → http://localhost:${PORT}`);
  ngrok = spawn('ngrok', ['http', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  installSignalForwarding(ngrok, 'ngrok');
  // Symmetry: if ngrok dies on its own (auth failure, network drop,
  // anything), kill dev too.
  ngrok.on('exit', (code, signal) => {
    if (cleanedUp) return;
    const exit = typeof code === 'number' && code !== 0 ? code : 1;
    killAll(`ngrok exited unexpectedly (code=${code}, signal=${signal})`, exit);
  });

  process.on('SIGINT', () => killAll('Ctrl-C received', 130));
  process.on('SIGTERM', () => killAll('SIGTERM received', 143));

  let url;
  try {
    url = await waitForTunnelUrl();
    log(`ngrok public URL: ${url}`);
    updateEnvFile(url);
  } catch (e) {
    err(e.message);
    killAll('Could not capture ngrok URL', 1);
    return;
  }

  log("Spawning `npm run dev` — Ctrl-C stops BOTH the dev server and ngrok.");
  dev = spawn('npm', ['run', 'dev'], {
    stdio: 'inherit',
    env: process.env,
  });
  dev.on('exit', (code, signal) => {
    if (cleanedUp) return;
    const exit = typeof code === 'number' ? code : 0;
    killAll(`npm run dev exited (code=${code}, signal=${signal})`, exit);
  });
}

main().catch((e) => {
  err('fatal:', e && e.stack || e);
  process.exit(1);
});
