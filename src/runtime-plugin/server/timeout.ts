/**
 * Deadlines for calls into Paseo whose caller must answer in time: a before hook Paseo fails at
 * 30 s, or a panel view that must not wait on a seat that does not answer. The timer never holds the
 * plugin process open.
 */

/** Settles as `work` does, or rejects with `message` once `ms` have passed. */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(message)); }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The value, or null when it failed or did not arrive in time. */
export async function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return await withTimeout(work, ms, 'timed out').catch(() => null);
}
