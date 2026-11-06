/*
 * Fabricator preview Touch Up agent (v1).
 *
 * Injected at document start into EVERY frame of the preview webview (see
 * `preview.rs` `PICK_AGENT_JS`) and dormant until the host arms it. Armed, it
 * listens for Ctrl+Shift+C (Cmd+Shift+C on macOS), so the shortcut works while
 * the preview has the keyboard. On, it turns the live app into context for chat:
 *   - hovering highlights the element under the pointer, with its name and size;
 *   - clicking picks it: it stays outlined with its number, and the host adds it
 *     to the chat composer; clicking a picked element again drops it;
 *   - Shift+drag clips any region of the app instead, and the host attaches a
 *     screenshot of it;
 *   - Escape, Done or the shortcut again finishes; holding Alt uses the app.
 * It never changes the app: Copilot does, in the chat turn that follows.
 *
 * Host comms are pull-based and JSON-only, like the rest of the preview:
 * `set(mode, appOrigin, options)` arms the page, switches picking on or off and
 * restores the host's picks; `peek()` returns the state plus the events since
 * the page loaded (the host remembers the last `seq` it handled, per `page`);
 * `command(cmd)` prepares and ends a capture, outlines a pick, or syncs the
 * host's numbering. The wire types live in `src/shared/pick.ts`.
 *
 * Frames: the host can only `eval` in the TOP frame. In the direct view the top
 * frame IS the app (`direct`). In the Fabric-embedded view the app runs in a
 * cross-origin iframe, and the top (Fabric shell) frame runs as a `relay` that
 * forwards `set` and `command` to the app frame over origin-gated `postMessage`
 * and mirrors its state back.
 *
 * The native webview paints above all HTML, so the highlight lives inside this
 * page, in a Shadow DOM attached to <html> (isolated from the app's CSS).
 */
