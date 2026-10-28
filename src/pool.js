/**
 * Start several things at once, and deal with each result the moment it lands.
 *
 * The scan fetches its sources through this. Two properties matter, and both are tested:
 *
 *   - STARTING overlaps. Up to `limit` `start()` calls are in flight together, so a source that
 *     takes six minutes does not make a source that takes a second wait behind it.
 *   - LANDING does not. `land()` runs for ONE result at a time, in the order the results arrive
 *     (completion order, not the order they were started in). Everything shared — the snapshot
 *     file, the schedule, the judge lane — is written from `land()`, so nothing is written from
 *     two places and a slow `land()` simply holds the next one back while the other fetches
 *     carry on in the background.
 *
 * An item is `skip`ped when it reaches the front of the queue and `shouldSkip()` says so: how a
 * scan stops starting sources once it has found the connection is down.
 */
export async function runPool(items, { limit = 1, start, land, shouldSkip = () => false, onSkip = () => {} }) {
  const queue = [...items];
  const flying = new Map();   // item -> promise of { item, value }

  const launch = (item) => {
    flying.set(item, Promise.resolve(start(item)).then((value) => ({ item, value })));
  };

  while (queue.length || flying.size) {
    while (queue.length && flying.size < Math.max(1, limit)) {
      const next = queue.shift();
      if (shouldSkip(next)) { onSkip(next); continue; }
      launch(next);
    }
    if (!flying.size) break;
    const done = await Promise.race(flying.values());
    flying.delete(done.item);
    await land(done.item, done.value);
  }
}
