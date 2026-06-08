export function redactApiKey(value: string | undefined | null): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function redactHeaderValue(name: string, value: string | string[] | undefined): string {
  if (value === undefined) return '';
  const lowered = name.toLowerCase();
  const sensitive = lowered === 'authorization' || lowered === 'x-api-key' || lowered === 'api-key';
  if (!sensitive) return Array.isArray(value) ? value.join(', ') : value;
  const raw = Array.isArray(value) ? value[0] ?? '' : value;
  if (!raw) return '';
  const parts = raw.split(/\s+/);
  if (parts.length === 1) return `Bearer ${redactApiKey(parts[0])}`;
  return `${parts[0]} ${redactApiKey(parts.slice(1).join(' '))}`;
}

export function safeStringify(obj: unknown, maxLen = 4000): string {
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      obj,
      (key, value) => {
        if (typeof key === 'string' && /authorization|api[-_]?key|secret|password|token/i.test(key)) {
          return redactApiKey(typeof value === 'string' ? value : '');
        }
        if (typeof value === 'string' && value.length > maxLen) {
          return `${value.slice(0, maxLen)}...`;
        }
        if (value && typeof value === 'object') {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      },
    );
    return json ?? '';
  } catch {
    return '[unserializable]';
  }
}
