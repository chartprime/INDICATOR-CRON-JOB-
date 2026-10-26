const { redactError, redactSecrets } = require("./redact");
const {
  waitForAuthorized: waitForAuthorizedHandshake,
  waitForChannelOpened: waitForChannelOpenedHandshake,
} = require("./dxlink-handshake");

function redactEvidence(value, secrets) {
  try {
    return JSON.parse(redactSecrets(JSON.stringify(value), secrets));
  } catch {
    return { message: "evidence could not be serialized safely" };
  }
}

function eventMatchesSubscription(item, entry) {
  if (item?.eventType !== entry.type || item?.eventSymbol !== entry.symbol) return false;
  return entry.source === undefined || item.source === entry.source;
}

function classifyAttemptOutcome({ receivedEvents, receivedError }) {
  if (receivedError) {
    return { outcome: "EXPLICIT_ERROR", evidence: receivedError };
  }
  if (receivedEvents.length > 0) {
    return { outcome: "DATA_OBSERVED", evidence: receivedEvents[0] };
  }
  return { outcome: "NO_DATA_OBSERVED", evidence: null };
}

function summarizeObservedEvents(events) {
  let earliestEventTime = null;
  let latestEventTime = null;
  for (const event of events) {
    const timestamp = event?.time ?? event?.eventTime;
    if (!Number.isFinite(timestamp)) continue;
    if (earliestEventTime === null || timestamp < earliestEventTime) earliestEventTime = timestamp;
    if (latestEventTime === null || timestamp > latestEventTime) latestEventTime = timestamp;
  }
  return {
    eventCount: events.length,
    earliestEventTime,
    latestEventTime,
  };
}

async function runAttempt({
  channel,
  entry,
  windowMs,
  wait,
  now,
  signal,
  secrets = [],
  settleOnFirstEvent = true,
  collectAllEvents = false,
  maxCollectedEvents = 256,
}) {
  if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
  if (!Number.isSafeInteger(maxCollectedEvents) || maxCollectedEvents <= 0) {
    throw new Error("dxfeed-probe-kit: maxCollectedEvents must be a positive safe integer");
  }
  const startedAt = now();
  let eventCount = 0;
  let earliestEventTime = null;
  let latestEventTime = null;
  let firstEvidence = null;
  const receivedEvents = collectAllEvents ? [] : null;
  let eventsTruncated = false;
  let receivedError = null;
  let settleEarly;
  const earlySignal = new Promise((resolve) => {
    settleEarly = resolve;
  });

  function onMessage(message) {
    if (message?.type !== "FEED_DATA" || !Array.isArray(message.data)) return;
    for (const item of message.data) {
      if (eventMatchesSubscription(item, entry)) {
        eventCount += 1;
        const timestamp = item?.time ?? item?.eventTime;
        if (Number.isFinite(timestamp)) {
          if (earliestEventTime === null || timestamp < earliestEventTime) earliestEventTime = timestamp;
          if (latestEventTime === null || timestamp > latestEventTime) latestEventTime = timestamp;
        }
        if (firstEvidence === null || (collectAllEvents && receivedEvents.length < maxCollectedEvents)) {
          const evidence = redactEvidence(item, secrets);
          firstEvidence ??= evidence;
          if (collectAllEvents) receivedEvents.push(evidence);
        } else if (collectAllEvents) {
          eventsTruncated = true;
        }
      }
    }
    if (settleOnFirstEvent && firstEvidence !== null) settleEarly();
  }
  function onError(error) {
    receivedError = redactError(error, secrets);
    settleEarly();
  }

  let messageListenerAttached = false;
  let errorListenerAttached = false;
  function removeListeners() {
    if (messageListenerAttached) {
      try {
        channel.removeMessageListener(onMessage);
      } catch {
        void 0;
      }
      messageListenerAttached = false;
    }
    if (errorListenerAttached) {
      try {
        channel.removeErrorListener(onError);
      } catch {
        void 0;
      }
      errorListenerAttached = false;
    }
  }

  try {
    channel.addMessageListener(onMessage);
    messageListenerAttached = true;
    channel.addErrorListener(onError);
    errorListenerAttached = true;
    channel.send({ type: "FEED_SUBSCRIPTION", add: [entry] });
  } catch (error) {
    removeListeners();
    return {
      entry,
      outcome: "EXPLICIT_ERROR",
      evidence: { message: redactSecrets(String(error?.message ?? error), secrets) },
      eventCount: 0,
      earliestEventTime: null,
      latestEventTime: null,
      elapsedMs: now() - startedAt,
    };
  }

  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(signal?.reason ?? new Error("operation aborted"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([earlySignal, wait(windowMs), abortPromise]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      channel.send({ type: "FEED_SUBSCRIPTION", remove: [entry] });
    } catch {
      void 0;
    }
    removeListeners();
  }

  const elapsedMs = now() - startedAt;
  const { outcome, evidence } = classifyAttemptOutcome({
    receivedEvents: firstEvidence === null ? [] : [firstEvidence],
    receivedError,
  });
  return {
    entry,
    outcome,
    evidence,
    eventCount,
    earliestEventTime,
    latestEventTime,
    elapsedMs,
    ...(collectAllEvents ? { events: Object.freeze([...receivedEvents]), eventsTruncated } : {}),
  };
}

function createAbortCompletion(signal) {
  if (!signal) return { promise: undefined, cleanup: () => {} };
  let onAbort;
  const promise = new Promise((resolve) => {
    onAbort = resolve;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => signal.removeEventListener("abort", onAbort),
  };
}

async function waitForAuthorized({ connection, timeoutMs, signal }) {
  if (signal?.aborted) throw signal.reason ?? new Error("authorization wait aborted");
  const abort = createAbortCompletion(signal);
  try {
    const authorized = await waitForAuthorizedHandshake({ connection, timeoutMs, abortPromise: abort.promise });
    if (!authorized) throw signal?.reason ?? new Error("authorization wait aborted");
  } finally {
    abort.cleanup();
  }
}

async function waitForChannelOpened({ channel, timeoutMs, signal }) {
  if (signal?.aborted) throw signal.reason ?? new Error("channel-open wait aborted");
  const abort = createAbortCompletion(signal);
  try {
    const opened = await waitForChannelOpenedHandshake({ channel, timeoutMs, abortPromise: abort.promise });
    if (!opened) throw signal?.reason ?? new Error("channel-open wait aborted");
  } finally {
    abort.cleanup();
  }
}

module.exports = {
  redactEvidence,
  eventMatchesSubscription,
  classifyAttemptOutcome,
  summarizeObservedEvents,
  runAttempt,
  waitForAuthorized,
  waitForChannelOpened,
};
