// Process lifecycle for the forge entry.
//
// A grading harness drives this program through one env URL, and main.ts
// is the small piece of code that keeps the two in step:
//
//   1. The forge server comes up on a port the kernel picks (port 0).
//      Port 8080 belongs to the env and is never ours to take.
//   2. We announce the chosen port with POST /register so the env can
//      dial the server back.
//   3. We poll GET /done until the env reports the trial is finished.
//   4. We close the server and exit 0, which lets the harness stop the
//      env and write the export that gets scored.
//
// MAKEFUN_ENV_URL names the env. Without it there is nobody to register
// with and nothing to wait for, so the program refuses to start at all.

import { createApp } from './app.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envBase === '') {
  console.error('main: MAKEFUN_ENV_URL is not set; there is no env to register with');
  process.exit(1);
}

/** Longest a single register or poll request may run before we abandon the attempt. */
const ATTEMPT_TIMEOUT_MS = 30_000;
/** Retry cadence: the first pause, and the ceiling every later pause grows toward. */
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait before retry number `n` (counting from 0): 250ms, doubling, flat at the ceiling. */
function pauseBeforeRetry(n: number): number {
  const grown = FIRST_PAUSE_MS * 2 ** n;
  return grown > LONGEST_PAUSE_MS ? LONGEST_PAUSE_MS : grown;
}

/**
 * Tell the env which port we bound, retrying while it is still starting up.
 * The env keeps the first registration it receives, so a 409 (some other
 * process registered first) is a finished errand, not a failure. A 400 or
 * 405 means our request broke the contract; retrying cannot fix that, so
 * those abort the program. Everything else — a refused connection, a 5xx,
 * a timeout — just earns another attempt after a pause.
 */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let refusal: Error | null = null;
    try {
      const reply = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        refusal = new Error(`register refused with HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch {
      // The request itself failed (env not up yet, socket reset, timeout):
      // that is a "not yet", handled by the retry below.
    }
    if (refusal !== null) throw refusal;
    await pause(pauseBeforeRetry(failures));
    failures += 1;
  }
}

/**
 * Ask the env whether the trial is over, and keep asking until it says so.
 * The env answers promptly either way, so this is a poll loop; any failed,
 * non-OK or garbled answer counts as "not done" and is asked again. This
 * function returns only on a body of {"done": true} — the process must
 * never exit earlier.
 */
async function blockUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envBase}/done`, {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (reply.ok) {
        const payload: unknown = await reply.json();
        if (
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true
        ) {
          return;
        }
      }
    } catch {
      // Unreachable or unparseable: still not done, so poll again.
    }
    await pause(pauseBeforeRetry(failures));
    failures += 1;
  }
}

/** Start the forge on an ephemeral port and resolve with the port it actually bound. */
function boundPort(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge bound without an ephemeral TCP port'));
      } else {
        resolve(address.port);
      }
    });
  });
}

/** The whole life of the process: serve, register, wait to be dismissed. */
async function run(): Promise<void> {
  const server = createApp();
  const port = await boundPort(server);
  console.log(`main: forge listening on port ${port}`);

  await announcePort(port);
  console.log('main: registered; waiting for the env to finish');

  await blockUntilDone();
  server.close();
  console.log('main: env says done; shutting down');
}

run().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    console.error(`main: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
