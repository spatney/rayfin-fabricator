/*
 * Rayfin preview "design mode" controller (v2).
 *
 * Injected into the preview webview (the user's deployed app) on demand — see
 * `preview.rs` (`DESIGN_AGENT_JS`, evaluated by `preview_design_set`). A
 * Figma-like, click-to-edit layer over the LIVE app:
 *   - Select tool: pick any element and edit it in a docked inspector (size,
 *     spacing, typography, appearance, text) with always-on move/resize handles
 *     and arrow-key nudge; a structured Graphein spec editor for charts.
 *   - Comment tool: drop numbered pins with a note on elements.
 *   - Draw tool: freehand / arrow / rectangle / ellipse markup over the preview.
 * Every edit is applied live (WYSIWYG) AND recorded into a change-set with a
 * revert closure (undo) and rich agent context. "Send to chat" composes a
 * numbered instruction + a fenced JSON change-set and marks the elements so the
 * host can capture a screenshot whose numbered badges match the list.
 *
 * Design constraints:
 *   - The native webview paints above all HTML, so ALL UI lives INSIDE this page,
 *     in a Shadow DOM attached to <html> (isolated from the app's CSS; survives
 *     SPA body swaps). Everything is torn down on `disable()`, namespaced under
 *     `window.__rayfinDesign`, and never persisted.
 *   - Host comms are pull-based: the host polls `peek()` and reads `drain()`.
 */
