const REDACTED = "[REDACTED]";

function redactSecrets(text, secrets) {
  if (typeof text !== "string") {
    return text;
  }
  const safeSecrets = Array.isArray(secrets) ? secrets : [];
  return safeSecrets.reduce((redacted, secret) => {
    if (!secret) return redacted;
    return redacted.split(secret).join(REDACTED);
  }, text);
}

function redactError(error, secrets) {
  let type;
  let message;
  try {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      const typeDescriptor = Object.getOwnPropertyDescriptor(error, "type");
      const messageDescriptor = Object.getOwnPropertyDescriptor(error, "message");
      const rawType = typeDescriptor && Object.hasOwn(typeDescriptor, "value") ? typeDescriptor.value : undefined;
      const rawMessage = messageDescriptor && Object.hasOwn(messageDescriptor, "value")
        ? messageDescriptor.value
        : undefined;
      type = typeof rawType === "string" ? rawType : undefined;
      message = rawMessage === undefined ? undefined : String(rawMessage);
    }
  } catch {
    type = undefined;
    message = "unreadable upstream error";
  }
  return {
    type,
    message: redactSecrets(message, secrets),
  };
}

module.exports = { REDACTED, redactSecrets, redactError };
