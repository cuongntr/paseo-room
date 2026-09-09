import { createHash } from 'node:crypto';

/** Stable JSON, not a lossy JSON.stringify coercion. No getters/toJSON are invoked. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input) && !Object.is(input, -0)) return JSON.stringify(input);
    if (typeof input !== 'object') throw new Error('Canonical JSON requires unambiguous JSON values.');
    if (ancestors.has(input)) throw new Error('Canonical JSON cannot contain cycles.');
    const array = Array.isArray(input);
    if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new Error('Canonical JSON requires plain objects.');
    }
    ancestors.add(input);
    try {
      const keys = Reflect.ownKeys(input);
      if (keys.some(key => typeof key !== 'string')) throw new Error('Canonical JSON cannot contain symbol keys.');
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const read = (key: string): unknown => {
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Canonical JSON cannot contain accessors or hidden properties.');
        return descriptor.value as unknown;
      };
      if (array) {
        if (keys.length !== input.length + 1) throw new Error('Canonical JSON requires dense arrays without extra properties.');
        return `[${Array.from({ length: input.length }, (_, index) => encode(read(String(index)))).join(',')}]`;
      }
      return `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${encode(read(key))}`).join(',')}}`;
    } finally { ancestors.delete(input); }
  }
  return encode(value);
}

/** Only use on authored/validated regular-file content, never credential bytes. */
export function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}
export function canonicalJsonSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}
