const { createAnalyticsJobOwner } = require("../../src/platform/analytics-job-owner");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("result-map deletion and prior cancellation do not release a worker before shutdown", async () => {
  const owner = createAnalyticsJobOwner();
  const exit = deferred();
  const job = owner.launch(() => ({ promise: Promise.resolve("result"), closed: exit.promise, cancel: jest.fn(() => exit.promise) }));
  await job.promise;
  owner.cancel(job);
  const stop = owner.stop();
  let stopped = false;
  stop.then(() => { stopped = true; });
  await tick();
  expect(stopped).toBe(false);
  expect(owner.hasPending()).toBe(true);
  expect(job.cancel).toHaveBeenCalledTimes(1);
  expect(owner.stop()).toBe(stop);
  exit.resolve();
  await stop;
  expect(owner.hasPending()).toBe(false);
});

test("one job's cleanup failure does not abandon other workers or disappear before stop", async () => {
  const owner = createAnalyticsJobOwner();
  const badExit = deferred();
  const goodExit = deferred();
  const failure = new Error("failed cleanup");
  owner.launch(() => ({ closed: badExit.promise, cancel: () => badExit.promise }));
  const other = owner.launch(() => ({ closed: goodExit.promise, cancel: jest.fn(() => goodExit.promise) }));
  badExit.reject(failure);
  await tick();
  expect(() => owner.launch(() => { throw new Error("must not launch"); })).toThrow("cleanup failed");
  const stop = owner.stop();
  let settled = false;
  stop.catch(() => { settled = true; });
  await tick();
  expect(settled).toBe(false);
  expect(other.cancel).toHaveBeenCalledTimes(1);
  goodExit.resolve();
  await expect(stop).rejects.toMatchObject({ errors: [failure] });
});

test("a synchronous injected cancellation failure is retained and other cleanup runs", async () => {
  const owner = createAnalyticsJobOwner();
  const failure = new Error("cancel threw");
  const job = { cancel: jest.fn(() => { throw failure; }) };
  owner.cancel(job);
  owner.cancel(job);
  await expect(owner.stop()).rejects.toMatchObject({ errors: [failure] });
  expect(job.cancel).toHaveBeenCalledTimes(1);
});
