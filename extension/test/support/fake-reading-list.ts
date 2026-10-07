// chrome.readingList in memory, with the errors Helium returns (P8). Urls are stored as given: the channel only
// ever passes back urls it read from here, so Chromium's normalization does not matter to these tests.
import type { ReadingListApi } from '../../src/chrome-reading-list.ts';

type Stored = { title: string; hasBeenRead: boolean; creationTime: number; lastUpdateTime: number };

export class FakeReadingList implements ReadingListApi {
  readonly entries = new Map<string, Stored>();

  add(url: string, title: string, read = false): void {
    this.entries.set(url, { title, hasBeenRead: read, creationTime: 0, lastUpdateTime: 0 });
  }

  /** Sorted, so two lists with the same entries render the same. */
  render(): string {
    return [...this.entries].map(([url, e]) => `${url} | ${e.title}${e.hasBeenRead ? ' (read)' : ''}`).sort().join('\n');
  }

  async query(): Promise<chrome.readingList.ReadingListEntry[]> {
    return [...this.entries].map(([url, e]) => ({ url, ...e }));
  }
  async addEntry(entry: chrome.readingList.AddEntryOptions): Promise<void> {
    if (this.entries.has(entry.url)) throw new Error('Duplicate URL.');
    this.add(entry.url, entry.title, entry.hasBeenRead);
  }
  async updateEntry(info: chrome.readingList.UpdateEntryOptions): Promise<void> {
    const held = this.entries.get(info.url);
    if (held === undefined) throw new Error('URL not found.');
    if (info.title !== undefined) held.title = info.title;
    if (info.hasBeenRead !== undefined) held.hasBeenRead = info.hasBeenRead;
  }
  async removeEntry(info: chrome.readingList.RemoveOptions): Promise<void> {
    if (!this.entries.delete(info.url)) throw new Error('URL not found.');
  }
}
