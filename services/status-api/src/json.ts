// JSON with bigint: a bigint is written as {"$big":"123"} in snapshots and as a plain decimal
// string in API responses.

export function snapshotReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? { $big: v.toString() } : v;
}

export function snapshotReviver(_k: string, v: unknown): unknown {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$big') return BigInt((v as { $big: string }).$big);
  }
  return v;
}

export function apiReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

/** Recursively turns bigint into decimal strings (for building responses and comparing in tests). */
export function plain<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, apiReplacer));
}
