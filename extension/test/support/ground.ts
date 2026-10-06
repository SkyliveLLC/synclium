// A synthetic profile shaped like P3's ground tree: a bookmarks bar with urls and two folders, a few urls in
// Other. Deterministic, so every device that starts from it shows the same content.
import { FakeBrowser } from './fake-bookmarks.ts';

export const F_TITLE = 'Vue';
export const IA_TITLE = 'IA';
export const BAR = '1';
export const OTHER = '2';

export const urlTitle = (i: number): string => `Site ${i}`;
export const urlOf = (i: number): string => `https://example.org/site/${i}`;

export function ground(urls = 30): FakeBrowser {
  const b = new FakeBrowser();
  for (let i = 0; i < urls; i++) b.add(BAR, i, { title: urlTitle(i), url: urlOf(i) });
  const f = b.add(BAR, urls, { title: F_TITLE });
  b.add(f, 0, { title: 'Vue docs', url: 'https://vuejs.org/guide/' });
  b.add(f, 1, { title: 'Pinia', url: 'https://pinia.vuejs.org/' });
  const ia = b.add(BAR, urls + 1, { title: IA_TITLE });
  b.add(ia, 0, { title: 'IA one', url: 'https://ia.example/1' });
  b.add(ia, 1, { title: 'IA two', url: 'https://ia.example/2' });
  const nested = b.add(ia, 2, { title: 'IA nested' });
  b.add(nested, 0, { title: 'IA deep', url: 'https://ia.example/deep' });
  for (let i = 0; i < 5; i++) b.add(OTHER, i, { title: `Other ${i}`, url: `https://other.example/${i}` });
  return b;
}

export function idOf(b: FakeBrowser, title: string): string {
  const node = b.find(title)[0];
  if (node === undefined) throw new Error(`no node titled ${title}`);
  return node.id;
}
