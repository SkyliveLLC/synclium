// Records reading-list events so the CDP probe can read them back.
self.events = [];
for (const n of ['onEntryAdded', 'onEntryUpdated', 'onEntryRemoved'])
  chrome.readingList?.[n]?.addListener((e) => self.events.push({ n, e }));
