// The story and the two sign-up pages: their routes, each loaded on its own (lazily) with its h1,
// and the home page's three links to them, every existing route unchanged.
import { readFileSync } from 'node:fs';
import { renderToString } from 'react-dom/server';
import { prerender } from 'react-dom/static';
import { describe, expect, it } from 'vitest';
import { Shell, route } from '../src/App.js';

/** The whole page once every lazy part has loaded (renderToString would stop at the Suspense fallback). */
async function full(hash: string): Promise<string> {
  const { prelude } = await prerender(<Shell hash={hash} />);
  return (await new Response(prelude).text()).replaceAll('<!-- -->', '');
}

describe('story, join and bond routes', () => {
  it('route them, and leave unknown and existing routes as they were', () => {
    expect(route('#/story')).toEqual({ name: 'story', arg: '' });
    expect(route('#/join')).toEqual({ name: 'join', arg: '' });
    expect(route('#/bond')).toEqual({ name: 'bond', arg: '' });
    expect(route('#/storyx').name).toBe('home');
    expect(route('#/nothing').name).toBe('home');
    expect(route('#/cast')).toEqual({ name: 'cast', arg: '' });
  });

  it.each([
    ['#/story', 'How it works'],
    ['#/join', 'I run a shop'],
    ['#/bond', 'I run a shopping agent'],
  ])('%s renders its h1 once loaded, with no wallet control', async (hash, h1) => {
    const html = await full(hash);
    expect(html).toContain(`data-route="${hash.slice(2)}"`);
    expect(html).toContain(`<h1>${h1}</h1>`);
    expect(html).not.toContain('Connect wallet');
  });

  it('are loaded only when opened: the shell imports none of them statically', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    for (const page of ['Story', 'Join', 'Bond']) {
      expect(app).not.toMatch(new RegExp(`^import .*pages/${page}\\.js`, 'm'));
      expect(app).toContain(`import('./pages/${page}.js')`);
    }
    expect(app).toContain('<Suspense fallback={<Loading what="the page" />}>');
  });

  it('the home page links to all three, and the nav to the story', () => {
    const home = renderToString(<Shell hash="#/" />);
    expect(home).toContain('href="#/story"');
    expect(home).toContain('href="#/join"');
    expect(home).toContain('href="#/bond"');
    expect(home).toContain('I run a shopping agent');
    expect(renderToString(<Shell hash="#/story" />)).toContain('href="#/story" aria-current="page"');
  });
});
