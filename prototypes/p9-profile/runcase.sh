#!/bin/sh
# Resets the scratch profile from snap2-data, applies a tamper case while closed, relaunches,
# reads back the effective prefs through chrome://settings, quits, and keeps the result as case-<name>.
set -e
P=/tmp/helium-sync-scratch/p9-profile; D=$(cd "$(dirname "$0")" && pwd)
rm -rf $P/profile && cp -R $P/snap2-data $P/profile
node $D/tamper.mjs "$1"
: > $P/helium.log
$D/launch.sh >/dev/null; sleep 6
node $D/cdp.mjs page chrome://settings/ "(async()=>{const S=chrome.settingsPrivate; const g=async k=>(await S.getPref(k)).value; await new Promise(r=>setTimeout(r,1500));
 const txt=[]; const walk=(root)=>{for(const el of root.querySelectorAll('*')){ const tn=el.tagName.toLowerCase(); if(/reset|banner|tamper/.test(tn) && !/reset-profile-dialog|settings-reset-page/.test(tn)) txt.push(tn+': '+(el.shadowRoot?el.shadowRoot.textContent:el.textContent).replace(/\s+/g,' ').trim().slice(0,200)); if(el.shadowRoot) walk(el.shadowRoot);} }; walk(document);
 return {homepage:await g('homepage'), prompt:await g('download.prompt_for_download'), font:await g('webkit.webprefs.default_font_size'), dsp:(await g('default_search_provider_data.template_url_data'))?.short_name, startup:await g('session.startup_urls'), banners:txt}})()"
sleep 1; node $D/cdp.mjs quit >/dev/null; $D/wait-closed.sh
grep -iE "reset|tamper|tracked|pref_hash|corrupt" $P/helium.log | cut -c1-200 | head -10 || true
rm -rf $P/case-$1 && cp -R $P/profile $P/case-$1
python3 -I -c "
import json;s=json.load(open('$P/profile/Default/Secure Preferences'));p=json.load(open('$P/profile/Default/Preferences'))
print('file homepage:', s.get('homepage'), '| reset_time:', s.get('prefs',{}).get('preference_reset_time'), '| P.prefs:', p.get('prefs'), '| tracked_prefs_reset:', p.get('prefs',{}).get('tracked_preferences_reset'))
print('file dsp:', s.get('default_search_provider_data',{}).get('template_url_data',{}).get('short_name'))"
