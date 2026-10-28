/**
 * A one-worker queue between two stages of a scan.
 *
 * The fetch side of a scan waits on the network and the judge side waits on the
 * model's rate limit. Run one after the other, each source's judging held up the
 * next source's fetching; run as two lanes, the model's waiting hides inside the
 * network's. This is the join between them, and it is deliberately small.
 *
 *   - ONE worker, taking jobs strictly in the order they were pushed. That is what
 *     keeps the saves atomic and ordered: batch N is on disk before batch N+1 is
 *     reconciled against it, so a posting two sources both carry is still judged
 *     twice and merged once.
 *   - BOUNDED. `capacity` jobs may wait while one is being worked on. Without a
 *     bound a fast fetch lane would run far ahead of a slow judge, holding every
 *     source's postings in memory and showing nothing on the page until the end.
 *   - A worker that throws stops the lane. The next `push` (or `close`) throws the
 *     same error, so the fetch side stops fetching for results nobody will save.
 *
 * Nothing here knows what a job is.
 */
export function lane(work, { capacity = 1 } = {}) {
  const waiting = [];
  let failure = null;
  let closed = false;
  let wakeWorker = null;
  let wakePusher = null;

  const worker = (async () => {
    for (;;) {
      if (!waiting.length) {
        if (closed) return;
        await new Promise((resolve) => { wakeWorker = resolve; });
        continue;
      }
      const job = waiting.shift();
      wakePusher?.();
      wakePusher = null;
      try {
        await work(job);
      } catch (e) {
        failure = e;
        closed = true;
        waiting.length = 0;
        wakePusher?.();
        wakePusher = null;
        return;
      }
    }
  })();

  return {
    /** Resolves once there is room. Throws if the worker has failed. */
    async push(job) {
      while (waiting.length >= capacity && !failure) {
        await new Promise((resolve) => { wakePusher = resolve; });
      }
      if (failure) throw failure;
      waiting.push(job);
      wakeWorker?.();
      wakeWorker = null;
    },

    /** No more jobs: wait for those queued to finish. Throws if the worker failed. */
    async close() {
      closed = true;
      wakeWorker?.();
      wakeWorker = null;
      await worker;
      if (failure) throw failure;
    },

    /** For tests and logging: jobs waiting (not the one being worked on). */
    get depth() { return waiting.length; },
  };
}
