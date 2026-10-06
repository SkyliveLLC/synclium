import { probe, log } from './idb.js';
chrome.runtime.onStartup.addListener(() => probe('sw-startup'));
chrome.runtime.onInstalled.addListener((d) => log('sw', `installed reason=${d.reason}`));
chrome.alarms.create('p', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => probe('sw-alarm'));
chrome.runtime.onMessage.addListener((m) => { if (m === 'probe') probe('sw-msg'); });
