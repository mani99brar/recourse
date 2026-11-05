import { readFileSync } from 'node:fs';

export function vector<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../vectors/${name}`, import.meta.url), 'utf8')) as T;
}