(function () {
  var NS = '__rayfinDesign';
  var VERSION = 2;
  if (window[NS] && window[NS].__v === VERSION) return;

  var HOST_ID = '__rayfin_design_host';

  // ---- theme (flat, teal — matches the host app) ---------------------------
  var TEAL = '#14b8a6';
  var TEAL_HI = '#2dd4bf';
  var AMBER = '#f59e0b';
  var PANEL_BG = '#0f1419';
  var PANEL_BG2 = '#161c24';
  var BORDER = '#26303b';
  var TXT = '#e6e8eb';
  var TXT_DIM = '#98a2b0';
  // Translucent panel fill (a little of the app shows through, softened by a
  // blur) for the floating chrome — toolbar, inspector, legend, comment popover.
  // Inner form fields keep the opaque PANEL_BG2 so inputs stay legible.
  var PANEL_GLASS = 'rgba(15,20,25,.84)';
  var GLASS_FX = 'backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%)';

  // ---- state ---------------------------------------------------------------
  var state = {
    enabled: false,
    tool: 'select', // 'select' | 'comment' | 'draw'
    drawShape: 'pen', // 'pen' | 'arrow' | 'rect' | 'ellipse'
    drawColor: AMBER,
    version: 0, // bumped on every change so the host poll detects activity
    changes: [], // ordered change-set entries (each has .revert, .el|.pinEl|.node)
    selected: null,
    selInline: null, // snapshot of the selected element's inline styles at select
    resizing: null,
    move: null, // active move gesture (or pending, pre-threshold)
    drawing: null, // active draw gesture
    hoverEl: null,
    handoff: null,
    aiRequest: null, // pending "Generate with AI" request for a placeholder
    models: null, // [{id,name,fast}] supplied by the host for the AI model picker
    aiModel: '' // selected model id ('' → host default / fast)
  };

  // ---- constants -----------------------------------------------------------
  var CHART_TYPES = ['bar', 'line', 'area', 'scatter', 'combo', 'histogram', 'pie', 'funnel', 'waterfall', 'treemap', 'heatmap'];
  var PALETTES = ['graphein', 'colorblind', 'bright', 'muted'];
  var FORMATS = [['', 'Default'], [',.0f', '1,234'], [',.2f', '1,234.56'], ['$,.0f', '$1,234'], ['.1%', '12.3%'], ['.2s', '1.2k']];
  var WEIGHTS = ['300', '400', '500', '600', '700', '800'];
  var ALIGNS = ['left', 'center', 'right', 'justify'];

  // ---- tiny DOM helpers ----------------------------------------------------
  var SVGNS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    applyAttrs(el, attrs);
    append(el, children);
    return el;
  }
  function svg(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }
  function applyAttrs(el, attrs) {
    if (!attrs) return;
    for (var k in attrs) {
      if (k === 'style') el.setAttribute('style', attrs[k]);
      else if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
  }
  function append(el, children) {
    if (!children) return;
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  function bump() { state.version++; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function isOurs(node) { return !!(node && (node === host || (node.closest && node.closest('#' + HOST_ID)))); }

  // ---- selectors + rich agent context --------------------------------------
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  function cssAttr(s) { return String(s).replace(/"/g, '\\"'); }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + cssEscape(el.id);
    var testid = el.getAttribute && el.getAttribute('data-testid');
    if (testid) return '[data-testid="' + cssAttr(testid) + '"]';
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 6) {
      var seg = node.tagName.toLowerCase();
      if (node.id && document.querySelectorAll('#' + cssEscape(node.id)).length === 1) { parts.unshift('#' + cssEscape(node.id)); break; }
      var parent = node.parentNode;
      if (parent && parent.nodeType === 1) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent; depth++;
    }
    return parts.join(' > ');
  }

  function shortText(el) {
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.length > 48 ? t.slice(0, 48) + '…' : t;
  }

  function describe(el) {
    if (!el) return '(none)';
    if (el.getAttribute && el.getAttribute('data-rayfin-placeholder') === '1') { var pt = shortText(el); return 'new placeholder' + (pt ? ' “' + pt + '”' : ''); }
    if (chartRoot(el)) return 'Graphein ' + (chartRoot(el).getAttribute('data-graphein-type') || '') + ' chart';
    var tag = el.tagName.toLowerCase();
    var cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    var txt = shortText(el);
    return '<' + tag + (el.id ? '#' + el.id : cls) + '>' + (txt ? ' “' + txt + '”' : '');
  }

  // Best-effort React component name from the fiber (present in dev builds;
  // minified in prod — always a hint, never relied on).
  function componentHint(el) {
    try {
      var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
      if (!key) return '';
      var f = el[key], hops = 0;
      while (f && hops < 12) {
        var t = f.type;
        if (t && typeof t !== 'string') {
          var name = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
          if (name && name.length > 1 && name[0] === name[0].toUpperCase()) return name;
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
        if (p.nodeType === 1 && /^H[1-6]$/.test(p.tagName)) return shortText(p);
        p = p.previousElementSibling;
      }
      n = n.parentElement;
    }
    return '';
  }

  function landmark(el) {
    var l = el.closest && el.closest('header,nav,main,aside,footer,section,[role]');
    if (!l) return '';
    var role = l.getAttribute('role');
    return role ? role : l.tagName.toLowerCase();
  }

  function dataAttrs(el) {
    var out = {};
    if (!el.attributes) return out;
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0 && a.name !== 'data-graphein-spec') out[a.name] = a.value;
    }
    return out;
  }

  // Rich, JSON-serializable context for the agent.
  function context(el) {
    if (!el || el.nodeType !== 1) return {};
    var r = el.getBoundingClientRect();
    var ctx = {
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el),
      text: shortText(el) || undefined,
      classes: (typeof el.className === 'string' && el.className.trim()) ? el.className.trim() : undefined,
      role: el.getAttribute && (el.getAttribute('role') || undefined),
      ariaLabel: el.getAttribute && (el.getAttribute('aria-label') || undefined),
      component: componentHint(el) || undefined,
      region: landmark(el) || undefined,
      nearestHeading: nearestHeading(el) || undefined,
      box: { w: Math.round(r.width), h: Math.round(r.height) }
    };
    var da = dataAttrs(el);
    if (Object.keys(da).length) ctx.dataAttrs = da;
    return ctx;
  }

  // ---- Graphein integration ------------------------------------------------
  function chartRoot(el) { return (el && el.closest) ? el.closest('[data-graphein-spec]') : null; }
  function readSpec(chartEl) { try { return JSON.parse(chartEl.getAttribute('data-graphein-spec') || 'null'); } catch (e) { return null; } }
  function writeSpec(chartEl, spec) { try { chartEl.setAttribute('data-graphein-spec', JSON.stringify(spec)); } catch (e) {} }
  function stripData(spec) { if (!spec || typeof spec !== 'object') return spec; var c = {}; for (var k in spec) if (k !== 'data') c[k] = spec[k]; return c; }

  // ---- change-set + undo ---------------------------------------------------
  // Coalesce edits of the same element facet (identity + kind + property; robust
  // to selector drift after a move), keeping the original from/revert and moving
  // the touched entry to the end so undo pops the most-recently-edited change.
  // Distinct-instance kinds (comment / annotation / insert) never coalesce —
  // each is its own entry.
  var COALESCE_KINDS = { style: 1, resize: 1, move: 1, text: 1, chart: 1 };
  function record(entry) {
    if (COALESCE_KINDS[entry.kind] && entry.el != null) {
      for (var i = 0; i < state.changes.length; i++) {
        var c = state.changes[i];
        if (c.el === entry.el && c.kind === entry.kind && (c.property || '') === (entry.property || '')) {
          c.to = entry.to; c.after = entry.after; c.target = entry.target || c.target;
          c.label = entry.label; c.selector = entry.selector;
          state.changes.splice(i, 1); state.changes.push(c);
          bump(); renderBar(); return;
        }
      }
    }
    if (typeof entry.revert !== 'function') entry.revert = function () {};
    state.changes.push(entry);
    bump(); renderBar();
  }
  function revertEntry(entry) { try { if (entry && typeof entry.revert === 'function') entry.revert(); } catch (e) {} }

  function undoLast() {
    if (state.editingText) commitText();
    var entry = state.changes.pop();
    if (!entry) return;
    revertEntry(entry);
    if (state.selected && !state.selected.isConnected) deselect();
    if (state.selected && state.selected.isConnected) renderInspector();
    bump(); reposition(); renderBar();
  }

  // ---- Shadow-DOM UI -------------------------------------------------------
  var host, root;
  var elHover, elLabel, elSel, elBadges, elHandles, elInsert, elToolbar, elInspector, elDraw, elPins, elLegend, elCommentEditor;
  var elCount, btnUndo, btnDiscard, btnSend;

  var STYLE = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
    'button{all:unset;cursor:pointer}',
    // overlays
    '.box{position:fixed;pointer-events:none;z-index:2147483640;border-radius:3px}',
    '.hover{border:1.5px solid ' + TEAL + '88;background:' + TEAL + '11}',
    '.sel{border:1.5px solid ' + TEAL + ';box-shadow:0 0 0 1px ' + TEAL + '55}',
    '.label{position:fixed;pointer-events:none;z-index:2147483644;background:' + TEAL + ';color:#04211f;font-size:11px;font-weight:600;padding:2px 6px;border-radius:4px;white-space:nowrap}',
    '.badge{position:fixed;pointer-events:none;z-index:2147483644;background:' + TEAL + ';color:#04211f;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px}',
    '.ring{position:fixed;pointer-events:none;z-index:2147483639;border:2px solid ' + AMBER + ';border-radius:4px;box-shadow:0 0 0 2px ' + AMBER + '44}',
    '.marker{position:fixed;pointer-events:none;z-index:2147483645;min-width:18px;height:18px;line-height:18px;text-align:center;background:' + AMBER + ';color:#241a04;font-size:11px;font-weight:800;border-radius:9px;padding:0 4px;box-shadow:0 1px 4px rgba(0,0,0,.5)}',
    '.insert{position:fixed;pointer-events:none;z-index:2147483643;background:' + TEAL + ';box-shadow:0 0 6px ' + TEAL + '}',
    '.hnd{position:fixed;width:12px;height:12px;background:' + TEAL + ';border:2px solid #fff;border-radius:3px;z-index:2147483643;pointer-events:auto;box-shadow:0 1px 5px rgba(0,0,0,.45)}',
    '.hnd:hover{background:' + TEAL_HI + ';transform:scale(1.18)}',
    // draw layer + pins
    '.draw{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483638;pointer-events:none;overflow:visible}',
    '.pins{position:fixed;inset:0;z-index:2147483643;pointer-events:none}',
    '.pin{position:fixed;transform:translate(-50%,-100%);z-index:2147483643;pointer-events:auto;cursor:pointer;width:22px;height:22px;line-height:20px;text-align:center;background:' + AMBER + ';color:#241a04;font-size:11px;font-weight:800;border:2px solid #fff;border-radius:50% 50% 50% 2px;box-shadow:0 2px 6px rgba(0,0,0,.5)}',
    // toolbar (top-center)
    '.tb{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483646;display:flex;flex-wrap:wrap;justify-content:center;max-width:94vw;align-items:center;gap:4px;padding:4px;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:11px;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:auto;cursor:move}',
    '.seg{display:flex;background:' + PANEL_BG2 + ';border-radius:8px;padding:2px;gap:2px}',
    '.seg button{display:flex;align-items:center;gap:6px;color:' + TXT_DIM + ';font-size:12px;font-weight:500;padding:6px 8px;border-radius:6px}',
    '.seg button:hover{color:' + TXT + '}',
    '.seg button.on{background:' + TEAL + ';color:#04211f}',
    '.tb .swatches{display:flex;gap:4px;align-items:center;padding-left:6px;border-left:1px solid ' + BORDER + '}',
    '.tb .sw-picker{width:26px;height:26px;padding:0;border:1px solid ' + BORDER + ';border-radius:7px;background:none;cursor:pointer}',
    '.tb .sw-picker:hover{border-color:' + TXT_DIM + '}',
    '.tb .sw-picker::-webkit-color-swatch-wrapper{padding:2px}',
    '.tb .sw-picker::-webkit-color-swatch{border:none;border-radius:5px}',
    '.tb .shape{color:' + TXT_DIM + ';padding:5px 7px;border-radius:6px;font-size:12px}',
    '.tb .shape.on{background:' + PANEL_BG2 + ';color:' + TXT + '}',
    // inspector (right dock)
    '.insp{position:fixed;right:12px;top:58px;max-height:calc(100vh - 70px);width:248px;z-index:2147483645;display:flex;flex-direction:column;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:11px;box-shadow:0 10px 40px rgba(0,0,0,.55);pointer-events:auto;color:' + TXT + ';overflow:hidden}',
    '.insp-head{padding:9px 11px;border-bottom:1px solid ' + BORDER + ';cursor:move}',
    '.crumb{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:11px;color:' + TXT_DIM + '}',
    '.crumb button{color:' + TXT_DIM + ';padding:1px 4px;border-radius:4px}',
    '.crumb button:hover{background:' + PANEL_BG2 + ';color:' + TXT + '}',
    '.crumb .cur{color:' + TEAL + ';font-weight:600}',
    '.insp-sz{font-size:11px;color:' + TXT_DIM + ';margin-top:4px}',
    '.insp-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:5px 11px 11px}',
    '.grp{margin-top:11px}',
    '.grp>h5{margin:0 0 6px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:' + TXT_DIM + ';font-weight:700}',
    '.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:5px 0;min-width:0}',
    '.row label{font-size:12px;color:#c7ccd3;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.row .ctl{display:flex;align-items:center;gap:6px;flex:none}',
    '.insp input[type=text],.insp input[type=number],.insp select,.insp textarea{background:' + PANEL_BG2 + ';color:' + TXT + ';border:1px solid ' + BORDER + ';border-radius:6px;padding:5px 7px;font-size:12px;width:124px;max-width:58%}',
    '.insp textarea{width:100%;max-width:100%;min-height:74px;resize:none;margin-top:6px;line-height:1.45}',
    '.insp input[type=number]{width:64px}',
    '.insp input[type=range]{width:104px;accent-color:' + TEAL + '}',
    '.insp input[type=color]{width:34px;height:24px;background:' + PANEL_BG2 + ';border:1px solid ' + BORDER + ';border-radius:5px;padding:2px}',
    '.insp .mini{color:' + TXT_DIM + ';font-size:11px;font-weight:600;padding:4px 8px;border-radius:6px;background:' + PANEL_BG2 + '}',
    '.insp .mini:hover{color:' + TXT + '}',
    '.insp .mini.danger:hover{background:#5b1a1a;color:#fff}',
    '.insp-actions{display:flex;gap:6px;padding:7px 11px;border-top:1px solid ' + BORDER + '}',
    // AI generate card
    '.ai-card{margin:2px 0 4px;padding:11px 12px 12px;border:1px solid ' + TEAL + '3d;border-radius:11px;background:linear-gradient(155deg,' + TEAL + '1f,rgba(20,184,186,0) 72%)}',
    '.ai-card h5{margin:0 0 8px;color:' + TEAL_HI + ';font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
    '.ai-box{border:1px solid ' + BORDER + ';border-radius:9px;background:' + PANEL_BG + 'cc;overflow:hidden;transition:border-color .15s}',
    '.ai-box:focus-within{border-color:' + TEAL + '}',
    '.ai-box textarea{width:100%;max-width:100%;background:transparent;border:0;border-radius:0;margin:0;min-height:60px;resize:none;padding:9px 10px;font-size:12px;line-height:1.45;color:' + TXT + '}',
    '.ai-box textarea:focus{outline:none}',
    '.ai-foot{display:flex;align-items:center;gap:6px;padding:6px;border-top:1px solid ' + BORDER + '}',
    '.ai-foot .ai-model{flex:1 1 auto;width:auto;min-width:0;max-width:none;background:' + PANEL_BG2 + ';color:' + TXT + ';border:1px solid ' + BORDER + ';border-radius:7px;padding:0 7px;font-size:11px;height:28px}',
    '.ai-btn{flex:none;font-size:12px;font-weight:700;color:#04211f;background:' + TEAL + ';border-radius:7px;padding:0 13px;height:28px;display:inline-flex;align-items:center;white-space:nowrap}',
    '.ai-btn:hover{background:' + TEAL_HI + '}',
    '.ai-btn.busy{opacity:.7;pointer-events:none}',
    '.ai-note{margin-top:9px;font-size:10px;color:' + TXT_DIM + ';line-height:1.45}',
    // toolbar actions (count / undo / discard / send)
    '.tb-sep{width:1px;align-self:stretch;background:' + BORDER + ';margin:0 2px}',
    '.tb-count{font-size:11px;font-weight:700;color:#04211f;background:' + TEAL + ';border-radius:999px;padding:1px 7px;min-width:8px;text-align:center;white-space:nowrap}',
    '.tb-act{font-size:12px;color:' + TXT_DIM + ';padding:6px 9px;border-radius:7px}',
    '.tb-act:hover{color:#fff;background:' + PANEL_BG2 + '}',
    '.tb-ico{display:flex;align-items:center;padding:6px 7px}',
    '.tb-send{font-size:12px;font-weight:600;background:' + TEAL + ';color:#04211f;padding:6px 12px;border-radius:7px}',
    '.tb-send:hover{background:' + TEAL_HI + '}',
    // hint / legend
    '.hint{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:' + TEAL + ';color:#04211f;font-weight:600;font-size:12px;padding:6px 14px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none}',
    '.legend{position:fixed;left:12px;bottom:14px;z-index:2147483646;width:220px;padding:12px;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:auto;color:' + TXT + ';font-size:12px}',
    '.legend h5{margin:0 0 8px;font-size:12px;color:' + TEAL + '}',
    '.legend div{color:' + TXT_DIM + ';margin:3px 0}',
    '.legend kbd{background:' + PANEL_BG2 + ';border:1px solid ' + BORDER + ';border-radius:4px;padding:0 4px;color:' + TXT + '}',
    '.legend .close{position:absolute;top:8px;right:10px;color:' + TXT_DIM + '}',
    // comment editor
    '.cmt{position:fixed;z-index:2147483647;width:220px;padding:8px;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:auto}',
    '.cmt textarea{width:100%;min-height:56px;background:' + PANEL_BG2 + ';color:' + TXT + ';border:1px solid ' + BORDER + ';border-radius:6px;padding:6px;font-size:12px;resize:vertical}',
    '.cmt .r{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}',
    '.cmt button{font-size:12px;padding:5px 10px;border-radius:6px;color:' + TXT_DIM + '}',
    '.cmt button.ok{background:' + TEAL + ';color:#04211f;font-weight:600}',
    '.editing-text{outline:2px dashed ' + TEAL + ' !important;outline-offset:2px}'
  ].join('\n');

  // Light-DOM animation CSS for the placeholder "building" state (the placeholder
  // is a real element in the app's DOM, not in our shadow root, so its @keyframes
  // must live in the page). Injected on enable, removed on disable. Namespaced
  // `__rf_*` + honours prefers-reduced-motion.
  var GEN_STYLE_ID = '__rayfin_design_gen_style';
  var GEN_STYLE = [
    '@keyframes __rfSweep{0%{transform:translateX(-130%) skewX(-12deg)}100%{transform:translateX(130%) skewX(-12deg)}}',
    '@keyframes __rfScan{0%{top:-8%;opacity:0}12%{opacity:1}88%{opacity:1}100%{top:104%;opacity:0}}',
    '@keyframes __rfGlow{0%,100%{box-shadow:0 0 0 1px ' + TEAL + '77,0 0 24px -6px ' + TEAL + 'aa,inset 0 0 22px -10px ' + TEAL_HI + '99}50%{box-shadow:0 0 0 1px ' + TEAL_HI + ',0 0 40px -4px ' + TEAL + ',inset 0 0 34px -8px ' + TEAL_HI + '}}',
    '@keyframes __rfGrid{to{background-position:24px 24px}}',
    '@keyframes __rfPulse{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.2);opacity:1}}',
    '@keyframes __rfDots{0%{content:""}25%{content:"·"}50%{content:"··"}75%{content:"···"}}',
    '@keyframes __rfReveal{0%{opacity:0;transform:scale(.985)}100%{opacity:1;transform:none}}',
    '.__rf_gen{position:relative !important;overflow:hidden !important;display:flex !important;align-items:center !important;justify-content:center !important;border:1px solid ' + TEAL + '77 !important;background:radial-gradient(120% 90% at 50% -10%,#0b2b2c 0%,#081116 72%) !important;color:' + TEAL_HI + ' !important;animation:__rfGlow 2.4s ease-in-out infinite}',
    '.__rf_gen::before{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 34%,' + TEAL_HI + '14 46%,' + TEAL_HI + '66 50%,' + TEAL_HI + '14 54%,transparent 66%);transform:translateX(-130%) skewX(-12deg);animation:__rfSweep 1.7s ease-in-out infinite;pointer-events:none}',
    '.__rf_grid{position:absolute;inset:0;background-image:linear-gradient(' + TEAL + '1f 1px,transparent 1px),linear-gradient(90deg,' + TEAL + '1f 1px,transparent 1px);background-size:24px 24px;animation:__rfGrid 2.6s linear infinite;opacity:.55;pointer-events:none;-webkit-mask-image:radial-gradient(120% 90% at 50% 0%,#000 30%,transparent 85%);mask-image:radial-gradient(120% 90% at 50% 0%,#000 30%,transparent 85%)}',
    '.__rf_gscan{position:absolute;left:6%;right:6%;height:2px;top:-8%;border-radius:2px;background:linear-gradient(90deg,transparent,' + TEAL_HI + ',transparent);box-shadow:0 0 14px 2px ' + TEAL_HI + 'cc;animation:__rfScan 2s cubic-bezier(.4,0,.2,1) infinite;pointer-events:none}',
    '.__rf_glab{position:relative;z-index:2;display:flex;align-items:center;gap:9px;font:700 13px ui-sans-serif,system-ui;letter-spacing:.04em;color:#7ff2df;text-shadow:0 0 16px ' + TEAL + 'aa}',
    '.__rf_gspark{font-size:15px;color:' + TEAL_HI + ';filter:drop-shadow(0 0 6px ' + TEAL_HI + ');animation:__rfPulse 1.3s ease-in-out infinite}',
    '.__rf_gdots::after{content:"";display:inline-block;width:16px;text-align:left;animation:__rfDots 1.3s steps(1,end) infinite}',
    '.__rf_reveal{animation:__rfReveal .5s cubic-bezier(.2,.7,.2,1)}',
    '@media (prefers-reduced-motion: reduce){.__rf_gen,.__rf_gen::before,.__rf_grid,.__rf_gscan,.__rf_gspark,.__rf_gdots::after,.__rf_reveal{animation:none !important}.__rf_gscan{display:none}}'
  ].join('\n');

  function injectGenStyle() {
    try {
      if (document.getElementById(GEN_STYLE_ID)) return;
      var s = document.createElement('style');
      s.id = GEN_STYLE_ID;
      s.textContent = GEN_STYLE;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }
  function removeGenStyle() {
    var s = document.getElementById(GEN_STYLE_ID);
    if (s) s.remove();
  }

  function icon(name) {
    var p = {
      cursor: '<path d="M4 3l15 8-6 1.5L10 20 4 3z"/>',
      comment: '<path d="M4 5h16v10H9l-4 4v-4H4z"/>',
      frame: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 9v6M9 12h6"/>',
      pen: '<path d="M14 4l6 6L9 21l-6 1 1-6z"/>',
      undo: '<path d="M4 9h11a5 5 0 0 1 0 10h-4"/><path d="M4 9l4-4M4 9l4 4"/>',
      trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>'
    }[name] || '';
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }

  function buildUI() {
    host = document.getElementById(HOST_ID);
    if (host) host.remove();
    host = h('div', { id: HOST_ID });
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', { text: STYLE }));

    elDraw = svg('svg', { class: 'draw' });
    elDraw.addEventListener('pointerdown', onDrawDown);
    elPins = h('div', { class: 'pins' });
    elHover = h('div', { class: 'box hover', style: 'display:none' });
    elLabel = h('div', { class: 'label', style: 'display:none' });
    elSel = h('div', { class: 'box sel', style: 'display:none' });
    elBadges = h('div', { style: 'display:none' });
    elInsert = h('div', { class: 'insert', style: 'display:none' });
    elHandles = h('div', { style: 'display:none' });
    elToolbar = h('div', { class: 'tb' });
    elInspector = h('div', { class: 'insp', style: 'display:none' });
    [elDraw, elPins, elHover, elLabel, elSel, elBadges, elInsert, elHandles, elToolbar, elInspector]
      .forEach(function (n) { root.appendChild(n); });

    makeDraggable(elToolbar, false);
    makeDraggable(elInspector, false);
    buildToolbar();
    if (!localStorageFlag()) showLegend();
  }

  // Let a panel be dragged by any non-interactive part of it (so it can be moved
  // out of the way of content you want to select). `pinSize` fixes width/height
  // during/after the drag (needed for the inspector, whose height comes from
  // top+bottom); the toolbar leaves size auto so it can reflow on tool switch.
  function makeDraggable(el, pinSize) {
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('button,input,select,textarea,a')) return;
      e.preventDefault(); e.stopPropagation();
      var r = el.getBoundingClientRect();
      var offX = e.clientX - r.left, offY = e.clientY - r.top;
      if (pinSize) { el.style.width = r.width + 'px'; el.style.height = r.height + 'px'; }
      el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
      function mv(ev) {
        if (!state.enabled) { up(); return; }
        el.style.left = clamp(ev.clientX - offX, 2, window.innerWidth - 48) + 'px';
        el.style.top = clamp(ev.clientY - offY, 2, window.innerHeight - 28) + 'px';
      }
      function up() { state.panelDragUp = null; window.removeEventListener('pointermove', mv, true); window.removeEventListener('pointerup', up, true); }
      state.panelDragUp = up;
      window.addEventListener('pointermove', mv, true);
      window.addEventListener('pointerup', up, true);
    });
  }

  function localStorageFlag() {
    try { if (window.localStorage.getItem('__rayfinDesignSeen')) return true; window.localStorage.setItem('__rayfinDesignSeen', '1'); } catch (e) {}
    return false;
  }

  // ---- toolbar (single control surface: tools + draw opts + actions) -------
  function buildToolbar() {
    elToolbar.textContent = '';
    var tools = h('div', { class: 'seg' });
    [['select', 'cursor', 'Select', 'V'], ['comment', 'comment', 'Comment', 'C'], ['insert', 'frame', 'Insert', 'I'], ['draw', 'pen', 'Draw', 'D']].forEach(function (t) {
      var b = h('button', { class: state.tool === t[0] ? 'on' : '', html: icon(t[1]), title: t[2] + ' (' + t[3] + ')', 'aria-label': t[2] });
      b.onclick = function (e) { e.stopPropagation(); setTool(t[0]); };
      tools.appendChild(b);
    });
    elToolbar.appendChild(tools);

    if (state.tool === 'draw') {
      var shapes = h('div', { class: 'seg' });
      [['pen', '✎'], ['arrow', '→'], ['rect', '▭'], ['ellipse', '◯']].forEach(function (s) {
        var b = h('button', { class: 'shape' + (state.drawShape === s[0] ? ' on' : ''), text: s[1], title: s[0] });
        b.onclick = function (e) { e.stopPropagation(); state.drawShape = s[0]; buildToolbar(); };
        shapes.appendChild(b);
      });
      elToolbar.appendChild(shapes);
      // A single colour well — click it to open the OS colour wheel/picker.
      var sw = h('div', { class: 'swatches' });
      var picker = h('input', { type: 'color', class: 'sw-picker', title: 'Stroke colour', 'aria-label': 'Stroke colour' });
      picker.value = state.drawColor;
      picker.oninput = function (e) { state.drawColor = e.target.value; };
      picker.onclick = function (e) { e.stopPropagation(); };
      sw.appendChild(picker);
      elToolbar.appendChild(sw);
    }

    elToolbar.appendChild(h('div', { class: 'tb-sep' }));
    elCount = h('span', { class: 'tb-count' });
    elToolbar.appendChild(elCount);
    btnUndo = h('button', { class: 'tb-act tb-ico', html: icon('undo'), title: 'Undo (Ctrl/Cmd+Z)', 'aria-label': 'Undo' });
    btnUndo.onclick = function (e) { e.stopPropagation(); undoLast(); };
    btnDiscard = h('button', { class: 'tb-act tb-ico', html: icon('trash'), title: 'Discard all changes', 'aria-label': 'Discard' });
    btnDiscard.onclick = function (e) { e.stopPropagation(); discardAll(); };
    btnSend = h('button', { class: 'tb-send', text: 'Send to chat' });
    btnSend.onclick = function (e) { e.stopPropagation(); beginHandoff(); };
    elToolbar.appendChild(btnUndo); elToolbar.appendChild(btnDiscard); elToolbar.appendChild(btnSend);
    renderBar();
  }

  function setTool(tool) {
    if (state.editingText) commitText();
    closeCommentEditor();
    if (elInsert) elInsert.style.display = 'none';
    state.insertAt = null;
    state.tool = tool;
    if (tool !== 'select') deselect();
    // The draw layer only intercepts pointer events while the Draw tool is active.
    elDraw.style.pointerEvents = tool === 'draw' ? 'auto' : 'none';
    buildToolbar();
    reposition();
    var msg = tool === 'comment' ? 'Click an element to leave a comment'
      : tool === 'draw' ? 'Drag to sketch over the preview'
        : tool === 'insert' ? 'Click between elements to drop a placeholder' : '';
    showHint(msg);
    if (msg) setTimeout(function () { if (state.tool === tool) hideHint(); }, 2400);
  }

  // ---- hint / legend -------------------------------------------------------
  var hintEl = null;
  function showHint(text) { hideHint(); if (!text) return; hintEl = h('div', { class: 'hint', text: text }); root.appendChild(hintEl); }
  function hideHint() { if (hintEl) { hintEl.remove(); hintEl = null; } }

  function showLegend() {
    if (elLegend) elLegend.remove();
    elLegend = h('div', { class: 'legend' });
    var close = h('button', { class: 'close', text: '✕' });
    close.onclick = function (e) { e.stopPropagation(); elLegend.remove(); elLegend = null; };
    elLegend.appendChild(close);
    elLegend.appendChild(h('h5', { text: 'Design mode' }));
    [
      'Select (V) — click to pick, drag to move, handles to resize, arrows to nudge',
      'Insert (I) — drop a placeholder where a new component goes',
      'Comment (C) — pin a note · Draw (D) — sketch over it',
      'Undo Ctrl/Cmd+Z · Remove Del · Deselect Esc · drag the toolbar to move it'
    ].forEach(function (t) { elLegend.appendChild(h('div', { text: t })); });
    root.appendChild(elLegend);
  }

  // ---- toolbar action state (count + enabled) ------------------------------
  function renderBar() {
    var count = state.changes.length;
    if (elCount) {
      elCount.textContent = String(count);
      elCount.title = count + (count === 1 ? ' change' : ' changes');
      elCount.style.display = count > 0 ? '' : 'none';
    }
    [btnUndo, btnDiscard, btnSend].forEach(function (b) {
      if (!b) return;
      var off = count === 0;
      b.style.opacity = off ? '.4' : '';
      b.style.pointerEvents = off ? 'none' : 'auto';
    });
  }

  // ---- overlay positioning -------------------------------------------------
  function place(el, target) {
    if (!target || !target.isConnected) { el.style.display = 'none'; return; }
    var r = target.getBoundingClientRect();
    el.style.display = 'block';
    el.style.left = r.left + 'px'; el.style.top = r.top + 'px';
    el.style.width = r.width + 'px'; el.style.height = r.height + 'px';
  }

  function reposition() {
    // hover (Select only, no active selection drag)
    if (state.tool === 'select' && state.hoverEl && state.hoverEl !== state.selected && !state.move && !state.resizing) {
      place(elHover, state.hoverEl);
      var hr = state.hoverEl.getBoundingClientRect();
      elLabel.style.display = 'block';
      elLabel.textContent = state.hoverEl.tagName.toLowerCase() + ' · ' + Math.round(hr.width) + '×' + Math.round(hr.height);
      elLabel.style.left = hr.left + 'px';
      elLabel.style.top = Math.max(2, hr.top - 20) + 'px';
    } else { elHover.style.display = 'none'; elLabel.style.display = 'none'; }
    // selection
    if (state.selected && state.selected.isConnected) {
      place(elSel, state.selected);
      positionHandles(); positionBadges();
    } else { elSel.style.display = 'none'; elHandles.style.display = 'none'; elBadges.style.display = 'none'; }
    // comment pins track their anchor elements
    positionPins();
  }

  // ---- selection -----------------------------------------------------------
  function select(el) {
    if (!el) return;
    if (state.editingText) commitText();
    state.selected = el;
    state.selInline = snapshotInline(el);
    showHandles();
    renderInspector();
    reposition();
  }
  function deselect() {
    state.selected = null; state.selInline = null;
    closeInspector(); hideHandles();
    reposition();
  }

  function snapshotInline(el) {
    var s = el.style, keys = ['color', 'backgroundColor', 'width', 'height', 'margin', 'padding', 'fontSize', 'fontWeight', 'textAlign', 'borderRadius', 'border', 'opacity', 'display', 'transform'];
    var snap = {};
    for (var i = 0; i < keys.length; i++) snap[keys[i]] = s[keys[i]];
    return snap;
  }

  // ---- inspector -----------------------------------------------------------
  function closeInspector() { elInspector.style.display = 'none'; elInspector.textContent = ''; }

  function renderInspector() {
    var el = state.selected;
    if (!el || state.tool !== 'select') { closeInspector(); return; }
    elInspector.textContent = '';
    elInspector.style.display = 'flex';
    var cs = getComputedStyle(el);

    // header: breadcrumb + size
    var head = h('div', { class: 'insp-head' });
    var crumb = h('div', { class: 'crumb' });
    var chain = [], n = el, guard = 0;
    while (n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && guard < 4) { chain.unshift(n); n = n.parentElement; guard++; }
    chain.forEach(function (node, idx) {
      var isCur = node === el;
      var b = h('button', { class: isCur ? 'cur' : '', text: node.tagName.toLowerCase() });
      b.onclick = function (e) { e.stopPropagation(); select(node); };
      crumb.appendChild(b);
      if (idx < chain.length - 1) crumb.appendChild(h('span', { text: '›' }));
    });
    // child affordance
    if (el.children && el.children.length) {
      var kid = h('button', { text: '› ' + el.children[0].tagName.toLowerCase() });
      kid.onclick = function (e) { e.stopPropagation(); select(el.children[0]); };
      crumb.appendChild(kid);
    }
    head.appendChild(crumb);
    var r = el.getBoundingClientRect();
    head.appendChild(h('div', { class: 'insp-sz', text: Math.round(r.width) + ' × ' + Math.round(r.height) + ' px' + (componentHint(el) ? ' · <' + componentHint(el) + '>' : '') }));
    elInspector.appendChild(head);

    var body = h('div', { class: 'insp-body' });
    elInspector.appendChild(body);

    if (isPlaceholder(el)) body.appendChild(aiGroup(el));
    if (chartRoot(el)) body.appendChild(chartGroup(chartRoot(el)));

    // Layout & spacing
    body.appendChild(group('Layout', [
      numRow('Width', 'width', Math.round(r.width), 'px', el),
      numRow('Height', 'height', Math.round(r.height), 'px', el),
      numRow('Margin', 'margin', px(cs.marginTop), 'px', el),
      numRow('Padding', 'padding', px(cs.paddingTop), 'px', el)
    ]));
    // Typography
    body.appendChild(group('Text', [
      numRow('Font size', 'fontSize', px(cs.fontSize), 'px', el),
      selRow('Weight', 'fontWeight', WEIGHTS, String(cs.fontWeight), el),
      selRow('Align', 'textAlign', ALIGNS, cs.textAlign, el),
      colorRow('Color', 'color', cs.color, el),
      textContentRow(el)
    ]));
    // Appearance
    body.appendChild(group('Appearance', [
      colorRow('Background', 'backgroundColor', cs.backgroundColor, el),
      numRow('Radius', 'borderRadius', px(cs.borderTopLeftRadius), 'px', el),
      textRow('Border', 'border', cs.borderWidth !== '0px' ? (cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor) : '', el),
      rangeRow('Opacity', 'opacity', parseFloat(cs.opacity), el)
    ]));

    var actions = h('div', { class: 'insp-actions' });
    var reset = h('button', { class: 'mini', text: 'Reset element' }); reset.onclick = function (e) { e.stopPropagation(); resetSelected(); };
    var rm = h('button', { class: 'mini danger', text: 'Remove' }); rm.onclick = function (e) { e.stopPropagation(); removeSelected(); };
    actions.appendChild(reset); actions.appendChild(rm);
    elInspector.appendChild(actions);
  }

  function group(title, rows) {
    var g = h('div', { class: 'grp' }, [h('h5', { text: title })]);
    rows.forEach(function (r) { if (r) g.appendChild(r); });
    return g;
  }
  function px(v) { var n = parseFloat(v); return isNaN(n) ? 0 : Math.round(n); }

  // Subtle "Generate with AI" card shown at the top of a placeholder's inspector:
  // describe the component + pick a model → a model draws HTML/CSS into the box.
  function aiGroup(ph) {
    var card = h('div', { class: 'ai-card' });
    card.appendChild(h('h5', { text: 'Generate with AI' }));
    var generating = ph.getAttribute('data-rayfin-gen') === '1';
    var entry = findInsertEntry(ph);
    var hasGen = !!(entry && entry.generatedHtml);

    var box = h('div', { class: 'ai-box' });
    var ta = h('textarea', { placeholder: 'Describe this component — e.g. “a KPI card showing total revenue with a small up-trend”', text: phDesc(ph) });
    ta.oninput = function () { ph.setAttribute('data-rayfin-desc', ta.value); };
    box.appendChild(ta);

    var foot = h('div', { class: 'ai-foot' });
    var sel = h('select', { class: 'ai-model', title: 'Model' });
    var models = (state.models && state.models.length) ? state.models : [{ id: '', name: 'Fast model', fast: true }];
    models.forEach(function (m) {
      var o = h('option', { value: m.id, text: m.name });
      if (m.id === state.aiModel) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    sel.onchange = function () { state.aiModel = sel.value; };
    if (generating) { sel.disabled = true; }
    foot.appendChild(sel);
    var btn = h('button', { class: 'ai-btn' + (generating ? ' busy' : ''), text: generating ? 'Generating…' : (hasGen ? 'Regenerate' : 'Generate') });
    btn.onclick = function (e) { e.stopPropagation(); requestAiGenerate(ph, ta.value); };
    foot.appendChild(btn);
    box.appendChild(foot);
    card.appendChild(box);

    card.appendChild(h('div', { class: 'ai-note', text: hasGen ? 'Preview generated — sent to chat as the starting point.' : 'HTML/CSS only, drawn into the box and sent to chat as a starting point.' }));
    return card;
  }

  // Apply an inline style change + record it (revert restores the pre-select
  // inline value snapshot for that property).
  function applyStyle(el, jsProp, cssLabel, value, display) {
    el.style[jsProp] = value;
    // Placeholders are captured wholesale by their single 'insert' entry (live
    // size/label/position read at hand-off), so don't record per-property edits.
    if (isPlaceholder(el)) return;
    var before = state.selInline[jsProp];
    record({
      kind: 'style', property: cssLabel, selector: cssPath(el), label: describe(el), el: el,
      from: undefined, to: display != null ? display : value,
      revert: function () { el.style[jsProp] = before; }
    });
  }

  function numRow(label, jsProp, val, unit, el) {
    var inp = h('input', { type: 'number', value: String(val) });
    inp.oninput = function () { applyStyle(el, jsProp, cssName(jsProp), inp.value === '' ? '' : (inp.value + unit), inp.value + unit); };
    return h('div', { class: 'row' }, [h('label', { text: label }), h('div', { class: 'ctl' }, [inp, h('span', { class: 'insp-sz', text: unit })])]);
  }
  function selRow(label, jsProp, opts, cur, el) {
    var sel = h('select');
    opts.forEach(function (o) { var op = h('option', { value: o, text: o }); if (String(o) === String(cur)) op.setAttribute('selected', 'selected'); sel.appendChild(op); });
    sel.onchange = function () { applyStyle(el, jsProp, cssName(jsProp), sel.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), sel]);
  }
  function colorRow(label, jsProp, cur, el) {
    var inp = h('input', { type: 'color', value: rgbToHex(cur) });
    inp.oninput = function () { applyStyle(el, jsProp, cssName(jsProp), inp.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), inp]);
  }
  function rangeRow(label, jsProp, cur, el) {
    var inp = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(isNaN(cur) ? 1 : cur) });
    inp.oninput = function () { applyStyle(el, jsProp, cssName(jsProp), inp.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), inp]);
  }
  function textRow(label, jsProp, cur, el) {
    var inp = h('input', { type: 'text', value: cur || '' });
    inp.onchange = function () { applyStyle(el, jsProp, cssName(jsProp), inp.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), inp]);
  }
  function textContentRow(el) {
    if (isPlaceholder(el)) return null; // placeholders use the AI describe box instead
    // The element's "own" text = the concatenation of its direct text-node
    // children. Editing only those lets a button/heading/link that also holds a
    // child element (e.g. an icon <svg> or a badge) still have its label changed
    // without clobbering that child.
    function directText() {
      var s = '';
      for (var i = 0; i < el.childNodes.length; i++) { if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue; }
      return s;
    }
    var trimmed = directText().replace(/\s+/g, ' ').trim();
    if (!trimmed.length || trimmed.length >= 200) return null;
    var ta = h('textarea', { text: trimmed });
    ta.onchange = function () {
      var beforeHtml = el.innerHTML;
      var fromTxt = directText().replace(/\s+/g, ' ').trim();
      var nodes = [];
      for (var i = 0; i < el.childNodes.length; i++) { if (el.childNodes[i].nodeType === 3) nodes.push(el.childNodes[i]); }
      var nonWs = nodes.filter(function (n) { return n.nodeValue.trim().length; });
      if (nonWs.length) {
        // Reuse the first meaningful text node (keeps the label's position
        // relative to any icon) and preserve its surrounding whitespace/gap.
        var first = nonWs[0];
        var lead = first.nodeValue.match(/^\s*/)[0], trail = first.nodeValue.match(/\s*$/)[0];
        first.nodeValue = lead + ta.value + trail;
        for (var j = 1; j < nonWs.length; j++) nonWs[j].nodeValue = '';
      } else if (nodes.length) {
        nodes[0].nodeValue = ta.value;
      } else {
        el.appendChild(document.createTextNode(ta.value));
      }
      record({
        kind: 'text', property: 'text', selector: cssPath(el), label: describe(el), el: el,
        from: fromTxt, to: ta.value.trim(),
        revert: function () { el.innerHTML = beforeHtml; }
      });
      reposition();
    };
    return h('div', { class: 'row', style: 'display:block' }, [h('label', { text: 'Content' }), ta]);
  }
  function cssName(jsProp) { return jsProp.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }); }

  // ---- Graphein spec editor (inspector section) ----------------------------
  function chartGroup(chart) {
    var g = h('div', { class: 'grp' }, [h('h5', { text: 'Chart spec' })]);
    var spec = readSpec(chart);
    if (!spec) { g.appendChild(h('div', { class: 'insp-sz', text: 'Spec unavailable' })); return g; }
    var before = JSON.parse(JSON.stringify(spec));
    var beforeAttr = chart.getAttribute('data-graphein-spec');
    function apply(mut) {
      mut(spec); writeSpec(chart, spec);
      record({
        kind: 'chart', property: 'spec', selector: cssPath(chart), label: describe(chart), el: chart,
        before: stripData(before), after: stripData(spec),
        revert: function () { if (beforeAttr != null) chart.setAttribute('data-graphein-spec', beforeAttr); }
      });
    }
    g.appendChild(gsel('Type', CHART_TYPES, spec.type, function (v) { apply(function (s) { s.type = v; }); }));
    var titleVal = (spec.title && typeof spec.title === 'object') ? (spec.title.text || '') : (spec.title || '');
    var ti = h('input', { type: 'text', value: titleVal });
    ti.oninput = function () { apply(function (s) { if (s.title && typeof s.title === 'object') s.title.text = ti.value; else s.title = ti.value; }); };
    g.appendChild(h('div', { class: 'row' }, [h('label', { text: 'Title' }), ti]));
    g.appendChild(gsel('Palette', PALETTES, typeof spec.palette === 'string' ? spec.palette : '', function (v) { apply(function (s) { s.palette = v; }); }));
    g.appendChild(gsel('Orient', ['vertical', 'horizontal'], spec.orientation || 'vertical', function (v) { apply(function (s) { s.orientation = v; }); }));
    g.appendChild(gsel('Sort', ['none', 'ascending', 'descending'], spec.sort || 'none', function (v) { apply(function (s) { s.sort = v; }); }));
    var curFmt = (spec.encoding && spec.encoding.y && spec.encoding.y.format) || '';
    g.appendChild(gselPairs('Value fmt', FORMATS, curFmt, function (v) { apply(function (s) { s.encoding = s.encoding || {}; s.encoding.y = s.encoding.y || {}; if (v) s.encoding.y.format = v; else delete s.encoding.y.format; }); }));
    return g;
  }
  function gsel(label, opts, cur, on) {
    var sel = h('select');
    opts.forEach(function (o) { var op = h('option', { value: o, text: o }); if (String(o) === String(cur)) op.setAttribute('selected', 'selected'); sel.appendChild(op); });
    sel.onchange = function () { on(sel.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), sel]);
  }
  function gselPairs(label, pairs, cur, on) {
    var sel = h('select');
    pairs.forEach(function (p) { var op = h('option', { value: p[0], text: p[1] }); if (String(p[0]) === String(cur)) op.setAttribute('selected', 'selected'); sel.appendChild(op); });
    sel.onchange = function () { on(sel.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), sel]);
  }

  // ---- resize handles ------------------------------------------------------
  // Flow elements are anchored at their top-left, so we only resize from the
  // right / bottom / bottom-right corner (like a textarea) — a west/north handle
  // would just grow the opposite edge, which feels backwards. [dir, x%, y%, cursor]
  var HANDLE_DIRS = [['e', 1, 0.5, 'ew-resize'], ['s', 0.5, 1, 'ns-resize'], ['se', 1, 1, 'nwse-resize']];
  function hideHandles() { elHandles.style.display = 'none'; elHandles.textContent = ''; }
  function showHandles() {
    if (!state.selected) return;
    elHandles.textContent = ''; elHandles.style.display = 'block';
    HANDLE_DIRS.forEach(function (d) {
      var hd = h('div', { class: 'hnd' });
      hd.style.cursor = d[3];
      hd.onpointerdown = function (e) { startResize(e, d); };
      elHandles.appendChild(hd);
    });
    positionHandles();
  }
  function positionHandles() {
    if (elHandles.style.display !== 'block' || !state.selected) return;
    var r = state.selected.getBoundingClientRect(), kids = elHandles.children;
    for (var i = 0; i < kids.length; i++) { var d = HANDLE_DIRS[i]; kids[i].style.left = (r.left + r.width * d[1] - 6) + 'px'; kids[i].style.top = (r.top + r.height * d[2] - 6) + 'px'; }
  }
  function positionBadges() {
    if (!state.selected) { elBadges.style.display = 'none'; return; }
    var r = state.selected.getBoundingClientRect();
    elBadges.textContent = ''; elBadges.style.display = 'block';
    var b = h('div', { class: 'badge', text: Math.round(r.width) + ' × ' + Math.round(r.height) });
    b.style.left = (r.left + r.width / 2 - 24) + 'px'; b.style.top = (r.bottom + 8) + 'px';
    elBadges.appendChild(b);
  }

  function startResize(e, dir) {
    e.preventDefault(); e.stopPropagation();
    var el = state.selected; if (!el) return;
    var r = el.getBoundingClientRect();
    state.resizing = { el: el, dir: dir[0], startX: e.clientX, startY: e.clientY, w0: r.width, h0: r.height, from: Math.round(r.width) + '×' + Math.round(r.height), beforeW: el.style.width, beforeH: el.style.height };
    window.addEventListener('pointermove', onResizeMove, true);
    window.addEventListener('pointerup', onResizeUp, true);
  }
  function onResizeMove(e) {
    var g = state.resizing; if (!g || !state.enabled) return;
    if (e.buttons === 0) { onResizeUp(); return; }
    var dx = e.clientX - g.startX, dy = e.clientY - g.startY, w = g.w0, ht = g.h0;
    if (g.dir.indexOf('e') >= 0) w = g.w0 + dx;
    if (g.dir.indexOf('w') >= 0) w = g.w0 - dx;
    if (g.dir.indexOf('s') >= 0) ht = g.h0 + dy;
    if (g.dir.indexOf('n') >= 0) ht = g.h0 - dy;
    g.el.style.width = Math.max(8, Math.round(w)) + 'px';
    g.el.style.height = Math.max(8, Math.round(ht)) + 'px';
    reposition();
  }
  function onResizeUp() {
    var g = state.resizing; if (!g) return;
    window.removeEventListener('pointermove', onResizeMove, true);
    window.removeEventListener('pointerup', onResizeUp, true);
    var r = g.el.getBoundingClientRect();
    if (isPlaceholder(g.el)) { state.resizing = null; renderInspector(); return; } // size captured by the insert entry
    record({ kind: 'resize', property: 'size', selector: cssPath(g.el), label: describe(g.el), el: g.el, from: g.from, to: Math.round(r.width) + '×' + Math.round(r.height), revert: function () { g.el.style.width = g.beforeW; g.el.style.height = g.beforeH; } });
    state.resizing = null; renderInspector();
  }

  // ---- move (drag threshold) -----------------------------------------------
  function beginPendingMove(e, el, downTarget) {
    state.move = { el: el, downTarget: downTarget, startX: e.clientX, startY: e.clientY, active: false, origParent: el.parentNode, origNext: el.nextElementSibling, origOpacity: el.style.opacity };
    window.addEventListener('pointermove', onMoveMove, true);
    window.addEventListener('pointerup', onMoveUp, true);
  }
  function onMoveMove(e) {
    var g = state.move; if (!g || !state.enabled) return;
    if (e.buttons === 0) { onMoveUp(); return; }
    if (!g.active) {
      if (Math.abs(e.clientX - g.startX) < 4 && Math.abs(e.clientY - g.startY) < 4) return;
      g.active = true; g.el.style.opacity = '0.5'; showHint('Drag to reposition, release to drop');
    }
    g.el.style.pointerEvents = 'none';
    var under = document.elementFromPoint(e.clientX, e.clientY);
    g.el.style.pointerEvents = '';
    if (!under || isOurs(under) || under === g.el || g.el.contains(under)) { elInsert.style.display = 'none'; g.drop = null; return; }
    var r = under.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
    g.drop = { ref: under, before: before };
    elInsert.style.display = 'block'; elInsert.style.height = '3px';
    elInsert.style.left = r.left + 'px'; elInsert.style.width = r.width + 'px';
    elInsert.style.top = (before ? r.top - 1 : r.bottom - 2) + 'px';
  }
  function onMoveUp() {
    var g = state.move; if (!g) return;
    window.removeEventListener('pointermove', onMoveMove, true);
    window.removeEventListener('pointerup', onMoveUp, true);
    g.el.style.opacity = g.origOpacity || ''; elInsert.style.display = 'none'; showHint('');
    state.move = null;
    if (g.active && g.drop && g.drop.ref && g.drop.ref.parentNode) {
      var ref = g.drop.ref, parent = ref.parentNode, movedEl = g.el, origParent = g.origParent, origNext = g.origNext;
      if (g.drop.before) parent.insertBefore(movedEl, ref); else parent.insertBefore(movedEl, ref.nextSibling);
      if (isPlaceholder(movedEl)) { reposition(); return; } // insert entry captures its live position
      record({
        kind: 'move', property: 'position', selector: cssPath(movedEl), label: describe(movedEl), el: movedEl,
        from: 'original position', to: (g.drop.before ? 'before ' : 'after ') + describe(ref),
        target: { parentSelector: cssPath(parent), refSelector: cssPath(ref), position: g.drop.before ? 'before' : 'after' },
        revert: function () { if (origNext && origNext.parentNode === origParent) origParent.insertBefore(movedEl, origNext); else if (origParent) origParent.appendChild(movedEl); }
      });
      reposition();
    } else if (!g.active && g.downTarget && g.downTarget !== state.selected && !isOurs(g.downTarget) && g.downTarget.isConnected) {
      // A click (no drag) on a child of the selection drills in and selects it.
      select(chartRoot(g.downTarget) || g.downTarget);
    }
  }

  // ---- keyboard nudge ------------------------------------------------------
  function nudge(dx, dy) {
    var el = state.selected; if (!el) return;
    var before = state.selInline ? state.selInline.transform : el.style.transform;
    var m = /translate\((-?\d+)px,\s*(-?\d+)px\)/.exec(el.style.transform || '');
    var cx = m ? parseInt(m[1], 10) : 0, cy = m ? parseInt(m[2], 10) : 0;
    cx += dx; cy += dy;
    el.style.transform = (el.style.transform || '').replace(/translate\([^)]*\)/, '').trim() + ' translate(' + cx + 'px, ' + cy + 'px)';
    if (!isPlaceholder(el)) {
      record({
        kind: 'move', property: 'nudge', selector: cssPath(el), label: describe(el), el: el,
        from: 'original position', to: 'nudged (' + cx + ', ' + cy + ')px',
        revert: function () { el.style.transform = before; }
      });
    }
    reposition();
  }

  // ---- remove / reset / discard --------------------------------------------
  function removeSelected() {
    var el = state.selected; if (!el) return;
    // Removing a placeholder deletes it entirely (undoes the insert).
    if (isPlaceholder(el)) { var ins = findInsertEntry(el); if (ins) removeEntry(ins); deselect(); return; }
    var beforeDisplay = el.style.display;
    el.style.display = 'none';
    record({ kind: 'remove', property: 'display', selector: cssPath(el), label: describe(el), el: el, from: 'visible', to: 'removed', revert: function () { el.style.display = beforeDisplay; } });
    deselect();
  }
  function resetSelected() {
    var el = state.selected; if (!el) return;
    for (var i = state.changes.length - 1; i >= 0; i--) if (state.changes[i].el === el) revertEntry(state.changes[i]);
    state.changes = state.changes.filter(function (c) { return c.el !== el; });
    bump(); renderInspector(); reposition(); renderBar();
  }
  function discardAll() {
    if (state.editingText) commitText();
    for (var i = state.changes.length - 1; i >= 0; i--) revertEntry(state.changes[i]);
    state.changes = [];
    deselect(); clearPins(); clearDrawings();
    bump(); reposition(); renderBar();
  }

  // ---- text edit (double-click quick path) ---------------------------------
  function startText(el) {
    if (!el) return;
    state.editingText = { el: el, from: el.textContent || '', html: el.innerHTML };
    el.setAttribute('contenteditable', 'true'); el.classList.add('editing-text'); el.focus();
    showHint('Editing text — click away or Esc to finish');
  }
  function commitText() {
    var t = state.editingText; if (!t) return;
    state.editingText = null;
    var el = t.el; el.removeAttribute('contenteditable'); el.classList.remove('editing-text');
    // Placeholder label edits are captured by the insert entry (live text at
    // hand-off), so don't record a separate text change for them.
    if (!isPlaceholder(el) && (el.textContent || '') !== t.from) {
      var beforeHtml = t.html;
      record({ kind: 'text', property: 'text', selector: cssPath(el), label: describe(el), el: el, from: t.from.trim(), to: (el.textContent || '').trim(), revert: function () { el.innerHTML = beforeHtml; } });
    }
    showHint('');
  }

  // ---- comments ------------------------------------------------------------
  function clearPins() { if (elPins) elPins.textContent = ''; }
  function positionPins() {
    if (!elPins) return;
    var kids = elPins.children;
    for (var i = 0; i < kids.length; i++) {
      var pin = kids[i], entry = pin.__entry;
      if (!entry || !entry.el || !entry.el.isConnected) { pin.style.display = 'none'; continue; }
      var r = entry.el.getBoundingClientRect();
      pin.style.display = 'flex';
      pin.style.left = (r.left + 8) + 'px'; pin.style.top = (r.top + 8) + 'px';
      pin.textContent = String(state.changes.indexOf(entry) + 1);
    }
  }
  function addComment(el, clientX, clientY) {
    var pin = h('div', { class: 'pin', text: '•' });
    elPins.appendChild(pin);
    var entry = {
      kind: 'comment', property: 'note', selector: cssPath(el), label: describe(el), el: el,
      note: '', to: '(note)', pinEl: pin,
      revert: function () { if (pin.parentNode) pin.remove(); }
    };
    pin.__entry = entry;
    pin.onclick = function (e) { e.stopPropagation(); openCommentEditor(entry); };
    record(entry);
    reposition();
    openCommentEditor(entry, clientX, clientY);
  }
  function openCommentEditor(entry, clientX, clientY) {
    closeCommentEditor();
    elCommentEditor = h('div', { class: 'cmt' });
    var ta = h('textarea', { placeholder: 'What should change here?', text: entry.note || '' });
    elCommentEditor.appendChild(ta);
    var rr = h('div', { class: 'r' });
    var del = h('button', { text: 'Delete' });
    del.onclick = function (e) { e.stopPropagation(); removeEntry(entry); closeCommentEditor(); };
    var ok = h('button', { class: 'ok', text: 'Save' });
    ok.onclick = function (e) { e.stopPropagation(); entry.note = ta.value.trim(); entry.to = entry.note ? '“' + entry.note + '”' : '(note)'; bump(); closeCommentEditor(); reposition(); };
    rr.appendChild(del); rr.appendChild(ok);
    elCommentEditor.appendChild(rr);
    var r = entry.el.getBoundingClientRect();
    elCommentEditor.style.left = clamp((clientX != null ? clientX : r.left) + 12, 8, window.innerWidth - 232) + 'px';
    elCommentEditor.style.top = clamp((clientY != null ? clientY : r.top) + 12, 8, window.innerHeight - 130) + 'px';
    root.appendChild(elCommentEditor);
    setTimeout(function () { ta.focus(); }, 0);
  }
  function closeCommentEditor() { if (elCommentEditor) { elCommentEditor.remove(); elCommentEditor = null; } }
  function removeEntry(entry) {
    var i = state.changes.indexOf(entry);
    if (i >= 0) { revertEntry(entry); state.changes.splice(i, 1); bump(); reposition(); renderBar(); }
  }

  // ---- draw ----------------------------------------------------------------
  function clearDrawings() { if (elDraw) while (elDraw.firstChild) elDraw.removeChild(elDraw.firstChild); }
  function onDrawDown(e) {
    if (state.tool !== 'draw') return;
    e.preventDefault(); e.stopPropagation();
    var color = state.drawColor, shape = state.drawShape, x0 = e.clientX, y0 = e.clientY, node;
    if (shape === 'pen') {
      node = svg('path', { fill: 'none', stroke: color, 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M' + x0 + ',' + y0 });
    } else if (shape === 'arrow') {
      node = svg('line', { stroke: color, 'stroke-width': '3', 'stroke-linecap': 'round', 'marker-end': 'url(#__rf_arrow)', x1: x0, y1: y0, x2: x0, y2: y0 });
      ensureArrowMarker(color);
    } else {
      node = svg(shape === 'rect' ? 'rect' : 'ellipse', { fill: 'none', stroke: color, 'stroke-width': '3' });
    }
    elDraw.appendChild(node);
    state.drawing = { shape: shape, node: node, x0: x0, y0: y0, pts: [[x0, y0]], color: color };
    window.addEventListener('pointermove', onDrawMove, true);
    window.addEventListener('pointerup', onDrawUp, true);
  }
  function onDrawMove(e) {
    var g = state.drawing; if (!g) return;
    if (e.buttons === 0) { onDrawUp(); return; }
    var x = e.clientX, y = e.clientY;
    if (g.shape === 'pen') { g.pts.push([x, y]); g.node.setAttribute('d', g.node.getAttribute('d') + ' L' + x + ',' + y); }
    else if (g.shape === 'arrow') { g.node.setAttribute('x2', x); g.node.setAttribute('y2', y); }
    else if (g.shape === 'rect') { g.node.setAttribute('x', Math.min(g.x0, x)); g.node.setAttribute('y', Math.min(g.y0, y)); g.node.setAttribute('width', Math.abs(x - g.x0)); g.node.setAttribute('height', Math.abs(y - g.y0)); }
    else { g.node.setAttribute('cx', (g.x0 + x) / 2); g.node.setAttribute('cy', (g.y0 + y) / 2); g.node.setAttribute('rx', Math.abs(x - g.x0) / 2); g.node.setAttribute('ry', Math.abs(y - g.y0) / 2); }
  }
  function onDrawUp() {
    var g = state.drawing; if (!g) return;
    window.removeEventListener('pointermove', onDrawMove, true);
    window.removeEventListener('pointerup', onDrawUp, true);
    state.drawing = null;
    var node = g.node, r = node.getBoundingClientRect();
    // Drop trivial taps.
    if (g.shape === 'pen' && g.pts.length < 2) { node.remove(); return; }
    var under = null;
    try { node.style.pointerEvents = 'none'; under = document.elementFromPoint(g.x0, g.y0); } catch (e) {}
    record({
      kind: 'annotation', property: g.shape, selector: '', label: g.shape + ' sketch', el: null, node: node,
      to: g.shape + ' sketch', region: under && !isOurs(under) ? describe(under) : ('near ' + Math.round(g.x0) + ',' + Math.round(g.y0)),
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      revert: function () { if (node.parentNode) node.remove(); }
    });
  }
  function ensureArrowMarker(color) {
    if (elDraw.querySelector('#__rf_arrow')) return;
    var defs = svg('defs');
    var m = svg('marker', { id: '__rf_arrow', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
    m.appendChild(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
    defs.appendChild(m); elDraw.appendChild(defs);
  }

  // ---- insert placeholder --------------------------------------------------
  var phSeq = 0;
  function isPlaceholder(el) { return !!(el && el.getAttribute && el.getAttribute('data-rayfin-placeholder') === '1'); }
  function findInsertEntry(el) { for (var i = 0; i < state.changes.length; i++) if (state.changes[i].kind === 'insert' && state.changes[i].el === el) return state.changes[i]; return null; }
  function placeholderById(id) { try { return document.querySelector('[data-rayfin-ph-id="' + id + '"]'); } catch (e) { return null; } }
  function phDesc(ph) { return (ph && ph.getAttribute('data-rayfin-desc')) || ''; }
  var PH_BASE = 'margin:8px 0;border:2px dashed ' + TEAL + ';border-radius:12px;background:' + TEAL + '14;box-sizing:border-box;';
  var PH_EMPTY = PH_BASE + 'min-height:96px;display:flex;align-items:center;justify-content:center;text-align:center;color:' + TEAL + ';font:600 13px ui-sans-serif,system-ui;padding:14px;';

  // Live description of where a placeholder currently sits (robust to later moves).
  function insertLoc(el) {
    if (!el || !el.parentNode) return 'here';
    var prev = el.previousElementSibling, next = el.nextElementSibling, parent = el.parentNode;
    while (prev && (isPlaceholder(prev) || isOurs(prev))) prev = prev.previousElementSibling;
    while (next && (isPlaceholder(next) || isOurs(next))) next = next.nextElementSibling;
    if (prev) return 'after ' + describe(prev) + ' (inside ' + cssPath(parent) + ')';
    if (next) return 'before ' + describe(next) + ' (inside ' + cssPath(parent) + ')';
    return 'inside ' + cssPath(parent);
  }

  // Show the insertion indicator between elements while the Insert tool hovers.
  function showInsertLine(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || isOurs(el) || !el.parentNode) { elInsert.style.display = 'none'; state.insertAt = null; return; }
    var r = el.getBoundingClientRect(), before = y < r.top + r.height / 2;
    state.insertAt = { ref: el, before: before };
    elInsert.style.display = 'block'; elInsert.style.height = '3px';
    elInsert.style.left = r.left + 'px'; elInsert.style.width = r.width + 'px';
    elInsert.style.top = (before ? r.top - 1 : r.bottom - 2) + 'px';
  }

  function insertPlaceholder(target, y) {
    var at = state.insertAt;
    var ref = (at && at.ref && at.ref.isConnected) ? at.ref : target;
    if (!ref || isOurs(ref) || !ref.parentNode) return;
    var before = at ? at.before : true, parent = ref.parentNode;
    var ph = document.createElement('div');
    ph.setAttribute('data-rayfin-placeholder', '1');
    ph.setAttribute('data-rayfin-ph-id', 'ph' + (++phSeq));
    ph.setAttribute('style', PH_EMPTY);
    ph.textContent = 'New component';
    if (before) parent.insertBefore(ph, ref); else parent.insertBefore(ph, ref.nextSibling);
    elInsert.style.display = 'none'; state.insertAt = null;
    record({
      kind: 'insert', property: 'element', selector: cssPath(ph), label: 'new placeholder', el: ph,
      to: 'insert new component',
      revert: function () { if (ph.parentNode) ph.remove(); }
    });
    setTool('select');
    select(ph);
    showHint('Describe it with AI, or resize + sketch inside it');
    setTimeout(function () { if (state.selected === ph) hideHint(); }, 2800);
  }

  // Preserve any user-set inline width/height when we rewrite a placeholder's
  // full style attribute (resize handles set them and we don't want to lose them).
  function phSize(ph) { return (ph.style.width ? 'width:' + ph.style.width + ';' : '') + (ph.style.height ? 'height:' + ph.style.height + ';' : ''); }

  // Kick off an AI generation for a placeholder from the inspector (the host
  // poll drains the request, generates the HTML, and calls applyGenerated).
  function requestAiGenerate(ph, description) {
    var desc = (description || '').trim();
    if (!ph || !desc) { showHint('Describe the component first'); return; }
    ph.setAttribute('data-rayfin-desc', desc);
    var id = ph.getAttribute('data-rayfin-ph-id');
    var r = ph.getBoundingClientRect();
    var sz = phSize(ph);
    ph.setAttribute('data-rayfin-gen', '1');
    // Futuristic "building" animation (light-DOM keyframes injected in enable()).
    ph.setAttribute('style', PH_EMPTY + sz);
    ph.classList.add('__rf_gen');
    ph.innerHTML = '<span class="__rf_grid"></span><span class="__rf_gscan"></span>' +
      '<span class="__rf_glab"><span class="__rf_gspark">✦</span><span>Building<span class="__rf_gdots"></span></span></span>';
    state.aiRequest = { id: id, description: desc, width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)), model: state.aiModel || undefined };
    bump();
    renderInspector();
  }

  // Inject AI-generated HTML into the placeholder (empty html = failed → restore
  // the describe state). Sanitizes, renders live, and records it on the insert
  // entry so the agent gets it as a starting point.
  function applyGenerated(id, html) {
    var ph = placeholderById(id);
    if (!ph) return;
    var sz = phSize(ph);
    ph.removeAttribute('data-rayfin-gen');
    ph.classList.remove('__rf_gen');
    var clean = html ? sanitizeHtml(html) : '';
    if (!clean) {
      // Failure — return to the describe state.
      ph.setAttribute('style', PH_EMPTY + sz);
      ph.textContent = phDesc(ph) || 'New component';
      showHint('Couldn’t generate — try a different description');
      if (state.selected === ph) renderInspector();
      bump();
      return;
    }
    ph.setAttribute('style', PH_BASE + 'min-height:96px;padding:0;overflow:hidden;position:relative;display:block;' + sz);
    ph.innerHTML = clean;
    // Brief reveal animation on the newly rendered component.
    ph.classList.add('__rf_reveal');
    setTimeout(function () { ph.classList.remove('__rf_reveal'); }, 620);
    var entry = findInsertEntry(ph);
    if (entry) entry.generatedHtml = clean;
    bump();
    if (state.selected === ph) { renderInspector(); reposition(); }
  }

  // DOM-based sanitizer for model-generated markup before it's injected into the
  // live app: drop script/frame/external-resource elements, strip event-handler
  // attributes, and neutralize javascript:/external URLs (in attrs, `style`
  // attrs, and <style> blocks). Keeps inline CSS + data: images. Returns the
  // cleaned innerHTML.
  function cleanCss(css) {
    return String(css)
      .replace(/@import[^;]*;?/gi, '')
      .replace(/url\s*\(\s*['"]?\s*(?:https?:|\/\/)[^)]*\)/gi, 'none')
      .replace(/expression\s*\([^)]*\)/gi, '');
  }
  function sanitizeHtml(html) {
    var tpl;
    try {
      tpl = document.createElement('div');
      tpl.innerHTML = String(html);
    } catch (e) { return ''; }
    var BAD = { SCRIPT: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1, BASE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    var URL_ATTRS = { src: 1, href: 1, 'xlink:href': 1, action: 1, formaction: 1, background: 1, poster: 1, data: 1, ping: 1 };
    var EXT = /^\s*(javascript:|data:text\/html|vbscript:|https?:|\/\/)/i;
    var nodes = tpl.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.tagName) continue;
      // Normalize case: SVG/MathML (foreign-content) elements report a lowercase
      // tagName, so an inline <svg><style>/<script> would otherwise bypass this.
      var tag = n.tagName.toUpperCase();
      if (BAD[tag]) { if (n.parentNode) n.parentNode.removeChild(n); continue; }
      if (tag === 'STYLE') { n.textContent = cleanCss(n.textContent || ''); continue; }
      var attrs = n.attributes;
      for (var j = attrs.length - 1; j >= 0; j--) {
        var raw = attrs[j].name, name = raw.toLowerCase(), val = attrs[j].value || '';
        if (name.indexOf('on') === 0) { n.removeAttribute(raw); continue; }
        if (name === 'srcset') {
          // Comma-separated candidate list — drop if ANY candidate is external.
          if (val.split(',').some(function (c) { return EXT.test(c.trim()); })) n.removeAttribute(raw);
          continue;
        }
        if (URL_ATTRS[name] && EXT.test(val)) { n.removeAttribute(raw); continue; }
        if (name === 'style') n.setAttribute('style', cleanCss(val));
      }
    }
    return tpl.innerHTML;
  }

  // ---- handoff -------------------------------------------------------------
  var markers = [];
  function clearMarkers() { for (var i = 0; i < markers.length; i++) markers[i].remove(); markers = []; }
  function drawMarkers() {
    clearMarkers();
    for (var i = 0; i < state.changes.length; i++) {
      var c = state.changes[i], anchor = null;
      if (c.el && c.el.isConnected) { var r = c.el.getBoundingClientRect(); anchor = { x: r.left, y: r.top }; }
      else if (c.node) { var rb = c.node.getBoundingClientRect(); anchor = { x: rb.left, y: rb.top }; }
      if (!anchor) continue;
      var m = h('div', { class: 'marker', text: String(i + 1) });
      m.style.left = clamp(anchor.x - 6, 2, window.innerWidth - 24) + 'px';
      m.style.top = clamp(anchor.y - 6, 2, window.innerHeight - 20) + 'px';
      root.appendChild(m); markers.push(m);
    }
  }

  function beginHandoff() {
    if (state.changes.length === 0) return;
    if (state.editingText) commitText();
    closeCommentEditor(); deselect();
    state.hoverEl = null;
    elHover.style.display = 'none'; elLabel.style.display = 'none';
    elToolbar.style.display = 'none'; elInspector.style.display = 'none';
    if (elLegend) elLegend.style.display = 'none';
    drawMarkers();
    state.handoff = { instruction: composeInstruction(), changeCount: state.changes.length };
    bump();
  }

  function buildChangeSet() {
    var items = [];
    for (var i = 0; i < state.changes.length; i++) {
      var c = state.changes[i], item = { n: i + 1, kind: c.kind };
      if (c.el && c.el.nodeType === 1) item.context = context(c.el);
      else if (c.selector) item.selector = c.selector;
      if (c.property) item.property = c.property;
      if (c.from !== undefined) item.from = c.from;
      if (c.to !== undefined) item.to = c.to;
      if (c.target) item.target = c.target;
      if (c.note) item.note = c.note;
      if (c.region) item.region = c.region;
      if (c.box) item.box = c.box;
      if (c.kind === 'chart') { item.specBefore = c.before; item.specAfter = c.after; }
      if (c.kind === 'insert' && c.el) {
        item.intent = phDesc(c.el) || shortText(c.el);
        item.location = insertLoc(c.el);
        if (c.generatedHtml) item.generatedHtml = c.generatedHtml;
      }
      items.push(item);
    }
    return items;
  }

  function composeInstruction() {
    var lines = [];
    lines.push('I made these visual tweaks directly in the live preview (numbers match the highlighted markers in the attached screenshot). Please apply the equivalent changes to the app’s source:');
    lines.push('');
    for (var i = 0; i < state.changes.length; i++) {
      var c = state.changes[i], n = (i + 1) + '. ';
      if (c.kind === 'chart') lines.push(n + c.label + ' — update the Graphein spec (before→after in the JSON below).');
      else if (c.kind === 'move') lines.push(n + c.label + ' — move it ' + c.to + (c.target ? ' (inside ' + c.target.parentSelector + ')' : '') + '.');
      else if (c.kind === 'text') lines.push(n + c.label + ' — change text from “' + c.from + '” to “' + c.to + '”.');
      else if (c.kind === 'resize') lines.push(n + c.label + ' — resize from ' + c.from + ' to ' + c.to + ' px.');
      else if (c.kind === 'remove') lines.push(n + c.label + ' — remove this element.');
      else if (c.kind === 'comment') lines.push(n + 'Note on ' + c.label + ': ' + (c.note || '(no text)'));
      else if (c.kind === 'annotation') lines.push(n + 'Sketch (' + c.property + ') ' + (c.region ? 'on ' + c.region : '') + ' — see the screenshot marker.');
      else if (c.kind === 'insert') {
        var pr = c.el && c.el.isConnected ? c.el.getBoundingClientRect() : null;
        var desc = c.el ? (phDesc(c.el) || shortText(c.el)) : '';
        lines.push(n + 'Add a NEW UI component ' + insertLoc(c.el) + (pr ? ', ~' + Math.round(pr.width) + '×' + Math.round(pr.height) + 'px' : '') + '. Intended: “' + desc + '”.' + (c.generatedHtml ? ' A generated HTML/CSS starting point is in the change-set (`generatedHtml`) — use it as the base.' : ' (see the placeholder/marker in the screenshot).'));
      }
      else lines.push(n + c.label + ' — set ' + c.property + ' to ' + c.to + '.');
    }
    lines.push('');
    lines.push('Machine-readable change-set (selectors are best-effort DOM paths — use `context` + the screenshot to map to source):');
    lines.push('```json');
    try { lines.push(JSON.stringify(buildChangeSet(), null, 2)); } catch (e) { lines.push('[]'); }
    lines.push('```');
    return lines.join('\n');
  }

  // ---- global handlers -----------------------------------------------------
  function onPointerMove(e) {
    if (state.move || state.resizing || state.editingText) return;
    if (state.tool === 'insert') { showInsertLine(e.clientX, e.clientY); return; }
    if (state.tool !== 'select') return;
    if (isOurs(e.target)) { state.hoverEl = null; return; }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    state.hoverEl = (el && !isOurs(el)) ? (chartRoot(el) || el) : null;
    reposition();
  }

  function onPointerDown(e) {
    if (isOurs(e.target)) return; // our UI (toolbar/inspector/handles/pins/draw) handles itself
    if (state.tool === 'draw') return; // draw is handled by elDraw's own pointerdown

    if (state.editingText) {
      var inside = document.elementFromPoint(e.clientX, e.clientY);
      if (inside && (inside === state.editingText.el || state.editingText.el.contains(inside))) return;
      commitText();
    }
    var target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || isOurs(target)) return;
    var el = chartRoot(target) || target;

    if (state.tool === 'comment') { e.preventDefault(); e.stopPropagation(); addComment(el, e.clientX, e.clientY); return; }
    if (state.tool === 'insert') { e.preventDefault(); e.stopPropagation(); insertPlaceholder(target, e.clientY); return; }

    // select mode
    e.preventDefault(); e.stopPropagation();
    if (state.selected && (el === state.selected || state.selected.contains(target) || state.selected === target)) {
      beginPendingMove(e, state.selected, target); // drag the selection to move; click a child to drill in
    } else {
      select(el);
    }
  }

  function onDblClick(e) {
    if (state.tool !== 'select' || isOurs(e.target)) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && !isOurs(el) && !chartRoot(el) && el.children.length === 0) { e.preventDefault(); e.stopPropagation(); select(el); startText(el); }
  }

  function blockMouse(e) {
    if (isOurs(e.target)) return;
    if (state.editingText) { var t = e.target; if (t && (t === state.editingText.el || (state.editingText.el.contains && state.editingText.el.contains(t)))) return; }
    e.preventDefault(); e.stopPropagation();
  }

  function onKey(e) {
    if (state.editingText) { if (e.key === 'Escape') { e.preventDefault(); commitText(); } return; }
    // Don't hijack keys while typing in one of our own inputs (inspector fields,
    // comment note, chart title) — let them behave natively (incl. Ctrl+Z).
    var ae = root && root.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { if (e.key === 'Escape') ae.blur(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.stopPropagation(); undoLast(); return; }
    if (state.selected && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); e.stopPropagation(); removeSelected(); return; }
    if (state.selected && e.key.indexOf('Arrow') === 0) {
      e.preventDefault(); e.stopPropagation();
      var d = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') nudge(-d, 0); else if (e.key === 'ArrowRight') nudge(d, 0);
      else if (e.key === 'ArrowUp') nudge(0, -d); else nudge(0, d);
      return;
    }
    if (e.key === 'Escape') { closeCommentEditor(); if (state.selected) deselect(); else if (state.tool !== 'select') setTool('select'); return; }
    if (e.key === 'v' || e.key === 'V') setTool('select');
    else if (e.key === 'c' || e.key === 'C') setTool('comment');
    else if (e.key === 'i' || e.key === 'I') setTool('insert');
    else if (e.key === 'd' || e.key === 'D') setTool('draw');
  }

  var rafId = 0;
  function loop() { reposition(); rafId = requestAnimationFrame(loop); }

  var MOUSE_EVENTS = ['click', 'mousedown', 'mouseup', 'dblclick', 'contextmenu'];

  function enable() {
    if (state.enabled) return;
    state.enabled = true;
    buildUI();
    injectGenStyle();
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('dblclick', onDblClick, true);
    MOUSE_EVENTS.forEach(function (t) { window.addEventListener(t, blockMouse, true); });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);
    rafId = requestAnimationFrame(loop);
    showHint('Design mode — Select · Insert · Comment · Draw'); setTimeout(hideHint, 2800);
  }

  function disable() {
    if (!state.enabled) return;
    state.enabled = false;
    if (state.editingText) commitText();
    if (state.panelDragUp) { try { state.panelDragUp(); } catch (e) {} state.panelDragUp = null; }
    if (state.resizing) { window.removeEventListener('pointermove', onResizeMove, true); window.removeEventListener('pointerup', onResizeUp, true); state.resizing = null; }
    if (state.move) { window.removeEventListener('pointermove', onMoveMove, true); window.removeEventListener('pointerup', onMoveUp, true); if (state.move.el) state.move.el.style.opacity = state.move.origOpacity || ''; state.move = null; }
    if (state.drawing) { window.removeEventListener('pointermove', onDrawMove, true); window.removeEventListener('pointerup', onDrawUp, true); state.drawing = null; }
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('dblclick', onDblClick, true);
    MOUSE_EVENTS.forEach(function (t) { window.removeEventListener(t, blockMouse, true); });
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
    if (rafId) cancelAnimationFrame(rafId); rafId = 0;
    clearMarkers();
    // Reset any placeholder left mid-"building" (its animation style is about to
    // be removed) so it doesn't sit as a static half-state in the app.
    try {
      var gens = document.querySelectorAll('[data-rayfin-gen="1"]');
      for (var gi = 0; gi < gens.length; gi++) {
        var gp = gens[gi];
        gp.removeAttribute('data-rayfin-gen');
        gp.classList.remove('__rf_gen');
        gp.textContent = gp.getAttribute('data-rayfin-desc') || 'New component';
      }
    } catch (e) {}
    removeGenStyle();
    if (host) host.remove();
    host = root = null;
    state.selected = null; state.hoverEl = null; state.handoff = null; state.aiRequest = null;
  }

  // ---- color helper --------------------------------------------------------
  function rgbToHex(c) {
    if (!c) return '#000000';
    if (c[0] === '#') return c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c;
    var m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!m) return '#000000';
    function x(n) { var s = (+n).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + x(m[1]) + x(m[2]) + x(m[3]);
  }

  // ---- public API ----------------------------------------------------------
  window[NS] = {
    __v: VERSION,
    enable: function () { try { enable(); } catch (e) {} },
    disable: function () { try { disable(); } catch (e) {} },
    peek: function () { return { enabled: state.enabled, version: state.version, changeCount: state.changes.length, handoffReady: !!state.handoff, aiPending: !!state.aiRequest, hasModels: !!(state.models && state.models.length), aiModel: state.aiModel || null }; },
    drain: function () {
      var hf = state.handoff; if (!hf) return null;
      state.handoff = null;
      var out = { instruction: hf.instruction, changeCount: hf.changeCount };
      // Clean up: clear change-set (entries hold the undo closures), markup, and
      // markers; restore chrome (host typically disables next).
      state.changes = []; clearMarkers(); clearPins(); clearDrawings();
      if (elToolbar) { elToolbar.style.display = 'flex'; renderBar(); }
      bump();
      return out;
    },
    // Drain a pending "Generate with AI" request (host then generates + applies).
    drainAi: function () {
      var r = state.aiRequest; if (!r) return null;
      state.aiRequest = null; bump();
      return { id: r.id, description: r.description, width: r.width, height: r.height, model: r.model };
    },
    // Inject AI-generated HTML into placeholder `id` (empty html = generation
    // failed → restore the describe state).
    applyGenerated: function (id, html) { try { applyGenerated(id, html); } catch (e) {} },
    // Supply the model list for the placeholder AI picker (host resolves it);
    // `[{id,name,fast}]`. Defaults the selection to the first fast model.
    setModels: function (list, preferred) {
      try {
        state.models = Array.isArray(list) ? list : null;
        var ids = (state.models || []).map(function (m) { return m.id; });
        // Preselect: keep the current pick if still offered; otherwise the
        // caller's preferred (persisted) model; otherwise the first fast / first.
        if (!state.aiModel || ids.indexOf(state.aiModel) < 0) {
          if (preferred && ids.indexOf(preferred) >= 0) {
            state.aiModel = preferred;
          } else if (state.models && state.models.length) {
            var fast = state.models.filter(function (m) { return m.fast; })[0];
            state.aiModel = (fast || state.models[0]).id;
          }
        }
        if (state.selected && isPlaceholder(state.selected)) renderInspector();
      } catch (e) {}
    }
  };
})();
