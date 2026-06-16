const sensitivePatterns: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern:
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION)[A-Z0-9_]*)\s*[:=]\s*([^\s"'`]+|"[^"]*"|'[^']*'|`[^`]*`)/giu,
    replacement: "$1=[redacted]",
  },
  { pattern: /(bearer\s+)[a-z0-9._-]+/giu, replacement: "$1[redacted]" },
  {
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/gu,
    replacement: "[redacted-github-token]",
  },
  {
    pattern: /\b(sk-[A-Za-z0-9_-]{20,})\b/gu,
    replacement: "[redacted-api-key]",
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
    replacement: "[redacted-private-key]",
  },
];

export const externalUntrustedPrefix = "[external/untrusted]";

export const redactSensitiveText = (content: string): string =>
  sensitivePatterns.reduce(
    (current, { pattern, replacement }) => current.replace(pattern, replacement),
    content,
  );

export const formatExternalUntrustedValue = (
  value: string | number | undefined,
): string => {
  if (value === undefined || value === "") {
    return "None";
  }

  return `${externalUntrustedPrefix} ${redactSensitiveText(String(value))}`;
};

export const sanitizeExternalSummary = (value: string | undefined): string | undefined => {
  const redacted = value ? redactSensitiveText(value).trim() : "";

  return redacted.length > 0 ? redacted : undefined;
};

export const sanitizeContextText = (value: string): string =>
  redactSensitiveText(value);
