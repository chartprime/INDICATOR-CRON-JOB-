function createAnalyticsJobOwner() {
  const jobs = new Set();
  const cancellations = new WeakMap();
  const pendingCancellations = new Set();
  let firstCleanupError = null;
  let stopPromise = null;

  function recordFailure(error) {
    firstCleanupError ??= error;
  }

  function track(job) {
    if (job?.closed && typeof job.closed.then === "function") {
      jobs.add(job);
      job.closed.then(() => jobs.delete(job), (error) => {
        jobs.delete(job);
        recordFailure(error);
      });
    }
    return job;
  }

  function launch(factory) {
    if (stopPromise || firstCleanupError) throw new Error("analytics job owner: cleanup failed or shutdown has started");
    return track(factory());
  }

  function cancel(job) {
    if (!job) return Promise.resolve();
    if (cancellations.has(job)) return cancellations.get(job);
    let resolveCancellation;
    const completion = new Promise((resolve) => { resolveCancellation = resolve; });
    cancellations.set(job, completion);
    pendingCancellations.add(completion);
    const finish = (error) => {
      if (error) recordFailure(error);
      pendingCancellations.delete(completion);
      resolveCancellation();
    };
    try {
      const result = job.cancel();
      if (result && typeof result.then === "function") Promise.resolve(result).then(() => finish(), finish);
      else finish();
    } catch (error) {
      finish(error);
    }
    return completion;
  }

  function stop(errors = []) {
    if (stopPromise) return stopPromise;
    let resolveStop;
    let rejectStop;
    stopPromise = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    stopPromise.catch(() => {});
    const ownedJobs = [...jobs];
    for (const job of ownedJobs) cancel(job);
    Promise.all([
      ...ownedJobs.map((job) => job.closed.catch(recordFailure)),
      ...pendingCancellations,
    ]).then(() => {
      const failures = [...errors];
      if (firstCleanupError) failures.push(firstCleanupError);
      if (failures.length > 0) rejectStop(new AggregateError(failures, "analytics job owner: shutdown failed"));
      else resolveStop();
    }, rejectStop);
    return stopPromise;
  }

  return Object.freeze({
    launch, cancel, stop,
    hasPending: () => jobs.size > 0 || pendingCancellations.size > 0,
    canRestart: () => jobs.size === 0 && pendingCancellations.size === 0 && firstCleanupError === null,
  });
}

module.exports = { createAnalyticsJobOwner };
