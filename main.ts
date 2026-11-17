import { createApp } from "./app.ts";

const base = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (base === "") {
  process.stderr.write("[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n");
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_START_MS = 250;
const RETRY_CAP_MS = 2_000;

const wait = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

function retryWait(attempt: number): number {
  const doublings = Math.min(attempt, 8);
  return Math.min(RETRY_CAP_MS, RETRY_START_MS * 2 ** doublings);
}

async function announce(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const answer = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        const body = await answer.text();
        throw new Error(`register answered HTTP ${answer.status}: ${body}`);
      }
    } catch (failure) {
      const text = failure instanceof Error ? failure.message : "";
      if (text.startsWith("register answered HTTP ")) throw failure;
    }
    await wait(retryWait(attempt));
    attempt += 1;
  }
}

async function finished(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const answer = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env may still be starting, or the poll timed out: it is not done yet.
    }
    await wait(retryWait(attempt));
    attempt += 1;
  }
}

async function boot(): Promise<void> {
  const app = createApp();
  await new Promise<void>((ok, fail) => {
    app.once("error", fail);
    app.listen(0, () => ok());
  });
  const where = app.address();
  if (where === null || typeof where === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[entry] listening on port ${where.port}\n`);

  await announce(where.port);
  process.stdout.write("[entry] registered; waiting for the env to say done\n");

  await finished();
  app.close();
  process.stdout.write("[entry] done\n");
}

try {
  await boot();
  process.exit(0);
} catch (failure) {
  const text = failure instanceof Error ? failure.message : String(failure);
  process.stderr.write(`[entry] ${text}\n`);
  process.exit(1);
}
