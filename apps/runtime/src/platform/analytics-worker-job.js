function createAnalyticsWorkerJob({ WorkerImpl, workerPath, input, maxOldGenerationSizeMb, timeoutMs, label }) {
  let worker;
  let timer = null;
  let resultSettled = false;
  let cleanupSettled = false;
  let terminating = false;
  let resolveResult;
  let rejectResult;
  let resolveClosed;
  let rejectClosed;
  const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  closed.catch(() => {});

  function settleResult(error, result) {
    if (resultSettled) return;
    resultSettled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (error) rejectResult(error);
    else resolveResult(result);
  }

  function settleClosed(error) {
    if (cleanupSettled) return;
    cleanupSettled = true;
    if (error) rejectClosed(error);
    else resolveClosed();
  }

  function onMessage(message) {
    if (message?.ok === true) settleResult(null, message.result);
    else settleResult(new Error(message?.error ?? `${label}: worker returned an invalid result`));
  }

  function onError(error) {
    settleResult(error);
  }

  function onExit(code) {
    worker.removeListener("message", onMessage);
    worker.removeListener("error", onError);
    settleResult(new Error(`${label}: worker exited before reporting (code ${code})`));
    if (!terminating) settleClosed();
  }

  function terminate() {
    if (terminating || cleanupSettled) return closed;
    terminating = true;
    try {
      Promise.resolve(worker.terminate()).then(() => settleClosed(), settleClosed);
    } catch (error) {
      settleClosed(error);
    }
    return closed;
  }

  try {
    worker = new WorkerImpl(workerPath, { workerData: input, resourceLimits: { maxOldGenerationSizeMb } });
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    timer = setTimeout(() => {
      settleResult(new Error(`${label}: worker exceeded ${timeoutMs}ms`));
      terminate();
    }, timeoutMs);
    timer.unref?.();
  } catch (error) {
    settleResult(error);
    if (worker) terminate();
    else settleClosed();
  }

  return Object.freeze({
    promise,
    closed,
    cancel() {
      settleResult(new Error(`${label}: cancelled`));
      return terminate();
    },
  });
}

module.exports = { createAnalyticsWorkerJob };
