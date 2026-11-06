// A small JSON Schema check over openapi.json, enough for this contract's keywords ($ref, allOf,
// anyOf, type, enum, pattern, required, properties, additionalProperties: false, items, min/max
// items and lengths): answers are checked against the schema the contract gives their path.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type S = Record<string, unknown>;

export const OPENAPI = JSON.parse(readFileSync(join(__dirname, '../../openapi.json'), 'utf8')) as S & {
  paths: Record<string, Record<string, S>>;
  components: { schemas: Record<string, S> };
};

function resolve(ref: string): S {
  let cur: unknown = OPENAPI;
  for (const part of ref.replace(/^#\//, '').split('/')) cur = (cur as S)[part];
  return cur as S;
}

function typeOk(t: string, v: unknown): boolean {
  if (t === 'null') return v === null;
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (t === 'number') return typeof v === 'number';
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return typeof v === 'object' && v !== null && !Array.isArray(v);
  return typeof v === t;
}

/** Problems with `v` under `schema`; empty when it conforms. */
export function check(schema: S, v: unknown, path = '$'): string[] {
  if (typeof schema.$ref === 'string') return check(resolve(schema.$ref), v, path);
  const out: string[] = [];
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf as S[]) out.push(...check(s, v, path));
  if (Array.isArray(schema.anyOf)) {
    const tries = (schema.anyOf as S[]).map((s) => check(s, v, path));
    if (!tries.some((t) => t.length === 0)) out.push(`${path}: matches none of anyOf (${tries.map((t) => t[0]).join(' | ')})`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => typeOk(t, v))) return [...out, `${path}: expected ${types.join('|')}, got ${JSON.stringify(v)?.slice(0, 60)}`];
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(v)) out.push(`${path}: ${JSON.stringify(v)} not in enum`);
  if (typeof v === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(v)) out.push(`${path}: ${v.slice(0, 60)} does not match ${schema.pattern}`);
    if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.minLength === 'number' && v.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
  }
  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && v > schema.maximum) out.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) out.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => out.push(...check(schema.items as S, x, `${path}[${i}]`)));
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in o)) out.push(`${path}: missing ${k}`);
    const props = (schema.properties as Record<string, S> | undefined) ?? {};
    for (const [k, s] of Object.entries(props)) if (k in o) out.push(...check(s, o[k], `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in props)) out.push(`${path}: unexpected ${k}`);
  }
  return out;
}

/** The schema of a path's answer for a status ('200', or an error status through its response ref). */
export function responseSchema(path: string, method: string, status = '200'): S {
  const op = OPENAPI.paths[path]?.[method] as S | undefined;
  if (!op) throw new Error(`no ${method} ${path} in the contract`);
  let r = (op.responses as Record<string, S>)[status];
  if (!r) throw new Error(`no ${status} for ${method} ${path}`);
  if (typeof r.$ref === 'string') r = resolve(r.$ref);
  return ((r.content as Record<string, S>)['application/json'] as S).schema as S;
}