(function () {
  'use strict';
  var NS = '__fabricatorPick';
  var VERSION = 1;
  if (window[NS] && window[NS].__v === VERSION) return;

  var HOST_ID = '__fabricator_pick';
  var CURSOR_ID = '__fabricator_pick_cursor';
  var MSG = 'fabricator-pick';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var MAX_PICKS = 8;
  var MAX_EVENTS = 40;
  var MAX_HTML = 1500;
  /** The smallest clip worth a screenshot, in CSS px. */
  var MIN_CLIP = 8;
  var MAC = /Mac|iPhone|iPad/.test((navigator && navigator.platform) || '');

  // ---- small helpers --------------------------------------------------------------
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function clip(s, max) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function cloneVal(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
  function cssEscape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function route() { try { return location.pathname + location.search + location.hash; } catch (e) { return '/'; } }
  function viewport() { return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 }; }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    (children || []).forEach(function (c) {
      if (c != null && c !== false) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  // ---- reading the page ---------------------------------------------------------------
  /** The element's own (direct) text, ignoring child elements. */
  function ownText(el) {
    var s = '';
    for (var i = 0; el && i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
    return s.replace(/\s+/g, ' ').trim();
  }
  /** All visible text under `el`, with a space between separate text runs. */
  function readableText(el) {
    if (!el) return '';
    var parts = [], total = 0, walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */, null), n;
    while ((n = walker.nextNode()) && total < 400) {
      var t = n.nodeValue.replace(/\s+/g, ' ').trim();
      var tag = n.parentElement && n.parentElement.tagName;
      if (!t || tag === 'SCRIPT' || tag === 'STYLE' || isOurs(n.parentElement)) continue;
      parts.push(t);
      total += t.length;
    }
    return parts.join(' ');
  }
  /** The first meaningful run of text under `el` (a card's title, a link's label…). */
  function firstText(el) {
    var walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */, null), n;
    while ((n = walker.nextNode())) {
      var t = n.nodeValue.replace(/\s+/g, ' ').trim();
      var tag = n.parentElement && n.parentElement.tagName;
      if (t.length >= 2 && tag !== 'SCRIPT' && tag !== 'STYLE' && !isOurs(n.parentElement)) return t;
    }
    return '';
  }

  /** Best-effort unique CSS path for `el` in the live DOM. */
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    try {
      if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + cssEscape(el.id);
      var testid = el.getAttribute('data-testid');
      if (testid) return '[data-testid="' + String(testid).replace(/"/g, '\\"') + '"]';
    } catch (e) {}
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 7) {
      var seg = node.tagName.toLowerCase();
      if (node !== el && node.id) {
        try { if (document.querySelectorAll('#' + cssEscape(node.id)).length === 1) { parts.unshift('#' + cssEscape(node.id)); break; } } catch (e) {}
      }
      var parent = node.parentElement;
      if (parent) {
        var same = 0, index = 0;
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) { same++; if (parent.children[i] === node) index = same; }
        }
        if (same > 1) seg += ':nth-of-type(' + index + ')';
      }
      parts.unshift(seg);
      node = parent; depth++;
    }
    return parts.join(' > ');
  }

  // Best-effort React component name from the fiber (present in dev builds;
  // minified in production: always a hint, never relied on).
  function componentHint(el) {
    try {
      var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
      if (!key) return '';
      var f = el[key], hops = 0;
      while (f && hops < 12) {
        var t = f.type;
        if (t && typeof t !== 'string') {
          var name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
          if (name && name.length > 2 && name[0] === name[0].toUpperCase()) return name;
        }
        f = f.return; hops++;
      }
    } catch (e) {}
    return '';
  }
  function nearestHeading(el) {
    var n = el;
    for (var hop = 0; n && hop < 6; hop++) {
      var p = n;
      while (p) {
        if (p.nodeType === 1 && /^H[1-6]$/.test(p.tagName) && p !== el) return clip(readableText(p), 60);
        p = p.previousElementSibling;
      }
      n = n.parentElement;
    }
    return '';
  }
  function landmark(el) {
    var l = el.closest && el.closest('header,nav,main,aside,footer,section,[role="dialog"],[role="navigation"]');
    if (!l || l === el) return '';
    return l.getAttribute('role') || l.tagName.toLowerCase();
  }
  function dataAttrs(el) {
    var out = {}, n = 0;
    for (var i = 0; el.attributes && i < el.attributes.length && n < 8; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && a.name !== 'data-graphein-spec') { out[a.name] = clip(a.value, 80); n++; }
    }
    return n ? out : undefined;
  }
  function chartRoot(el) { return el && el.closest ? el.closest('[data-graphein-spec]') : null; }
  function readSpec(chartEl) { try { return JSON.parse(chartEl.getAttribute('data-graphein-spec') || 'null'); } catch (e) { return null; } }
  function chartTitle(spec) {
    if (!spec) return '';
    return typeof spec.title === 'string' ? spec.title : (spec.title && spec.title.text) || '';
  }
  function isTransparent(color) { return !color || color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color); }

  // ---- roles and labels -------------------------------------------------------------
  var ROLE_NAMES = {
    button: 'Button', link: 'Link', heading: 'Heading', text: 'Text', image: 'Image', icon: 'Icon',
    field: 'Field', card: 'Card', list: 'List', item: 'List item', table: 'Table', chart: 'Chart',
    nav: 'Navigation', header: 'Header', footer: 'Footer', section: 'Section', container: 'Group', element: 'Element'
  };
  var TEXT_TAGS = /^(p|span|label|small|strong|em|b|i|blockquote|figcaption|dt|dd|caption|legend|code|time|abbr)$/;

  /** A container that reads as a card: its own surface (fill, border or shadow) plus rounded corners. */
  function looksLikeCard(el, cs) {
    if (!el.children.length) return false;
    var surface = !isTransparent(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0 || (cs.boxShadow && cs.boxShadow !== 'none');
    return surface && parseFloat(cs.borderTopLeftRadius) > 0;
  }
  function roleOf(el) {
    if (!el || el.nodeType !== 1) return 'element';
    if (el.hasAttribute('data-graphein-spec')) return 'chart';
    var tag = el.tagName.toLowerCase(), aria = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'button' || aria === 'button' || aria === 'tab' || aria === 'menuitem' || (tag === 'input' && /^(button|submit|reset)$/.test(el.type))) return 'button';
    if (tag === 'a' || aria === 'link') {
      var cs = getComputedStyle(el);
      return (!isTransparent(cs.backgroundColor) || parseFloat(cs.borderTopWidth) > 0) && parseFloat(cs.paddingLeft) >= 8 ? 'button' : 'link';
    }
    if (/^h[1-6]$/.test(tag) || aria === 'heading') return 'heading';
    if (/^(img|picture|video|canvas)$/.test(tag) || aria === 'img') return 'image';
    if (tag === 'svg') return 'icon';
    if (/^(input|select|textarea)$/.test(tag) || aria === 'textbox' || aria === 'combobox') return 'field';
    if (tag === 'ul' || tag === 'ol' || aria === 'list') return 'list';
    if (tag === 'li' || aria === 'listitem') return 'item';
    if (/^(table|thead|tbody|tr|td|th)$/.test(tag) || aria === 'table' || aria === 'grid') return 'table';
    if (tag === 'nav' || aria === 'navigation') return 'nav';
    if (tag === 'header' || aria === 'banner') return 'header';
    if (tag === 'footer' || aria === 'contentinfo') return 'footer';
    if (/^(section|main|aside|article|form)$/.test(tag) || aria === 'region' || aria === 'dialog') return 'section';
    if (TEXT_TAGS.test(tag)) return 'text';
    if (looksLikeCard(el, getComputedStyle(el))) return 'card';
    if (ownText(el) && el.children.length <= 2) return 'text';
    return el.children.length ? 'container' : 'element';
  }
  function nameOf(el, role) {
    var aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, 36);
    if (role === 'chart') { var spec = readSpec(el); return clip(chartTitle(spec) || (spec && spec.type) || '', 36); }
    if (role === 'image') return clip(el.getAttribute('alt') || el.getAttribute('title') || '', 36);
    if (role === 'field') {
      var id = el.getAttribute('id'), label = null;
      try { if (id) label = document.querySelector('label[for="' + cssEscape(id) + '"]'); } catch (e) {}
      return clip(el.getAttribute('placeholder') || (label && label.textContent) || el.getAttribute('name') || '', 36);
    }
    if (/^(card|section|container|nav|header|footer|list|table)$/.test(role)) {
      var heading = el.querySelector('h1,h2,h3,h4,h5,h6');
      return clip(heading ? readableText(heading) : firstText(el), 36);
    }
    return clip(ownText(el) || readableText(el), 36);
  }
  function labelOf(el) {
    var role = roleOf(el), name = nameOf(el, role);
    return (ROLE_NAMES[role] || 'Element') + (name ? ' · ' + name : '');
  }

  /** Normalize what the pointer is over into the element a person means. */
  function pick(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || isOurs(el)) return null;
    var chart = chartRoot(el);
    if (chart) return chart;
    while (el && el.namespaceURI === SVGNS && el.tagName.toLowerCase() !== 'svg') el = el.parentElement;
    if (!el) return null;
    if (/^(svg|span|img|strong|em|b|i|small)$/.test(el.tagName.toLowerCase())) {
      var control = el.closest('button,a,[role="button"]');
      if (control && control !== el) el = control;
    }
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  /** A compact copy of the element's HTML: long values clipped, drawing and code left out. */
  function htmlExcerpt(el) {
    var html = '';
    try {
      if (el.getElementsByTagName('*').length > 600) {
        var open = el.cloneNode(false);
        trimNode(open);
        html = open.outerHTML.replace(/<\/[^>]+>$/, '') + '…</' + el.tagName.toLowerCase() + '>';
      } else {
        var copy = el.cloneNode(true);
        trimNode(copy);
        html = copy.outerHTML;
      }
    } catch (e) { html = ''; }
    return clip(html, MAX_HTML);
  }
  function trimNode(node) {
    if (node.nodeType !== 1) return;
    for (var i = node.attributes.length - 1; i >= 0; i--) {
      var a = node.attributes[i];
      if (a.name === 'data-graphein-spec' || /^on/i.test(a.name)) node.removeAttribute(a.name);
      else if (a.value.length > 160) node.setAttribute(a.name, a.value.slice(0, 157) + '…');
    }
    var tag = node.tagName.toLowerCase();
    if (tag === 'svg') { while (node.firstChild) node.removeChild(node.firstChild); return; }
    for (var j = node.children.length - 1; j >= 0; j--) {
      var child = node.children[j], ct = child.tagName.toLowerCase();
      if (ct === 'script' || ct === 'style' || ct === 'template') node.removeChild(child);
      else trimNode(child);
    }
  }

  var STYLE_PROPS = ['display', 'position', 'margin', 'padding', 'gap', 'flex-direction', 'justify-content', 'align-items',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'text-transform',
    'color', 'background-color', 'background-image', 'border', 'border-radius', 'box-shadow', 'opacity'];
  var DEFAULTISH = /^(none|normal|auto|static|visible|start|stretch|row|0px|0px 0px|0px 0px 0px 0px|1)$/;
  /** The element's styles that say how it looks, without the browser defaults. */
  function styleSummary(el) {
    var out = {};
    try {
      var cs = getComputedStyle(el);
      STYLE_PROPS.forEach(function (p) {
        var v = (cs.getPropertyValue(p) || '').trim();
        if (!v || DEFAULTISH.test(v) || /^0px /.test(v) && p === 'border') return;
        if (p === 'background-color' && isTransparent(v)) return;
        if (p === 'font-family') v = v.split(',')[0].replace(/["']/g, '').trim();
        out[p] = clip(v, 100);
      });
    } catch (e) {}
    return out;
  }

  /** The part of `el` inside the viewport, in CSS px, or null when it's off screen. */
  function visibleRect(el) {
    var r = el.getBoundingClientRect();
    var x = Math.max(0, r.left), y = Math.max(0, r.top);
    var x2 = Math.min(window.innerWidth, r.right), y2 = Math.min(window.innerHeight, r.bottom);
    return x2 - x >= 2 && y2 - y >= 2 ? { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) } : null;
  }

  /** Everything chat needs to know about a picked element (see `PickTarget`). */
  function describe(el) {
    var role = roleOf(el), r = el.getBoundingClientRect();
    var target = {
      label: labelOf(el),
      role: role,
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      route: route(),
      box: { w: Math.round(r.width), h: Math.round(r.height) }
    };
    var text = role === 'chart' ? '' : clip(ownText(el) || readableText(el), 120);
    if (text) target.text = text;
    var classes = (el.getAttribute('class') || '').trim();
    if (classes) target.classes = clip(classes, 600);
    var comp = componentHint(el);
    if (comp) target.component = comp;
    var aria = el.getAttribute('aria-label');
    if (aria) target.ariaLabel = clip(aria, 80);
    var heading = nearestHeading(el);
    if (heading) target.nearestHeading = heading;
    var region = landmark(el);
    if (region) target.region = region;
    if (role === 'chart') {
      var spec = readSpec(el);
      target.chart = { type: (spec && spec.type) || el.getAttribute('data-graphein-type') || undefined, title: chartTitle(spec) || undefined };
    }
    var data = dataAttrs(el);
    if (data) target.dataAttrs = data;
    var styles = styleSummary(el);
    if (Object.keys(styles).length) target.styles = styles;
    var html = htmlExcerpt(el);
    if (html) target.html = html;
    return target;
  }

  // ---- state ------------------------------------------------------------------------
  var PAGE = uid('p');
  var state = {
    armed: false,
    on: false,
    theme: null,
    /** { id, n, el, target } in the host's order. */
    picks: [],
    /** Clipped regions waiting for their screenshot, by capture id. */
    caps: {},
    /** A Shift+drag clip in progress: where it started and where the pointer is. */
    clip: null,
    hover: null,
    hoverLabel: '',
    seq: 0,
    events: [],
    results: {},
    resultTimes: {},
    capturing: false,
    focusId: null,
    focusUntil: 0,
    /** The pointer is under the hint, which then lets the page show through. */
    under: false
  };
  var sync = function () {};

  function emit(type, data) {
    state.seq++;
    var event = { seq: state.seq, type: type };
    for (var k in data || {}) event[k] = data[k];
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    sync();
  }
  function putResult(id, value) {
    if (!id) return;
    state.results[id] = value;
    state.resultTimes[id] = Date.now();
    sync();
  }
  function expireResults() {
    var now = Date.now();
    for (var id in state.resultTimes) {
      if (now - state.resultTimes[id] > 15000) { delete state.results[id]; delete state.resultTimes[id]; }
    }
  }
  function pickOf(el) { for (var i = 0; i < state.picks.length; i++) if (state.picks[i].el === el) return state.picks[i]; return null; }
  function pickById(id) { for (var i = 0; i < state.picks.length; i++) if (state.picks[i].id === id) return state.picks[i]; return null; }
  function live(el) { return !!(el && el.isConnected); }

  // ---- chrome (Shadow DOM) -------------------------------------------------------------
  var host = null, root = null, ui = {};
  function isOurs(node) { return !!(node && host && (node === host || (node.closest && node.closest('#' + HOST_ID)))); }
  function inOurUi(e) {
    if (!host) return false;
    var path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(host) >= 0 || isOurs(e.target);
  }

  function parseColor(c) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (m) {
      var hex = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
    }
    m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(String(c || ''));
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
  }
  function lightness(c) {
    var p = parseColor(c);
    return p ? (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b) / 255 : 0;
  }
  function applyTheme() {
    if (!host) return;
    var t = state.theme || {};
    var accent = t.accent || '#34b4ba', panel = t.panel || '#12161f', txt = t.txt || '#eceff5';
    var vars = {
      '--fp-accent': accent,
      '--fp-on-accent': lightness(accent) > 0.6 ? '#0b1a1b' : '#ffffff',
      '--fp-panel': panel,
      '--fp-panel2': t.panel2 || panel,
      '--fp-border': t.border || 'rgba(127,127,127,.35)',
      '--fp-txt': txt,
      '--fp-dim': t.txtDim || txt,
      '--fp-scale': String(typeof t.scale === 'number' && t.scale > 0 ? clamp(t.scale, 0.8, 2) : 1)
    };
    for (var k in vars) host.style.setProperty(k, vars[k]);
  }

  var STYLE = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.layer{position:fixed;inset:0;pointer-events:none;z-index:2147483600;font:calc(12.5px*var(--fp-scale))/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fp-txt);-webkit-font-smoothing:antialiased}',
    '.layer.capturing>*{display:none!important}',
    '.frame{position:fixed;inset:0;border:2px solid var(--fp-accent);display:none}',
    '.on .frame{display:block}',
    '.box{position:fixed;display:none;border-radius:3px}',
    '.box.hover{outline:1.5px solid var(--fp-accent);background:color-mix(in srgb,var(--fp-accent) 10%,transparent);transition:left .08s ease-out,top .08s ease-out,width .08s ease-out,height .08s ease-out}',
    '.box.picked{outline:2px solid var(--fp-accent);outline-offset:1px}',
    '.box.focus{outline:2px solid var(--fp-accent);outline-offset:4px;animation:fpfocus .32s ease-out}',
    '.tag{position:fixed;display:none;max-width:min(420px,calc(100vw - 8px));padding:calc(2px*var(--fp-scale)) calc(7px*var(--fp-scale));border-radius:5px;background:var(--fp-accent);color:var(--fp-on-accent);font-size:calc(11.5px*var(--fp-scale));font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tag .size{margin-left:7px;font-weight:500;opacity:.75;font-variant-numeric:tabular-nums}',
    '.badge{position:fixed;display:flex;align-items:center;justify-content:center;min-width:calc(19px*var(--fp-scale));height:calc(19px*var(--fp-scale));padding:0 calc(5px*var(--fp-scale));border-radius:999px;background:var(--fp-accent);color:var(--fp-on-accent);font-size:calc(11px*var(--fp-scale));font-weight:700;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px var(--fp-panel);transform:translate(-45%,-45%)}',
    '.badge.pop{animation:fppop .28s cubic-bezier(.2,1.5,.45,1)}',
    '.flash{position:fixed;border-radius:3px;background:#fff;pointer-events:none;animation:fpflash .42s ease-out forwards}',
    '.hint{position:fixed;left:50%;top:12px;transform:translateX(-50%);display:flex;align-items:center;gap:calc(10px*var(--fp-scale));max-width:calc(100vw - 24px);padding:calc(5px*var(--fp-scale)) calc(5px*var(--fp-scale)) calc(5px*var(--fp-scale)) calc(12px*var(--fp-scale));border:1px solid var(--fp-border);border-radius:999px;background:var(--fp-panel);color:var(--fp-txt);white-space:nowrap;pointer-events:none;transition:opacity .15s ease;animation:fpin .2s ease-out}',
    '.hint.under{opacity:.18}',
    '.hint .dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--fp-accent)}',
    '.hint .what{font-weight:600}',
    '.hint .more{display:flex;align-items:center;gap:5px;color:var(--fp-dim);overflow:hidden;text-overflow:ellipsis}',
    '.hint kbd{display:inline-block;min-width:1.6em;padding:0 5px;border:1px solid var(--fp-border);border-bottom-width:2px;border-radius:5px;background:var(--fp-panel2);color:var(--fp-txt);font:inherit;font-size:.92em;font-weight:600;line-height:1.55;text-align:center}',
    '.hint .sep{width:1px;align-self:stretch;margin:2px 0;background:var(--fp-border)}',
    '.hint button{flex:none;padding:calc(3px*var(--fp-scale)) calc(11px*var(--fp-scale));border:1px solid var(--fp-border);border-radius:999px;background:var(--fp-panel2);color:var(--fp-txt);font:inherit;font-weight:600;cursor:pointer;pointer-events:auto}',
    '.hint button:hover{border-color:var(--fp-accent)}',
    '.clip{position:fixed;display:none;border:1.5px solid var(--fp-accent);border-radius:2px;background:color-mix(in srgb,var(--fp-accent) 6%,transparent);box-shadow:0 0 0 100vmax rgba(0,0,0,.3)}',
    '.clip .size{position:absolute;right:-1.5px;top:100%;margin-top:4px;padding:calc(1px*var(--fp-scale)) calc(6px*var(--fp-scale));border-radius:5px;background:var(--fp-accent);color:var(--fp-on-accent);font-size:calc(11px*var(--fp-scale));font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.clip.inside .size{top:auto;bottom:4px;right:4px;margin:0}',
    '.hint .what{min-width:0;overflow:hidden;text-overflow:ellipsis}',
    '@media (max-width:640px){.hint .more,.hint .sep{display:none}}',
    '.toast{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);padding:calc(6px*var(--fp-scale)) calc(12px*var(--fp-scale));border:1px solid var(--fp-border);border-radius:999px;background:var(--fp-panel);color:var(--fp-txt);font-weight:600;white-space:nowrap;animation:fpin .18s ease-out}',
    '@keyframes fppop{0%{transform:translate(-45%,-45%) scale(.2);opacity:0}100%{transform:translate(-45%,-45%) scale(1);opacity:1}}',
    '@keyframes fpfocus{0%{outline-offset:12px;opacity:0}100%{outline-offset:4px;opacity:1}}',
    '@keyframes fpflash{0%{opacity:.85}100%{opacity:0}}',
    '@keyframes fpin{0%{opacity:0}100%{opacity:1}}',
    '@media (prefers-reduced-motion: reduce){.box,.hint,.badge,.toast,.flash{transition:none!important;animation:none!important}.flash{display:none}}'
  ].join('\n');

  function buildChrome() {
    if (host && host.isConnected) return;
    var stale = document.getElementById(HOST_ID);
    if (stale) stale.remove();
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-fabricator-pick', '');
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', { text: STYLE }));
    ui.layer = h('div', { class: 'layer' });
    root.appendChild(ui.layer);
    ui.frame = h('div', { class: 'frame' });
    ui.hover = h('div', { class: 'box hover' });
    ui.tag = h('div', { class: 'tag' });
    ui.picks = h('div');
    ui.focus = h('div', { class: 'box focus' });
    ui.clip = h('div', { class: 'clip' }, [h('span', { class: 'size' })]);
    ui.effects = h('div');
    ui.hint = h('div');
    ui.toast = h('div');
    [ui.frame, ui.picks, ui.hover, ui.focus, ui.tag, ui.clip, ui.effects, ui.hint, ui.toast].forEach(function (n) { ui.layer.appendChild(n); });
    // Keep pointer and keyboard events on our own UI out of the app's handlers.
    ['keydown', 'keyup', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'].forEach(function (type) {
      host.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    applyTheme();
  }
  function destroyChrome() {
    if (host) host.remove();
    host = root = null;
    ui = {};
  }

  var toastTimer = 0;
  function toast(message) {
    if (!ui.toast) return;
    clearTimeout(toastTimer);
    ui.toast.className = message ? 'toast' : '';
    ui.toast.textContent = message || '';
    if (message) toastTimer = setTimeout(function () { toast(''); }, 1800);
  }

  function key(label) { return h('kbd', { text: label }); }
  function renderHint() {
    if (!ui.hint) return;
    ui.hint.textContent = '';
    ui.hint.className = '';
    if (!state.on) return;
    ui.hint.className = 'hint' + (state.under ? ' under' : '');
    var n = state.picks.length;
    var what = n ? n + ' picked · say in chat what to change' : 'Click anything to touch it up';
    ui.hint.appendChild(h('span', { class: 'dot' }));
    ui.hint.appendChild(h('span', { class: 'what', text: what }));
    ui.hint.appendChild(h('span', { class: 'sep' }));
    ui.hint.appendChild(h('span', { class: 'more' }, [key('Shift'), '+ drag to clip a screenshot']));
    ui.hint.appendChild(h('button', { type: 'button', text: 'Done', title: 'Finish picking (Esc)', onclick: function () { exitPicking(); } }));
  }

  function flash(rect) {
    if (!ui.effects || !rect) return;
    var node = h('div', { class: 'flash' });
    node.style.left = rect.x + 'px';
    node.style.top = rect.y + 'px';
    node.style.width = rect.w + 'px';
    node.style.height = rect.h + 'px';
    ui.effects.appendChild(node);
    setTimeout(function () { node.remove(); }, 500);
  }

  // ---- positioning (one rAF loop while the chrome is up) -------------------------------
  function place(node, r, pad) {
    if (!r || (!r.width && !r.height)) { node.style.display = 'none'; return; }
    pad = pad || 0;
    node.style.display = 'block';
    node.style.left = (r.left - pad) + 'px';
    node.style.top = (r.top - pad) + 'px';
    node.style.width = (r.width + pad * 2) + 'px';
    node.style.height = (r.height + pad * 2) + 'px';
  }
  function positionHover() {
    var el = state.hover;
    if (!state.on || !live(el)) { ui.hover.style.display = 'none'; ui.tag.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    place(ui.hover, r);
    var label = state.hoverLabel;
    var detail = pickOf(el) ? 'click to drop it' : Math.round(r.width) + ' × ' + Math.round(r.height);
    if (ui.tag.__label !== label || ui.tag.__detail !== detail) {
      ui.tag.__label = label;
      ui.tag.__detail = detail;
      ui.tag.textContent = '';
      ui.tag.appendChild(document.createTextNode(label));
      ui.tag.appendChild(h('span', { class: 'size', text: detail }));
    }
    ui.tag.style.display = 'block';
    var tw = ui.tag.getBoundingClientRect().width || 160, th = ui.tag.getBoundingClientRect().height || 20;
    ui.tag.style.left = clamp(r.left, 4, Math.max(4, window.innerWidth - tw - 4)) + 'px';
    ui.tag.style.top = (r.top >= th + 6 ? r.top - th - 4 : Math.min(window.innerHeight - th - 4, r.bottom + 4)) + 'px';
  }
  function positionPicks() {
    var holder = ui.picks, shown = 0;
    state.picks.forEach(function (p) {
      if (!state.on || !live(p.el)) return;
      var box = holder.children[shown * 2], badge = holder.children[shown * 2 + 1];
      if (!box) {
        box = h('div', { class: 'box picked' });
        badge = h('div', { class: 'badge' });
        holder.appendChild(box);
        holder.appendChild(badge);
      }
      shown++;
      var r = p.el.getBoundingClientRect();
      place(box, r, 1);
      if (badge.textContent !== String(p.n)) badge.textContent = String(p.n);
      if (p.fresh) {
        p.fresh = false;
        badge.classList.remove('pop');
        void badge.offsetWidth;
        badge.classList.add('pop');
      }
      var visible = r.width || r.height;
      badge.style.display = visible ? 'flex' : 'none';
      badge.style.left = clamp(r.left, 10, window.innerWidth - 10) + 'px';
      badge.style.top = clamp(r.top, 10, window.innerHeight - 10) + 'px';
    });
    while (holder.children.length > shown * 2) holder.removeChild(holder.lastChild);
  }
  function positionClip() {
    if (!ui.clip) return;
    var c = state.clip;
    if (!c) { ui.clip.style.display = 'none'; return; }
    var r = clipRect(c);
    ui.clip.style.display = 'block';
    ui.clip.style.left = r.x + 'px';
    ui.clip.style.top = r.y + 'px';
    ui.clip.style.width = r.w + 'px';
    ui.clip.style.height = r.h + 'px';
    ui.clip.firstChild.textContent = r.w + ' × ' + r.h;
    // The size sits under the clip, or inside it at the bottom of the view.
    ui.clip.classList.toggle('inside', r.y + r.h > window.innerHeight - 28);
  }
  function positionFocus() {
    var p = state.focusId ? pickById(state.focusId) : null;
    if (!p || !live(p.el) || Date.now() > state.focusUntil) { ui.focus.style.display = 'none'; return; }
    place(ui.focus, p.el.getBoundingClientRect(), 1);
  }

  var rafId = 0;
  function frame() {
    rafId = 0;
    if (!host) return;
    if (!state.capturing) {
      positionHover();
      positionPicks();
      positionFocus();
    }
    if (state.hover && !live(state.hover)) state.hover = null;
    if (!state.on && Date.now() > state.focusUntil) { destroyChrome(); return; }
    rafId = requestAnimationFrame(frame);
  }
  function loop() { if (!rafId) rafId = requestAnimationFrame(frame); }

  // ---- input ------------------------------------------------------------------------
  var BLOCKED = ['click', 'dblclick', 'mousedown', 'mouseup', 'auxclick', 'contextmenu', 'pointerup', 'submit'];
  function isShortcut(e) {
    return (MAC ? e.metaKey : e.ctrlKey) && e.shiftKey && !e.altKey && (e.code === 'KeyC' || e.key === 'C' || e.key === 'c');
  }
  function setHover(el) {
    if (el === state.hover) return;
    state.hover = el;
    state.hoverLabel = el ? labelOf(el) : '';
  }
  function onPointerMove(e) {
    if (state.capturing) return;
    if (state.clip) {
      state.clip.x1 = e.clientX;
      state.clip.y1 = e.clientY;
      positionClip();
      return;
    }
    if (ui.hint && ui.hint.firstChild) {
      var r = ui.hint.getBoundingClientRect();
      var under = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom && !inOurUi(e);
      if (under !== state.under) { state.under = under; ui.hint.classList.toggle('under', under); }
    }
    // Shift held clips rather than picks, so nothing is highlighted.
    setHover(inOurUi(e) || e.altKey || e.shiftKey ? null : pick(e.target));
  }
  function onPointerDown(e) {
    if (inOurUi(e) || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    if (e.shiftKey) { startClip(e); return; }
    var el = pick(e.target);
    if (el) togglePick(el);
  }
  function onPointerUp(e) {
    if (!state.clip) return;
    e.preventDefault();
    e.stopPropagation();
    state.clip.x1 = e.clientX;
    state.clip.y1 = e.clientY;
    finishClip();
  }
  function blockEvent(e) {
    if (inOurUi(e) || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onKeyDown(e) {
    if (!state.armed) return;
    if (frameRole === 'relay') {
      // The shell has no chrome of its own: the keys drive the app frame.
      if (isShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        postToApp({ cmd: 'command', command: { op: 'toggle' } });
      } else if (e.key === 'Escape' && relay.status && relay.status.on) {
        postToApp({ cmd: 'command', command: { op: 'exit' } });
      }
      return;
    }
    if (isShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      if (state.on) exitPicking(); else enterPicking();
      return;
    }
    if (state.on && e.key === 'Shift') setHover(null);
    if (state.on && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // Escape lets go of a clip being dragged; otherwise it finishes.
      if (state.clip) cancelClip(); else exitPicking();
    }
  }
  function onBlur() { setHover(null); cancelClip(); }

  // ---- picking ----------------------------------------------------------------------
  function togglePick(el) {
    var existing = pickOf(el);
    if (existing) {
      dropPick(existing.id);
      emit('unpick', { id: existing.id });
      return;
    }
    if (state.picks.length >= MAX_PICKS) { toast('You can pick up to ' + MAX_PICKS + ' elements at a time'); return; }
    var p = { id: uid('k'), n: state.picks.length + 1, el: el, target: describe(el), fresh: true };
    state.picks.push(p);
    setHover(null);
    renderHint();
    emit('pick', { pick: { id: p.id, n: p.n, target: p.target, rect: visibleRect(el) } });
  }
  function dropPick(id) {
    state.picks = state.picks.filter(function (p) { return p.id !== id; });
    state.picks.forEach(function (p, i) { p.n = i + 1; });
    if (state.focusId === id) state.focusId = null;
    renderHint();
  }
  // ---- clipping (Shift+drag) ----------------------------------------------------------
  function clipRect(c) {
    var x = clamp(Math.min(c.x0, c.x1), 0, window.innerWidth), y = clamp(Math.min(c.y0, c.y1), 0, window.innerHeight);
    var x2 = clamp(Math.max(c.x0, c.x1), 0, window.innerWidth), y2 = clamp(Math.max(c.y0, c.y1), 0, window.innerHeight);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(x2 - x), h: Math.round(y2 - y) };
  }
  function startClip(e) {
    setHover(null);
    state.clip = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    // Keep the drag ours even if the pointer leaves the page.
    try { if (e.pointerId != null) document.documentElement.setPointerCapture(e.pointerId); } catch (err) {}
    positionClip();
  }
  function cancelClip() {
    if (!state.clip) return;
    state.clip = null;
    positionClip();
  }
  /** The clip is done: the host takes a screenshot of the region and attaches it. */
  function finishClip() {
    var c = state.clip;
    state.clip = null;
    positionClip();
    if (!c) return;
    var r = clipRect(c);
    if (r.w < MIN_CLIP || r.h < MIN_CLIP) return;
    var id = uid('c');
    state.caps[id] = r;
    setTimeout(function () { delete state.caps[id]; }, 20000);
    emit('capture', { capture: { id: id, label: 'Clip', rect: r } });
  }
  /** The host's picks are the truth: keep those, in its order and numbering, and
   *  find the ones this page hasn't seen (after a reload) by their selector. */
  function syncPicks(list) {
    if (!Array.isArray(list)) return;
    var next = [];
    list.forEach(function (hp) {
      if (!hp || !hp.id) return;
      var p = pickById(hp.id);
      if (!p) {
        var el = null;
        try { if (hp.selector && (!hp.route || hp.route === route())) el = document.querySelector(hp.selector); } catch (e) { el = null; }
        p = { id: hp.id, el: el, target: null };
      }
      p.n = hp.n || next.length + 1;
      next.push(p);
    });
    state.picks = next;
    renderHint();
  }

  function prepareCapture(requestId, ids) {
    state.capturing = true;
    if (ui.layer) ui.layer.classList.add('capturing');
    var rects = {};
    (Array.isArray(ids) ? ids : []).forEach(function (id) {
      var r = capRect(id);
      if (r) rects[id] = r;
    });
    putResult(requestId, { viewport: viewport(), frame: isTop ? { x: 0, y: 0 } : null, rects: rects });
    clearTimeout(captureTimer);
    captureTimer = setTimeout(endCapture, 4000);
  }
  var captureTimer = 0;
  /** Where a capture is now: a pick's element, or a clipped region of the view. */
  function capRect(id) {
    var p = pickById(id);
    if (p) return live(p.el) ? visibleRect(p.el) : null;
    var r = state.caps[id];
    return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
  }
  function endCapture(flashId) {
    clearTimeout(captureTimer);
    if (state.capturing) {
      state.capturing = false;
      if (ui.layer) ui.layer.classList.remove('capturing');
    }
    if (!flashId) return;
    var r = capRect(flashId);
    if (r) {
      flash(r);
      if (!pickById(flashId)) toast('Clip added to chat');
    }
    delete state.caps[flashId];
  }
  function focusPick(id) {
    state.focusId = id || null;
    state.focusUntil = id ? Date.now() + 6000 : 0;
    var p = id ? pickById(id) : null;
    if (p && live(p.el)) {
      var r = p.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        try { p.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      }
      buildChrome();
      if (ui.focus) {
        ui.focus.style.animation = 'none';
        void ui.focus.offsetWidth;
        ui.focus.style.animation = '';
      }
    }
    if (host) loop();
  }

  // ---- on / off ---------------------------------------------------------------------
  function arm() {
    if (state.armed) return;
    state.armed = true;
    window.addEventListener('keydown', onKeyDown, true);
  }
  function disarm() {
    disablePicking();
    if (!state.armed) return;
    state.armed = false;
    window.removeEventListener('keydown', onKeyDown, true);
  }
  function enablePicking() {
    if (state.on) return;
    arm();
    state.on = true;
    buildChrome();
    ui.layer.classList.add('on');
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', cancelClip, true);
    window.addEventListener('blur', onBlur);
    BLOCKED.forEach(function (t) { window.addEventListener(t, blockEvent, true); });
    if (!document.getElementById(CURSOR_ID)) {
      var style = document.createElement('style');
      style.id = CURSOR_ID;
      style.textContent = '*,*::before,*::after{cursor:crosshair!important}';
      (document.head || document.documentElement).appendChild(style);
    }
    renderHint();
    loop();
  }
  function disablePicking() {
    if (!state.on) return;
    state.on = false;
    setHover(null);
    state.under = false;
    cancelClip();
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', cancelClip, true);
    window.removeEventListener('blur', onBlur);
    BLOCKED.forEach(function (t) { window.removeEventListener(t, blockEvent, true); });
    var cursor = document.getElementById(CURSOR_ID);
    if (cursor) cursor.remove();
    endCapture();
    toast('');
    if (ui.layer) ui.layer.classList.remove('on');
    renderHint();
    if (Date.now() > state.focusUntil) destroyChrome();
  }
  function enterPicking() {
    if (state.on) return;
    enablePicking();
    emit('enter');
  }
  function exitPicking() {
    if (!state.on) return;
    disablePicking();
    emit('exit');
  }

  function applyLocal(o) {
    o = o || {};
    if (o.theme) { state.theme = o.theme; applyTheme(); }
    if (o.picks) syncPicks(o.picks);
    if (!o.armed) { disarm(); return; }
    arm();
    if (o.on) enablePicking(); else disablePicking();
  }
  /** The state, with only the events after `since` when `page` is still this page. */
  function localPeek(opts) {
    expireResults();
    var since = opts && opts.page === PAGE && typeof opts.since === 'number' ? opts.since : 0;
    return {
      v: VERSION,
      page: PAGE,
      armed: state.armed,
      on: state.on,
      seq: state.seq,
      events: cloneVal(state.events.filter(function (e) { return e.seq > since; })),
      results: cloneVal(state.results),
      route: route(),
      viewport: viewport()
    };
  }
  function localCommand(cmd) {
    if (!cmd || typeof cmd.op !== 'string') return { accepted: false };
    switch (cmd.op) {
      case 'prepareCapture': prepareCapture(cmd.requestId, cmd.ids); break;
      case 'endCapture': endCapture(cmd.flash); break;
      case 'focus': focusPick(cmd.id); break;
      case 'sync': syncPicks(cmd.picks); break;
      case 'toggle': if (state.on) exitPicking(); else if (state.armed) enterPicking(); break;
      case 'exit': exitPicking(); break;
      default: return { accepted: false };
    }
    sync();
    return { accepted: true };
  }

  // ---- frame roles + the Fabric relay -----------------------------------------------
  // The host only evals in the TOP frame. When the app is embedded in a
  // cross-origin iframe (Fabric portal), the top frame runs as a `relay`: it
  // forwards `set` and commands to the app frame over postMessage (origin-gated
  // to the deployed app) and mirrors its state back.
  var frameRole = 'idle'; // 'idle' | 'direct' | 'relay' | 'app'
  var isTop = true;
  try { isTop = window.top === window.self; } catch (e) { isTop = true; }

  var relay = { appWin: null, appOrigin: null, options: null, status: null, hellos: [], pingTimer: 0, pingCount: 0 };
  function postToApp(msg) {
    msg.ns = MSG;
    try { if (relay.appWin && relay.appOrigin) relay.appWin.postMessage(msg, relay.appOrigin); } catch (e) {}
  }
  function stopPing() { if (relay.pingTimer) { clearTimeout(relay.pingTimer); relay.pingTimer = 0; } }
  // The relay can't enumerate nested cross-origin frames, so it pings its direct
  // children (origin-gated) to prompt a hello.
  function pingChildren() {
    stopPing();
    relay.pingCount = 0;
    (function tick() {
      if (frameRole !== 'relay' || relay.appWin) { stopPing(); return; }
      try { for (var i = 0; i < window.frames.length; i++) { try { window.frames[i].postMessage({ ns: MSG, cmd: 'ping' }, relay.appOrigin || '*'); } catch (e) {} } } catch (e) {}
      if (++relay.pingCount >= 10) { stopPing(); return; }
      relay.pingTimer = setTimeout(tick, 500);
    })();
  }
  function relaySet(origin, options) {
    frameRole = 'relay';
    if (relay.appOrigin !== (origin || null)) { relay.appWin = null; relay.status = null; }
    relay.appOrigin = origin || null;
    relay.options = cloneVal(options || {});
    // The shell forwards the shortcut while it has the keyboard.
    if (relay.options.armed) arm(); else disarm();
    for (var i = 0; i < relay.hellos.length; i++) if (relay.hellos[i].origin === relay.appOrigin) relay.appWin = relay.hellos[i].source;
    relay.hellos = [];
    if (relay.appWin) postToApp({ cmd: 'set', options: relay.options });
    else pingChildren();
    if (!relay.options.armed) { relay.status = null; frameRole = 'idle'; }
  }
  /** Where the app iframe sits inside this (top) window, or null when it's nested deeper. */
  function frameOffset() {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      try {
        if (frames[i].contentWindow !== relay.appWin) continue;
        var r = frames[i].getBoundingClientRect(), cs = getComputedStyle(frames[i]);
        return { x: r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0), y: r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0) };
      } catch (e) {}
    }
    return null;
  }
  function relayPeek(opts) {
    var o = relay.options || {};
    if (!relay.status) {
      return { v: VERSION, page: null, armed: !!o.armed, on: !!o.on, seq: 0, events: [], results: {}, route: '', viewport: viewport() };
    }
    var s = cloneVal(relay.status);
    var since = opts && opts.page === s.page && typeof opts.since === 'number' ? opts.since : 0;
    s.events = (s.events || []).filter(function (e) { return e.seq > since; });
    for (var id in s.results || {}) {
      var r = s.results[id];
      if (r && r.rects) { r.frame = frameOffset(); r.viewport = viewport(); }
    }
    return s;
  }
  function relayCommand(cmd) {
    if (!cmd || typeof cmd.op !== 'string') return { accepted: false };
    if (cmd.op === 'sync' && relay.options) relay.options.picks = cmd.picks;
    postToApp({ cmd: 'command', command: cmd });
    return { accepted: !!relay.appWin };
  }

  // App side (the embedded iframe).
  var appSide = { topOrigin: null, acked: false, syncTimer: 0, pending: 0 };
  // The only legitimate relay is the Fabric (or Power BI) portal hosting the app.
  // Any other top-level page could frame a site and use this agent to read it,
  // so the app side only talks to portal origins.
  var RELAY_HOSTS = /(^|\.)(fabric\.microsoft\.(com|us|cn)|powerbi\.com|powerbigov\.us|powerbi\.cn)$/i;
  function trustedRelay(origin) {
    try { var u = new URL(origin); return u.protocol === 'https:' && RELAY_HOSTS.test(u.hostname); } catch (e) { return false; }
  }
  /** The top frame's origin when the browser reports it (`location.ancestorOrigins`). */
  function topOrigin() {
    try { var a = location.ancestorOrigins; return a && a.length ? a[a.length - 1] : null; } catch (e) { return null; }
  }
  function sayHello() {
    if (isTop) return;
    var top = topOrigin();
    if (top && !trustedRelay(top)) return;
    try { window.top.postMessage({ ns: MSG, evt: 'hello' }, top || '*'); } catch (e) {}
  }
  function scheduleHellos() {
    if (isTop) return;
    [0, 250, 750, 1500, 3000, 6000].forEach(function (ms) { setTimeout(function () { if (!appSide.acked) sayHello(); }, ms); });
    try {
      document.addEventListener('DOMContentLoaded', function () { if (!appSide.acked) sayHello(); });
      window.addEventListener('load', function () { if (!appSide.acked) sayHello(); });
    } catch (e) {}
  }
  function postState() {
    if (isTop || frameRole !== 'app' || !appSide.topOrigin) return;
    try { window.top.postMessage({ ns: MSG, evt: 'state', status: localPeek() }, appSide.topOrigin); } catch (e) {}
  }
  function scheduleSync() {
    if (frameRole !== 'app' || appSide.pending) return;
    appSide.pending = setTimeout(function () { appSide.pending = 0; postState(); }, 30);
  }
  function onRelayCommand(d, e) {
    appSide.topOrigin = e.origin || null;
    appSide.acked = true;
    switch (d.cmd) {
      case 'ping': sayHello(); break;
      case 'set':
        frameRole = 'app';
        sync = scheduleSync;
        applyLocal(d.options || {});
        if (!appSide.syncTimer) appSide.syncTimer = setInterval(postState, 1000);
        postState();
        break;
      case 'command': localCommand(d.command); postState(); break;
    }
  }
  function onMessage(e) {
    var d = e && e.data;
    if (!d || d.ns !== MSG) return;
    if (isTop) {
      if (frameRole !== 'relay' && !(frameRole === 'idle' && d.evt === 'hello')) return;
      if (d.evt === 'hello') {
        if (relay.appOrigin) {
          if (e.origin === relay.appOrigin) {
            relay.appWin = e.source;
            if (frameRole === 'relay' && relay.options) postToApp({ cmd: 'set', options: relay.options });
          }
        } else {
          relay.hellos.push({ source: e.source, origin: e.origin });
          if (relay.hellos.length > 12) relay.hellos.shift();
        }
      } else if (d.evt === 'state' && e.origin === relay.appOrigin && e.source === relay.appWin) {
        relay.status = d.status || null;
      }
    } else if (d.cmd) {
      var fromTop = false;
      try { fromTop = e.source === window.top; } catch (err) { fromTop = false; }
      if (fromTop && trustedRelay(e.origin)) onRelayCommand(d, e);
    }
  }

  // ---- public API ---------------------------------------------------------------------
  function hostSet(mode, appOrigin, options) {
    if (mode === 'relay') { relaySet(appOrigin, options || {}); return; }
    if (frameRole === 'relay') relaySet(relay.appOrigin, { armed: false });
    frameRole = options && options.armed ? 'direct' : 'idle';
    applyLocal(options || {});
  }
  window[NS] = {
    __v: VERSION,
    set: function (mode, appOrigin, options) { try { hostSet(mode, appOrigin, options); } catch (e) {} },
    peek: function (opts) { try { return frameRole === 'relay' ? relayPeek(opts) : localPeek(opts); } catch (e) { return null; } },
    command: function (cmd) { try { return frameRole === 'relay' ? relayCommand(cmd) : localCommand(cmd); } catch (e) { return { accepted: false }; } },
    // Pure helpers, exposed for unit tests.
    __test: {
      roleOf: roleOf,
      labelOf: labelOf,
      pick: pick,
      describe: describe,
      htmlExcerpt: htmlExcerpt,
      styleSummary: styleSummary,
      shadow: function () { return root; }
    }
  };
  window.addEventListener('message', onMessage);
  if (!isTop) scheduleHellos();
})();
