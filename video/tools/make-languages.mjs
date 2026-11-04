// Writes compositions/languages.html: the app's header, folder card and two activity rows in each
// of the six languages, with every string taken from src/shared/i18n.js (as the app shows them).
// Run from video/: node tools/make-languages.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { LANGUAGES, createTranslator } = require('../../src/shared/i18n.js');

// Film time 79.4 is scene time 0; each language takes over on the word that names it (timings.json + 0.5).
const SCENE_START = 79.4;
const SPOKEN = { en: 80.32, he: 80.91, es: 81.63, fr: 82.63, ru: 83.26, ar: 83.86 };
const ORDER = ['en', 'he', 'es', 'fr', 'ru', 'ar'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ICON = {
  trash: '<path d="M4 7h16M9 7V4.5h6V7M18 7l-.8 12.5a1.5 1.5 0 0 1-1.5 1.5H8.3a1.5 1.5 0 0 1-1.5-1.5L6 7M10 11v6M14 11v6"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19.5h20"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4.5h4.5"/>',
};
const svg = (name, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24">${ICON[name]}</svg>`;

function pane(code) {
  const tr = createTranslator(code);
  const { t, dir } = tr;
  const rtf = new Intl.RelativeTimeFormat(code, { numeric: 'auto' });
  const num = new Intl.NumberFormat(code, { maximumFractionDigits: 1 });
  const sep = '<i class="sep">·</i>';
  const row = (icon, cls, name, who, whoColor, action, size, when) =>
    `<div class="fb-act"><span class="fb-aicon ${cls}">${svg(icon)}</span><div class="fb-amain"><div class="fb-aname">${esc(name)}</div>` +
    `<div class="fb-ameta"><span class="who" style="color: ${whoColor}">${esc(who)}</span>${sep}<span>${esc(action)}</span>${sep}<span>Wedding - edit</span>${sep}` +
    `<span dir="ltr">${esc(size)}</span>${sep}<span class="when">${esc(when)}</span></div></div></div>`;
  return `
      <div id="l-${code}" class="l-pane cb cb-window" dir="${dir}" lang="${code}">
        <div class="cb-topbar">
          <div class="cb-brand"><img src="assets/img/icon-128.png" alt="" />FolderBridge</div>
          <span class="cb-status"><span class="cb-dot"></span>${esc(t('statusConnectedTo', { name: 'MacBook Air' }))}</span>
          <span class="cb-icon-btn">${svg('trash')}</span>
          <span class="cb-icon-btn">${svg('settings')}</span>
        </div>
        <div class="fb-card">
          <div class="fb-head">
            <span class="fb-ficon">${svg('folder')}</span>
            <div class="fb-ftext"><b>FolderBridge</b><small dir="ltr">C:\\Users\\Shachar\\FolderBridge</small></div>
            <span class="cb-btn primary">${esc(t('openFolder'))}</span>
          </div>
          <div class="fb-sync ok">
            <span class="fb-sicon">${svg('check')}</span>
            <span class="fb-stext"><b>${esc(t('stUpToDate'))}</b><small>${esc(t('files', { n: 215 }))}</small></span>
          </div>
          <div class="fb-devs"><span class="fb-dev">${svg('laptop')}MacBook Air<span class="cb-dot"></span></span></div>
        </div>
        <div class="cb-search" style="margin-top: 12px">${svg('search', 'i')}<span>${esc(t('searchPlaceholder'))}</span></div>
        <div class="cb-filters"><span class="cb-chip on">${esc(t('filterAll'))}</span><span class="cb-chip">${esc(t('filterLocal'))}</span><span class="cb-chip">${esc(t('filterRemote'))}</span><span class="cb-chip">${esc(t('filterConflicts'))}</span></div>
        <div class="l-list">
          <div class="cb-day">${esc(t('today'))}</div>
          ${row('plus', 'added', 'wedding-film.mp4', 'MacBook Air', '#0891b2', t('actAdded'), `${num.format(2.4)} GB`, rtf.format(0, 'second'))}
          ${row('restore', 'restored', 'IMG_2041.jpg', t('thisComputer'), '#5550d8', t('actRestored'), `${num.format(3.1)} MB`, rtf.format(-1, 'minute'))}
        </div>
      </div>`;
}

const names = ORDER.map((code) => {
  const info = LANGUAGES.find((l) => l.code === code);
  return `      <div id="n-${code}" class="l-name display" dir="${info.dir}" lang="${code}">${esc(info.name)}</div>`;
}).join('\n');

const at = Object.fromEntries(ORDER.map((c) => [c, +(SPOKEN[c] - SCENE_START - 0.05).toFixed(2)]));

const html = `<template>
  <link rel="stylesheet" href="assets/ui.css" />
  <style>
    @font-face { font-family: "CB Sans"; src: local("Segoe UI"); font-weight: 400; }
    @font-face { font-family: "CB Sans"; src: local("Segoe UI Semibold"); font-weight: 600; }
    @font-face { font-family: "CB Sans"; src: local("Segoe UI Bold"); font-weight: 700; }
    @font-face { font-family: "CB Mono"; src: local("Consolas"); font-weight: 400; }
    #root { position: absolute; inset: 0; overflow: hidden; background: #e9e8ef; }
    .l-pane { left: 110px; top: 150px; height: auto; padding-bottom: 10px; }
    .l-list { padding: 0 16px 4px; }
    .l-list .cb-day { padding-top: 6px; }
    .l-list .fb-ameta { flex-wrap: wrap; white-space: normal; column-gap: 6px; row-gap: 0; }
    .l-list .fb-ameta > span { white-space: nowrap; unicode-bidi: isolate; }
    .l-name { position: absolute; left: 1200px; top: 470px; width: 640px; font-family: "CB Sans", sans-serif; font-size: 112px; font-weight: 700; line-height: 1.1; color: #191923; white-space: nowrap; }
    .l-name[dir="rtl"] { text-align: left; }
    #l-rule { position: absolute; left: 1200px; top: 610px; width: 120px; height: 8px; border-radius: 4px; background: #5550d8; }
  </style>

  <!-- generated by tools/make-languages.mjs from src/shared/i18n.js - edit the script, not this file -->
  <div id="root" data-composition-id="languages" data-width="1920" data-height="1080">${ORDER.map(pane).join('')}
${names}
      <div id="l-rule"></div>
  </div>

  <script>
    const tl = gsap.timeline({ paused: true });
    // Scene time = film time - ${SCENE_START}. Each language takes over on the word that names it.
    const order = ${JSON.stringify(ORDER)};
    const at = ${JSON.stringify(at)};
    gsap.set(".l-pane", { scale: 1.6, transformOrigin: "0 0" });
    gsap.set(order.slice(1).map((c) => "#l-" + c), { opacity: 0 });
    gsap.set(order.map((c) => "#n-" + c), { opacity: 0 });
    tl.fromTo("#l-en", { opacity: 0.35, y: 30 }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" }, 0);
    tl.fromTo("#l-rule", { scaleX: 0, transformOrigin: "0 50%" }, { scaleX: 1, duration: 0.5, ease: "expo.out" }, 0.35);
    order.forEach((code, i) => {
      const t = at[code];
      if (i > 0) {
        const prev = order[i - 1];
        tl.to("#l-" + prev, { opacity: 0, filter: "blur(6px)", duration: 0.1 }, t - 0.04);
        tl.fromTo("#l-" + code, { opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.12 }, t + 0.02);
        tl.to("#n-" + prev, { opacity: 0, y: -60, duration: 0.1, ease: "power2.in" }, t - 0.04);
      }
      tl.fromTo("#n-" + code, { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.16, ease: "power3.out" }, t + 0.02);
    });
    window.__timelines["languages"] = tl;
  </script>
</template>
`;

fs.writeFileSync(path.join(here, '..', 'compositions', 'languages.html'), html);
console.log('wrote compositions/languages.html', at);
