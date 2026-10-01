/**
 * Work a request starts but does not wait for — sending an email whose
 * success the response must not reveal.
 *
 * Why it exists: a public endpoint that awaited delivery would answer more
 * slowly when there was someone to mail, which is an account-existence oracle
 * no amount of response-body sameness closes (the login service's dummy hash
 * exists for the same reason). Running the delivery after the reply removes
 * the timing difference.
 *
 * Not silent: a failed task is logged at error level with its label. Not lost
 * on shutdown: `settled()` waits for everything still running, and the app
 * awaits it when it closes — which is also how a test observes what was sent.
 *
 * In-process and best-effort by design. This is not a queue and gives no
 * retry: a process that dies mid-send loses that one email, and the person
 * asks again. Durable delivery is the shift-report outbox's job (F-16), not
 * this.
 */
export interface BackgroundWork {
  run(label: string, task: () => Promise<void>): void;
  settled(): Promise<void>;
}

export interface BackgroundLog {
  error(details: object, message: string): void;
}

export function backgroundWork(log: BackgroundLog): BackgroundWork {
  const pending = new Set<Promise<void>>();
  return {
    run(label, task) {
      const running: Promise<void> = task()
        .catch((error: unknown) => {
          log.error({ err: error, task: label }, "background task failed");
        })
        .finally(() => {
          pending.delete(running);
        });
      pending.add(running);
    },
    async settled() {
      await Promise.all([...pending]);
    },
  };
}
