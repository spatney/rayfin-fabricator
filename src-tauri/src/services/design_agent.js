/*
 * Rayfin preview "design mode" controller (v5 + opt-in Studio protocol 1).
 *
 * Injected at document-start into EVERY frame of the preview webview (see
 * `preview.rs` `DESIGN_AGENT_JS` / `initialization_script_for_all_frames`). Stays
 * dormant until `enable(...)` or the opt-in `studio.connect(...)`. A Figma-like,
 * click-to-edit layer over the LIVE app:
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
 * Frames / roles: the host (Rust) can only `eval` in the TOP frame. In the direct
 * view the top frame IS the app, so it runs the full controller locally
 * (role `direct`). In the Fabric-embedded view the app runs in a CROSS-ORIGIN
 * iframe inside the Fabric portal; the top (Fabric shell) frame then runs as a
 * `relay` and the app iframe runs the full controller as role `app`. The relay
 * bridges the host API (`enable/disable/peek/drain/drainAi/applyGenerated/
 * setModels`) to the app frame over `postMessage`, discovered via a namespaced
 * hello/enable handshake and origin-gated to the deployed app's origin.
 *
 * Design constraints:
 *   - The native webview paints above all HTML, so ALL UI lives INSIDE this page,
 *     in a Shadow DOM attached to <html> (isolated from the app's CSS; survives
 *     SPA body swaps). Everything is torn down on `disable()`, namespaced under
 *     `window.__rayfinDesign`, and never persisted.
 *   - Host comms are pull-based: the host polls `peek()` and reads `drain()`.
 *   - `studio` is a separate, opt-in protocol. Its JSON journal is authoritative;
 *     DOM references and inverse functions are only a disposable projection.
 *     The workspace owns framing and Apply. This page owns hit testing, inline
 *     text and a small, three-action contextual popover; legacy panels stay off.
 */
(function () {
  var NS = '__rayfinDesign';
  var VERSION = 5;
  if (window[NS] && window[NS].__v === VERSION) return;

  var HOST_ID = '__rayfin_design_host';
  var studio = null, studioRelay = null;

  // ---- theme (flat, teal — matches the host app) ---------------------------
  var TEAL = '#14b8a6';
  var TEAL_HI = '#2dd4bf';
  var AMBER = '#f59e0b';
  var GUIDE = '#f43f5e'; // alignment-guide line colour (distinct from accent/amber)
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

  // ---- type + icon scale (chrome) ------------------------------------------
  // Base sizes (px) for the tool UI's own text/icons, multiplied by `themeScale`
  // — which the host sets from Fabricator's UI zoom (100/110/125/150%) so the
  // tools scale with the rest of the app. Injected as :host CSS vars; the
  // shadow-DOM rules reference them via var(--fs-*). Scoped to the chrome — the
  // light-DOM "building" animation (GEN_STYLE) keeps its own sizes.
  var FS = { micro: 11, small: 12, base: 13, icon: 16 };
  var themeScale = 1;
  // On-accent / on-amber text + UI font — accent-derived text colors are set by
  // applyHostTheme() to stay readable on Fabricator's accent; FONT stays the
  // tool's own clean sans (we match Fabricator's colors + scale, not its font).
  var ON_ACCENT = '#04211f'; // readable text on the accent fill
  var ON_AMBER = '#241a04'; // readable text on the amber (annotation) fill
  var FONT = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

  // ---- state ---------------------------------------------------------------
  var state = {
    enabled: false,
    tool: 'select', // 'select' | 'comment' | 'draw'
    drawShape: 'pen', // 'pen' | 'arrow' | 'rect' | 'ellipse'
    drawColor: AMBER,
    version: 0, // bumped on every change so the host poll detects activity
    changes: [], // ordered change-set entries (each has .revert, .el|.pinEl|.node)
    redo: [], // reverted entries available to redo (cleared on any new edit)
    selected: null, // the PRIMARY selected element (drives element-specific inspector bits)
    selection: [], // all selected elements (multi-select); edits apply to every one
    selInline: null, // primary's inline-style snapshot (at select) for value seeding
    selInlineMap: null, // WeakMap el -> inline snapshot, for per-element revert on multi
    resizing: null,
    move: null, // active move gesture (or pending, pre-threshold)
    drawing: null, // active draw gesture
    hoverEl: null,
    handoff: null,
    aiRequest: null, // pending "Generate with AI" request for a placeholder
    aiEditQueue: [], // queued "Edit with AI" restyle requests (multiple at once)
    theme: null, // Fabricator theme pushed by the host via setTheme()
    hasTheme: false, // re-pushed by the renderer after a reload when false
    models: null, // [{id,name,fast}] supplied by the host for the AI model picker
    aiModel: 'auto', // selected model id; 'auto' → let the engine pick (default)
    debugView: null, // active transient full-screen Graphein debug inspection ({el,target,prevSpecAttr,prevTargetStyle,neutralized}) or null
    debugBar: null // shadow-host "Exit debug" bar element while debugView is active
  };

  // ---- constants -----------------------------------------------------------
  // Every Graphein VISUAL chart type (spec/types.ts CHART_TYPES minus the five
  // slicer controls — dropdown/search/list/range/dateRange — which are filters,
  // not chart marks, and never appear in the chart-spec inspector's Type row).
  var CHART_TYPES = ['bar', 'line', 'area', 'scatter', 'combo', 'histogram', 'pie', 'heatmap', 'funnel', 'treemap', 'waterfall', 'box', 'slope', 'dumbbell', 'sankey', 'choropleth', 'calendarHeatmap', 'kpi', 'gauge', 'bullet', 'table', 'matrix'];
  // Grouping for the Type dropdown's <optgroup>s (purely presentational).
  var TYPE_GROUPS = [
    ['Cartesian', ['bar', 'line', 'area', 'scatter', 'box', 'histogram', 'combo']],
    ['Part-to-whole', ['pie', 'funnel', 'treemap', 'waterfall']],
    ['Comparison', ['slope', 'dumbbell']],
    ['Grid / time', ['heatmap', 'calendarHeatmap']],
    ['Flow / geo', ['sankey', 'choropleth']],
    ['Single value', ['kpi', 'gauge', 'bullet']],
    ['Tabular', ['table', 'matrix']]
  ];
  var TYPE_LABELS = { calendarHeatmap: 'Calendar heatmap', kpi: 'KPI' };
  function typeLabel(t) { return TYPE_LABELS[t] || (t.charAt(0).toUpperCase() + t.slice(1)); }
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
  function bump() { state.version++; if (frameRole === 'app') postStatus(); }
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
          if (entry.reapply) c.reapply = entry.reapply;
          state.changes.splice(i, 1); state.changes.push(c);
          state.redo = [];
          bump(); renderBar(); return;
        }
      }
    }
    if (typeof entry.revert !== 'function') entry.revert = function () {};
    state.changes.push(entry);
    state.redo = [];
    bump(); renderBar();
  }
  function revertEntry(entry) { try { if (entry && typeof entry.revert === 'function') entry.revert(); } catch (e) {} }

  function undoLast() {
    if (state.editingText) commitText();
    var entry = state.changes.pop();
    if (!entry) return;
    revertEntry(entry);
    if (entry.reapply) state.redo.push(entry);
    if (state.selected && !state.selected.isConnected) deselect();
    if (state.selected && state.selected.isConnected) renderInspector();
    bump(); reposition(); renderBar();
  }
  // Re-apply the most recently undone change (only kinds that captured a reapply
  // closure — style/resize/text/chart/nudge/move/remove).
  function redoLast() {
    var entry = state.redo.pop();
    if (!entry) return;
    try { entry.reapply(); } catch (e) {}
    state.changes.push(entry);
    if (state.selected && state.selected.isConnected) renderInspector();
    bump(); reposition(); renderBar();
  }
  // Revert a single change-set entry (from the changes panel) without disturbing
  // the others; it becomes redoable.
  function removeChange(entry) {
    var i = state.changes.indexOf(entry);
    if (i < 0) return;
    revertEntry(entry);
    state.changes.splice(i, 1);
    if (entry.reapply) state.redo.push(entry);
    if (state.selected && !state.selected.isConnected) deselect();
    else if (state.selected) renderInspector();
    bump(); reposition(); renderBar();
  }
  // Scroll a change's element into view and flash it.
  function jumpToChange(entry) {
    var el = entry && (entry.el || entry.node);
    if (!el || !el.isConnected) return;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    var before = el.style.outline, beforeOff = el.style.outlineOffset;
    el.style.outline = '2px solid ' + TEAL; el.style.outlineOffset = '2px';
    setTimeout(function () { el.style.outline = before; el.style.outlineOffset = beforeOff; }, 700);
  }

  // ---- Shadow-DOM UI -------------------------------------------------------
  var host, root;
  var elHover, elLabel, elSel, elSels, elBadges, elHandles, elInsert, elToolbar, elInspector, elDraw, elPins, elLegend, elCommentEditor, elStyle, elMoveTip;
  var elCount, btnUndo, btnRedo, btnDiscard, btnSend, btnChanges, elChanges, elGuides, elMorph;
  // Smart guides: snap resized edges to nearby sibling/parent edges + centers.
  var SNAP_THR = 6, snapOn = true;

  function buildStyle() {
    return [
    ':host{all:initial;--fs-micro:' + fpx(FS.micro) + ';--fs-small:' + fpx(FS.small) + ';--fs-base:' + fpx(FS.base) + ';--icon:' + fpx(FS.icon) + '}',
    '*{box-sizing:border-box;font-family:' + FONT + '}',
    'button{all:unset;cursor:pointer}',
    '::-webkit-scrollbar{width:8px;height:8px}',
    '::-webkit-scrollbar-thumb{background:' + BORDER + ';border-radius:8px}',
    '::-webkit-scrollbar-thumb:hover{background:' + TXT_DIM + '}',
    '::-webkit-scrollbar-track{background:transparent}',
    // overlays
    '.box{position:fixed;pointer-events:none;z-index:2147483640;border-radius:3px}',
    '.hover{border:1.5px solid ' + TEAL + '88;background:' + TEAL + '11}',
    '.sel{border:1.5px solid ' + TEAL + ';box-shadow:0 0 0 1px ' + TEAL + '55}',
    '.selm{border:1.5px solid ' + TEAL + '99}',
    '.label{position:fixed;pointer-events:none;z-index:2147483644;background:' + TEAL + ';color:' + ON_ACCENT + ';font-size:var(--fs-small);font-weight:600;padding:2px 6px;border-radius:4px;white-space:nowrap}',
    '.badge{position:fixed;pointer-events:none;z-index:2147483644;background:' + TEAL + ';color:' + ON_ACCENT + ';font-size:var(--fs-micro);font-weight:700;padding:1px 5px;border-radius:4px}',
    '.ring{position:fixed;pointer-events:none;z-index:2147483639;border:2px solid ' + AMBER + ';border-radius:4px;box-shadow:0 0 0 2px ' + AMBER + '44}',
    '.insert{position:fixed;pointer-events:none;z-index:2147483643;background:' + TEAL + ';box-shadow:0 0 6px ' + TEAL + '}',
    '.hnd{position:fixed;width:12px;height:12px;background:' + TEAL + ';border:2px solid #fff;border-radius:3px;z-index:2147483643;pointer-events:auto;box-shadow:0 1px 5px rgba(0,0,0,.45)}',
    '.hnd:hover{background:' + TEAL_HI + ';transform:scale(1.18)}',
    // draw layer + pins
    '.draw{position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483638;pointer-events:none;overflow:visible}',
    '.pins{position:fixed;inset:0;z-index:2147483643;pointer-events:none}',
    '.pin{position:fixed;transform:translate(-50%,-100%);z-index:2147483643;pointer-events:auto;cursor:pointer;width:22px;height:22px;line-height:20px;text-align:center;background:' + AMBER + ';color:' + ON_AMBER + ';font-size:var(--fs-small);font-weight:800;border:2px solid #fff;border-radius:50% 50% 50% 2px;box-shadow:0 2px 6px rgba(0,0,0,.5)}',
    // toolbar (top-center)
    '.tb{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483646;display:flex;flex-wrap:wrap;justify-content:center;max-width:94vw;align-items:center;gap:4px;padding:4px;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:11px;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:auto;cursor:move}',
    '.seg{display:flex;background:' + PANEL_BG2 + ';border-radius:8px;padding:2px;gap:2px}',
    '.seg button{display:flex;align-items:center;gap:6px;color:' + TXT_DIM + ';font-size:var(--fs-base);font-weight:500;padding:6px 8px;border-radius:6px}',
    '.seg button:hover{color:' + TXT + '}',
    '.seg button.on{background:' + TEAL + ';color:' + ON_ACCENT + '}',
    '.tb .swatches{display:flex;gap:4px;align-items:center;padding-left:6px;border-left:1px solid ' + BORDER + '}',
    '.tb .sw-picker{width:26px;height:26px;padding:0;border:1px solid ' + BORDER + ';border-radius:7px;background:none;cursor:pointer}',
    '.tb .sw-picker:hover{border-color:' + TXT_DIM + '}',
    '.tb .sw-picker::-webkit-color-swatch-wrapper{padding:2px}',
    '.tb .sw-picker::-webkit-color-swatch{border:none;border-radius:5px}',
    '.tb .shape{color:' + TXT_DIM + ';padding:5px 7px;border-radius:6px;font-size:var(--fs-base)}',
    '.tb .shape.on{background:' + PANEL_BG2 + ';color:' + TXT + '}',
    // inspector (right dock)
    '.insp{position:fixed;right:12px;top:58px;max-height:calc(100vh - 70px);width:262px;z-index:2147483645;display:flex;flex-direction:column;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:11px;box-shadow:0 10px 40px rgba(0,0,0,.55);pointer-events:auto;color:' + TXT + ';overflow:hidden}',
    '.insp-head{padding:10px 12px;border-bottom:1px solid ' + BORDER + ';cursor:move}',
    '.crumb{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:var(--fs-small);color:' + TXT_DIM + '}',
    '.crumb button{color:' + TXT_DIM + ';padding:1px 4px;border-radius:4px}',
    '.crumb button:hover{background:' + PANEL_BG2 + ';color:' + TXT + '}',
    '.crumb .cur{color:' + TEAL + ';font-weight:600}',
    '.insp-sz{font-size:var(--fs-small);color:' + TXT_DIM + ';margin-top:4px}',
    '.insp-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:8px 12px 12px}',
    '.grp{margin-top:14px}',
    '.grp>h5{margin:0 0 7px;font-size:var(--fs-micro);letter-spacing:.06em;text-transform:uppercase;color:' + TXT_DIM + ';font-weight:700}',
    '.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0;min-width:0}',
    '.row label{font-size:var(--fs-base);color:' + TXT + ';min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.row .ctl{display:flex;align-items:center;gap:6px;flex:none}',
    '.insp input[type=text],.insp input[type=number],.insp select,.insp textarea{background:' + PANEL_BG2 + ';color:' + TXT + ';border:1px solid ' + BORDER + ';border-radius:6px;padding:5px 8px;font-size:var(--fs-base);width:132px;max-width:60%}',
    '.insp textarea{width:100%;max-width:100%;min-height:74px;resize:none;margin-top:6px;line-height:1.45}',
    // Number fields: wide enough for 4–5 digits, right-aligned, with the spin buttons
    // removed (their arrows cropped the value in the old narrow field).
    '.insp input[type=number]{width:88px;text-align:right;-moz-appearance:textfield;appearance:textfield}',
    '.insp input[type=number]::-webkit-inner-spin-button,.insp input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}',
    '.insp input[type=range]{width:104px;accent-color:' + TEAL + '}',
    '.insp input[type=color]{width:34px;height:24px;background:' + PANEL_BG2 + ';border:1px solid ' + BORDER + ';border-radius:5px;padding:2px}',
    '.insp .mini{color:' + TXT_DIM + ';font-size:var(--fs-small);font-weight:600;padding:4px 8px;border-radius:6px;background:' + PANEL_BG2 + '}',
    '.insp .mini:hover{color:' + TXT + '}',
    '.insp .mini.danger:hover{background:#5b1a1a;color:#fff}',
    // Row-level action button — sized to sit in the same right-hand control column
    // as the dropdowns/inputs (width matches .insp select) so the panel stays tidy.
    '.insp .gbtn{width:132px;max-width:60%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:' + TXT + ';font-size:var(--fs-base);font-weight:600;padding:5px 8px;border-radius:6px;background:' + PANEL_BG2 + ';border:1px solid ' + BORDER + '}',
    '.insp .gbtn:hover{border-color:' + TEAL + ';color:' + TEAL_HI + '}',
    '.insp-actions{display:flex;gap:6px;padding:7px 11px;border-top:1px solid ' + BORDER + '}',
    '.insp-multi{margin:2px 0 9px;padding:7px 10px;border-radius:8px;background:' + TEAL + '1f;border:1px solid ' + TEAL + '3d;color:' + TEAL_HI + ';font-size:var(--fs-small);font-weight:600}',
    // Edit/Generate-with-AI card: flat (no gradient), light chrome, and a roomy box
    // so the prompt has space to breathe. Nested padding was trimmed so the textarea
    // gets the panel width rather than stacking card + box + textarea insets.
    '.ai-card{margin:0 0 9px;padding:10px 10px 11px;border:1px solid ' + TEAL + '2e;border-radius:11px;background:' + TEAL + '12}',
    '.ai-card h5{margin:0 0 8px;color:' + TEAL + ';font-size:var(--fs-small);font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
    '.ai-box{border:1px solid ' + BORDER + ';border-radius:9px;background:' + PANEL_BG + ';overflow:hidden;transition:border-color .15s,box-shadow .15s}',
    '.ai-box:focus-within{border-color:' + TEAL + ';box-shadow:0 0 0 2px ' + TEAL + '33}',
    '.ai-box textarea{width:100%;max-width:100%;display:block;background:transparent;border:0;border-radius:0;margin:0;min-height:104px;resize:none;padding:9px 10px;font-size:var(--fs-base);line-height:1.5;color:' + TXT + '}',
    '.ai-box textarea:focus{outline:none}',
    '.ai-foot{display:flex;align-items:center;gap:6px;padding:6px;border-top:1px solid ' + BORDER + '}',
    '.ai-foot .ai-model{flex:1 1 auto;width:auto;min-width:0;max-width:none;background:' + PANEL_BG2 + ';color:' + TXT + ';border:1px solid ' + BORDER + ';border-radius:7px;padding:0 8px;font-size:var(--fs-small);height:30px}',
    '.ai-btn{flex:none;font-size:var(--fs-base);font-weight:700;color:' + ON_ACCENT + ';background:' + TEAL + ';border-radius:7px;padding:0 15px;height:30px;display:inline-flex;align-items:center;white-space:nowrap}',
    '.ai-btn:hover{background:' + TEAL_HI + '}',
    '.ai-btn.busy{opacity:.7;pointer-events:none}',
    '.ai-note{margin:8px 2px 0;font-size:var(--fs-micro);color:' + TXT_DIM + ';line-height:1.45}',
    // toolbar actions (count / undo / discard / send)
    '.tb-sep{width:1px;align-self:stretch;background:' + BORDER + ';margin:0 2px}',
    '.tb-count{font-size:var(--fs-small);font-weight:700;color:' + ON_ACCENT + ';background:' + TEAL + ';border-radius:999px;padding:1px 7px;min-width:8px;text-align:center;white-space:nowrap}',
    '.tb-act{font-size:var(--fs-base);color:' + TXT_DIM + ';padding:6px 9px;border-radius:7px}',
    '.tb-act:hover{color:' + TXT + ';background:' + PANEL_BG2 + '}',
    '.tb-ico{display:flex;align-items:center;padding:6px 7px}',
    '.tb-send{font-size:var(--fs-base);font-weight:600;background:' + TEAL + ';color:' + ON_ACCENT + ';padding:6px 12px;border-radius:7px}',
    '.tb-send:hover{background:' + TEAL_HI + '}',
    // hint / legend
    '.hint{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:' + TEAL + ';color:' + ON_ACCENT + ';font-weight:600;font-size:var(--fs-base);padding:6px 14px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none;display:flex;align-items:center;gap:7px}',
    '.hint.err{background:#e5484d;color:#fff;box-shadow:0 6px 20px rgba(229,72,77,.45)}',
    '.hint.err::before{content:"\\26A0";font-size:calc(var(--fs-base) + 1px)}',
    // Full-screen debug view exit bar (bottom-center, above the debug chart).
    '.dbgbar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;padding:7px 8px 7px 14px;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:11px;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:auto}',
    '.dbgbar-t{font-size:var(--fs-base);font-weight:600;color:' + TXT + '}',
    '.dbgbar-x{font-size:var(--fs-base);font-weight:700;color:' + ON_ACCENT + ';background:' + TEAL + ';border-radius:7px;padding:6px 12px}',
    '.dbgbar-x:hover{background:' + TEAL_HI + '}',
    '.legend{position:fixed;left:12px;bottom:14px;z-index:2147483646;width:220px;padding:12px;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:auto;color:' + TXT + ';font-size:var(--fs-base)}',
    '.legend h5{margin:0 0 8px;font-size:var(--fs-base);color:' + TEAL + '}',
    '.legend div{color:' + TXT_DIM + ';margin:3px 0}',
    '.legend kbd{background:' + PANEL_BG2 + ';border:1px solid ' + BORDER + ';border-radius:4px;padding:0 4px;color:' + TXT + '}',
    '.legend .close{position:absolute;top:8px;right:10px;color:' + TXT_DIM + '}',
    // comment editor
    '.cmt{position:fixed;z-index:2147483647;width:220px;padding:8px;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);pointer-events:auto}',
    '.cmt textarea{width:100%;min-height:56px;background:' + PANEL_BG2 + ';color:' + TXT + ';border:1px solid ' + BORDER + ';border-radius:6px;padding:6px;font-size:var(--fs-base);resize:vertical}',
    '.cmt .r{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}',
    '.cmt button{font-size:var(--fs-base);padding:5px 10px;border-radius:6px;color:' + TXT_DIM + '}',
    '.cmt button.ok{background:' + TEAL + ';color:' + ON_ACCENT + ';font-weight:600}',
    '.editing-text{outline:2px dashed ' + TEAL + ' !important;outline-offset:2px}',
    // changes panel (left dock)
    '.changes{position:fixed;left:12px;top:58px;max-height:calc(100vh - 70px);width:236px;z-index:2147483645;display:flex;flex-direction:column;background:' + PANEL_GLASS + ';' + GLASS_FX + ';border:1px solid ' + BORDER + ';border-radius:11px;box-shadow:0 10px 40px rgba(0,0,0,.55);pointer-events:auto;color:' + TXT + ';overflow:hidden}',
    '.chg-head{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-bottom:1px solid ' + BORDER + ';font-size:var(--fs-small);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:' + TXT_DIM + ';cursor:move}',
    '.chg-x{color:' + TXT_DIM + ';padding:0 4px}',
    '.chg-x:hover{color:' + TXT + '}',
    '.chg-empty{padding:14px 12px;font-size:var(--fs-small);color:' + TXT_DIM + '}',
    '.chg-list{overflow-y:auto;padding:6px}',
    '.chg-row{display:flex;align-items:flex-start;gap:8px;padding:6px 7px;border-radius:7px}',
    '.chg-row:hover{background:' + PANEL_BG2 + '}',
    '.chg-n{flex:none;min-width:18px;height:18px;line-height:18px;text-align:center;background:' + TEAL + ';color:' + ON_ACCENT + ';font-size:var(--fs-micro);font-weight:800;border-radius:9px}',
    '.chg-main{flex:1;min-width:0}',
    '.chg-title{font-size:var(--fs-small);color:' + TXT + ';font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.chg-sub{font-size:var(--fs-micro);color:' + TXT_DIM + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}',
    '.chg-rm{flex:none;color:' + TXT_DIM + ';padding:2px 5px;border-radius:5px;font-size:var(--fs-small)}',
    '.chg-rm:hover{background:#5b1a1a;color:#fff}',
    // smart-guide lines + snap toggle
    '.guides{position:fixed;inset:0;z-index:2147483641;pointer-events:none}',
    '.guide{position:fixed;background:' + GUIDE + ';box-shadow:0 0 4px ' + GUIDE + '}',
    '.guide.v{top:0;width:1px;height:100vh}',
    '.guide.hz{left:0;height:1px;width:100vw}',
    '.move-tip{z-index:2147483645;box-shadow:0 2px 8px rgba(0,0,0,.4)}',
    '.tb-ico.snap-on{color:' + TEAL + ';background:' + PANEL_BG2 + '}',
    // AI "transforming" overlay (shown over each element being restyled)
    '@keyframes rfMorphSweep{0%{transform:translateX(-130%) skewX(-12deg)}100%{transform:translateX(130%) skewX(-12deg)}}',
    '@keyframes rfMorphGlow{0%,100%{box-shadow:0 0 0 1px ' + TEAL + 'cc,0 0 20px -6px ' + TEAL + ',inset 0 0 18px -10px ' + TEAL_HI + '}50%{box-shadow:0 0 0 2px ' + TEAL_HI + ',0 0 34px -3px ' + TEAL_HI + ',inset 0 0 26px -8px ' + TEAL_HI + '}}',
    '@keyframes rfMorphScan{0%{top:-12%;opacity:0}12%{opacity:1}88%{opacity:1}100%{top:104%;opacity:0}}',
    '.morphs{position:fixed;inset:0;z-index:2147483642;pointer-events:none}',
    '.morph{position:fixed;border-radius:8px;overflow:hidden;animation:rfMorphGlow 1.5s ease-in-out infinite}',
    '.morph::before{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 38%,' + TEAL_HI + '22 47%,' + TEAL_HI + '66 50%,' + TEAL_HI + '22 53%,transparent 62%);transform:translateX(-130%) skewX(-12deg);animation:rfMorphSweep 1.4s ease-in-out infinite}',
    '.morph::after{content:"";position:absolute;left:6%;right:6%;height:2px;top:-12%;border-radius:2px;background:linear-gradient(90deg,transparent,' + TEAL_HI + ',transparent);box-shadow:0 0 14px 2px ' + TEAL_HI + 'cc;animation:rfMorphScan 1.7s cubic-bezier(.4,0,.2,1) infinite}',
    '@media (prefers-reduced-motion: reduce){.morph,.morph::before,.morph::after{animation:none}.morph{box-shadow:0 0 0 2px ' + TEAL + '}.morph::after{display:none}}'
    ].join('\n') + (studio ? studioPopupCss() : '');
  }

  // Light-DOM animation CSS for the placeholder "building" state (the placeholder
  // is a real element in the app's DOM, not in our shadow root, so its @keyframes
  // must live in the page). Injected on enable, removed on disable. Namespaced
  // `__rf_*` + honours prefers-reduced-motion.
  var GEN_STYLE_ID = '__rayfin_design_gen_style';
  function buildGenStyle() {
    return [
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
  }

  function injectGenStyle() {
    try {
      if (document.getElementById(GEN_STYLE_ID)) return;
      var s = document.createElement('style');
      s.id = GEN_STYLE_ID;
      s.textContent = buildGenStyle();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }
  function removeGenStyle() {
    var s = document.getElementById(GEN_STYLE_ID);
    if (s) s.remove();
  }

  function icon(name) {
    var isz = Math.round(FS.icon * themeScale);
    var p = {
      cursor: '<path d="M4 3l15 8-6 1.5L10 20 4 3z"/>',
      comment: '<path d="M4 5h16v10H9l-4 4v-4H4z"/>',
      frame: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 9v6M9 12h6"/>',
      pen: '<path d="M14 4l6 6L9 21l-6 1 1-6z"/>',
      undo: '<path d="M4 9h11a5 5 0 0 1 0 10h-4"/><path d="M4 9l4-4M4 9l4 4"/>',
      redo: '<path d="M20 9H9a5 5 0 0 0 0 10h4"/><path d="M20 9l-4-4M20 9l-4 4"/>',
      list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
      trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
      magnet: '<path d="M5 20V11a7 7 0 0 1 14 0v9M9 20v-9a3 3 0 0 1 6 0v9M5 16h4M15 16h4"/>'
    }[name] || '';
    return '<svg width="' + isz + '" height="' + isz + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }

  function buildUI() {
    host = document.getElementById(HOST_ID);
    if (host) host.remove();
    host = h('div', { id: HOST_ID });
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    elStyle = h('style', { text: buildStyle() });
    root.appendChild(elStyle);

    elDraw = svg('svg', { class: 'draw' });
    elDraw.addEventListener('pointerdown', onDrawDown);
    elPins = h('div', { class: 'pins' });
    elHover = h('div', { class: 'box hover', style: 'display:none' });
    elLabel = h('div', { class: 'label', style: 'display:none' });
    elSel = h('div', { class: 'box sel', style: 'display:none' });
    elSels = h('div', { style: 'display:none' }); // pool of selection boxes (multi-select)
    elBadges = h('div', { style: 'display:none' });
    elInsert = h('div', { class: 'insert', style: 'display:none' });
    elHandles = h('div', { style: 'display:none' });
    elToolbar = h('div', { class: 'tb' });
    elInspector = h('div', { class: 'insp', style: 'display:none' });
    elChanges = h('div', { class: 'changes', style: 'display:none' });
    elGuides = h('div', { class: 'guides' });
    elMorph = h('div', { class: 'morphs', style: 'display:none' });
    elMoveTip = h('div', { class: 'badge move-tip', style: 'display:none' });
    [elDraw, elPins, elGuides, elMorph, elHover, elLabel, elSels, elSel, elBadges, elInsert, elHandles, elMoveTip, elToolbar, elInspector, elChanges]
      .forEach(function (n) { root.appendChild(n); });

    makeDraggable(elToolbar, false);
    makeDraggable(elInspector, false);
    makeDraggable(elChanges, true);
    buildToolbar();
    if (!studio && !localStorageFlag()) showLegend();
    if (studio) studioPopupMount();
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
    if (studio) { elToolbar.style.display = 'none'; return; }
    elToolbar.textContent = '';
    var tools = h('div', { class: 'seg' });
    [['select', 'cursor', 'Select', 'V'], ['comment', 'comment', 'Comment', 'C'], ['insert', 'frame', 'Insert', 'I'], ['draw', 'pen', 'Draw', 'D']].forEach(function (t) {
      var b = h('button', { class: state.tool === t[0] ? 'on' : '', html: icon(t[1]), title: t[2] + ' (' + t[3] + ')', 'aria-label': t[2] });
      b.onclick = function (e) { e.stopPropagation(); setTool(t[0]); };
      tools.appendChild(b);
    });
    elToolbar.appendChild(tools);
    var btnSnap = h('button', { class: 'tb-act tb-ico' + (snapOn ? ' snap-on' : ''), html: icon('magnet'), title: 'Snap to guides — ' + (snapOn ? 'on' : 'off') + ' (hold Ctrl to bypass)', 'aria-label': 'Snap to guides' });
    btnSnap.onclick = function (e) { e.stopPropagation(); snapOn = !snapOn; buildToolbar(); };
    elToolbar.appendChild(btnSnap);

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
    elCount.onclick = function (e) { e.stopPropagation(); toggleChanges(); };
    elToolbar.appendChild(elCount);
    btnChanges = h('button', { class: 'tb-act tb-ico', html: icon('list'), title: 'Changes', 'aria-label': 'Changes' });
    btnChanges.onclick = function (e) { e.stopPropagation(); toggleChanges(); };
    btnUndo = h('button', { class: 'tb-act tb-ico', html: icon('undo'), title: 'Undo (Ctrl/Cmd+Z)', 'aria-label': 'Undo' });
    btnUndo.onclick = function (e) { e.stopPropagation(); undoLast(); };
    btnRedo = h('button', { class: 'tb-act tb-ico', html: icon('redo'), title: 'Redo (Ctrl/Cmd+Shift+Z)', 'aria-label': 'Redo' });
    btnRedo.onclick = function (e) { e.stopPropagation(); redoLast(); };
    btnDiscard = h('button', { class: 'tb-act tb-ico', html: icon('trash'), title: 'Discard all changes', 'aria-label': 'Discard' });
    btnDiscard.onclick = function (e) { e.stopPropagation(); discardAll(); };
    btnSend = h('button', { class: 'tb-send', text: 'Send to chat' });
    btnSend.onclick = function (e) { e.stopPropagation(); beginHandoff(); };
    elToolbar.appendChild(btnChanges); elToolbar.appendChild(btnUndo); elToolbar.appendChild(btnRedo);
    elToolbar.appendChild(btnDiscard); elToolbar.appendChild(btnSend);
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
  var hintEl = null, hintTimer = 0;
  function showHint(text, kind) { hideHint(); if (!text) return; hintEl = h('div', { class: 'hint' + (kind === 'error' ? ' err' : ''), text: text }); root.appendChild(hintEl); hintTimer = setTimeout(hideHint, kind === 'error' ? 3600 : 2800); }
  function hideHint() { if (hintTimer) { clearTimeout(hintTimer); hintTimer = 0; } if (hintEl) { hintEl.remove(); hintEl = null; } }

  function showLegend() {
    if (elLegend) elLegend.remove();
    elLegend = h('div', { class: 'legend' });
    var close = h('button', { class: 'close', text: '✕' });
    close.onclick = function (e) { e.stopPropagation(); elLegend.remove(); elLegend = null; };
    elLegend.appendChild(close);
    elLegend.appendChild(h('h5', { text: 'Design mode' }));
    [
      'Select (V) — click to pick, drag to reposition (snaps to guides), handles to resize, arrows to nudge',
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
    [btnUndo, btnDiscard, btnSend, btnChanges].forEach(function (b) {
      if (!b) return;
      var off = count === 0;
      b.style.opacity = off ? '.4' : '';
      b.style.pointerEvents = off ? 'none' : 'auto';
    });
    if (btnRedo) {
      var noRedo = state.redo.length === 0;
      btnRedo.style.opacity = noRedo ? '.4' : '';
      btnRedo.style.pointerEvents = noRedo ? 'none' : 'auto';
    }
    if (elChanges && elChanges.style.display !== 'none') renderChanges();
  }

  // ---- changes panel (review / per-item revert / jump-to) ------------------
  // Human-friendly labels so the change list reads naturally.
  var PROP_LABEL = {
    'border-radius': 'Rounded corners', 'background': 'Background', 'background-color': 'Background',
    'background-image': 'Background', 'color': 'Text colour', 'font-size': 'Font size', 'font-weight': 'Font weight',
    'font-style': 'Font style', 'line-height': 'Line height', 'letter-spacing': 'Letter spacing',
    'text-align': 'Alignment', 'text-transform': 'Text case', 'text-decoration': 'Text decoration',
    'opacity': 'Opacity', 'box-shadow': 'Shadow', 'padding': 'Padding', 'margin': 'Margin', 'border': 'Border',
    'border-color': 'Border colour', 'border-width': 'Border width', 'width': 'Width', 'height': 'Height',
    'min-width': 'Min width', 'max-width': 'Max width', 'display': 'Display', 'gap': 'Gap'
  };
  function humanProp(p) { return PROP_LABEL[p] || (p ? p.replace(/-/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }) : 'Style'); }
  function chartDiff(c) {
    try {
      var a = c.before || {}, b = c.after || {}, parts = [];
      for (var k in b) { if (typeof b[k] !== 'object' && JSON.stringify(a[k]) !== JSON.stringify(b[k])) parts.push(k + ' → ' + b[k]); }
      return parts.length ? parts.slice(0, 2).join(', ') : 'spec updated';
    } catch (e) { return 'spec updated'; }
  }
  // The human action a change performed (the row's title).
  function changeAction(c) {
    switch (c.kind) {
      case 'style': return humanProp(c.property) + (c.to != null && c.to !== '' ? ' → ' + c.to : ' changed');
      case 'resize': return 'Resized to ' + (c.to || '');
      case 'move': return 'Moved ' + (c.to || 'to a new spot');
      case 'text': return 'Text → “' + (c.to || '') + '”';
      case 'remove': return 'Removed';
      case 'comment': return 'Note: ' + (c.note || '(none)');
      case 'annotation': return 'Sketch' + (c.property ? ' (' + c.property + ')' : '');
      case 'insert': return 'Added a component';
      case 'chart': return 'Chart · ' + chartDiff(c);
      default: return c.property || c.kind;
    }
  }
  // A friendly label for the element a change touched (the row's subtitle).
  function changeTarget(c) {
    var el = c.el;
    if (!el || el.nodeType !== 1) return c.kind === 'annotation' ? (c.region || 'preview') : '';
    var comp = componentHint(el);
    if (comp) return comp;
    var txt = shortText(el);
    if (txt) return '“' + txt + '”';
    var head = nearestHeading(el);
    if (head) return 'in “' + head + '”';
    var tag = el.tagName.toLowerCase();
    var cls = (typeof el.className === 'string' && el.className.trim()) ? '.' + el.className.trim().split(/\s+/)[0] : '';
    return tag + cls;
  }
  function toggleChanges() {
    if (!elChanges) return;
    if (elChanges.style.display === 'none') { renderChanges(); elChanges.style.display = 'flex'; }
    else elChanges.style.display = 'none';
  }
  function renderChanges() {
    if (!elChanges) return;
    elChanges.textContent = '';
    var head = h('div', { class: 'chg-head' }, [h('span', { text: 'Changes' })]);
    var close = h('button', { class: 'chg-x', text: '✕', title: 'Close' });
    close.onclick = function (e) { e.stopPropagation(); elChanges.style.display = 'none'; };
    head.appendChild(close);
    elChanges.appendChild(head);
    if (!state.changes.length) {
      elChanges.appendChild(h('div', { class: 'chg-empty', text: 'No changes yet.' }));
      return;
    }
    var listEl = h('div', { class: 'chg-list' });
    state.changes.forEach(function (c, i) {
      var row = h('div', { class: 'chg-row' });
      row.appendChild(h('span', { class: 'chg-n', text: String(i + 1) }));
      var main = h('div', { class: 'chg-main' });
      main.appendChild(h('div', { class: 'chg-title', text: changeAction(c) }));
      var sub = changeTarget(c);
      if (sub) main.appendChild(h('div', { class: 'chg-sub', text: sub }));
      row.appendChild(main);
      var rm = h('button', { class: 'chg-rm', text: '✕', title: 'Revert this change' });
      rm.onclick = function (e) { e.stopPropagation(); removeChange(c); };
      row.appendChild(rm);
      if (c.el || c.node) { row.onclick = function () { jumpToChange(c); }; row.style.cursor = 'pointer'; }
      listEl.appendChild(row);
    });
    elChanges.appendChild(listEl);
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
    if (!host || !root) return;
    if (studio && (studio.compare || studio.capture || state.tool === 'interact')) return;
    if (state.debugView) return; // overlays are hidden while the debug view is full-screen
    // hover (Select only, no active selection drag)
    if (state.tool === 'select' && state.hoverEl && state.hoverEl !== state.selected && !state.move && !state.resizing) {
      place(elHover, state.hoverEl);
      var hr = state.hoverEl.getBoundingClientRect();
      elLabel.style.display = 'block';
      elLabel.textContent = studio ? studioLabel(state.hoverEl) : state.hoverEl.tagName.toLowerCase() + ' · ' + Math.round(hr.width) + '×' + Math.round(hr.height);
      elLabel.style.left = hr.left + 'px';
      elLabel.style.top = Math.max(2, hr.top - 20) + 'px';
    } else { elHover.style.display = 'none'; elLabel.style.display = 'none'; }
    // selection — one box per selected element (primary a touch stronger); resize
    // handles + size badge only for a single selection (multi is style/AI-only in v1)
    var sel = (state.selection || []).filter(function (e) { return e && e.isConnected; });
    if (sel.length) {
      elSel.style.display = 'none';
      while (elSels.children.length < sel.length) elSels.appendChild(h('div', {}));
      while (elSels.children.length > sel.length) elSels.removeChild(elSels.lastChild);
      for (var si = 0; si < sel.length; si++) {
        var sr = sel[si].getBoundingClientRect(), sb = elSels.children[si];
        sb.className = 'box ' + (sel[si] === state.selected ? 'sel' : 'selm');
        sb.style.left = sr.left + 'px'; sb.style.top = sr.top + 'px';
        sb.style.width = sr.width + 'px'; sb.style.height = sr.height + 'px';
      }
      elSels.style.display = 'block';
      if (sel.length === 1 && !studio) { positionHandles(); positionBadges(); }
      else { elHandles.style.display = 'none'; elBadges.style.display = 'none'; }
    } else {
      elSel.style.display = 'none'; elSels.style.display = 'none';
      elHandles.style.display = 'none'; elBadges.style.display = 'none';
    }
    // comment pins track their anchor elements
    positionPins();
    if (!studio) positionMorphs();
    if (studio) studioPopupSync();
  }
  // Position an animated "transforming" overlay over each element currently being
  // restyled by AI (driven by the data-rayfin-editing marker), so several can
  // animate at once.
  function positionMorphs() {
    if (!elMorph) return;
    var busy = document.querySelectorAll('[data-rayfin-editing="1"]');
    while (elMorph.children.length < busy.length) elMorph.appendChild(h('div', { class: 'morph' }));
    while (elMorph.children.length > busy.length) elMorph.removeChild(elMorph.lastChild);
    for (var i = 0; i < busy.length; i++) {
      var mr = busy[i].getBoundingClientRect(), m = elMorph.children[i];
      m.style.left = mr.left + 'px'; m.style.top = mr.top + 'px';
      m.style.width = mr.width + 'px'; m.style.height = mr.height + 'px';
    }
    elMorph.style.display = busy.length ? 'block' : 'none';
  }

  // ---- selection -----------------------------------------------------------
  function select(el) {
    if (!el) return;
    if (state.editingText) commitText();
    state.selection = [el];
    state.selInlineMap = new WeakMap();
    state.selInlineMap.set(el, snapshotInline(el));
    state.selected = el;
    state.selInline = state.selInlineMap.get(el);
    showHandles();
    renderInspector();
    reposition();
  }
  // Shift/Ctrl/Cmd-click: add/remove `el` from the multi-selection (primary =
  // last touched). Edits then apply to every element in `state.selection`.
  function toggleSelect(el) {
    if (!el) return;
    if (state.editingText) commitText();
    if (!state.selection) state.selection = [];
    if (!state.selInlineMap) state.selInlineMap = new WeakMap();
    var i = state.selection.indexOf(el);
    if (i >= 0) {
      state.selection.splice(i, 1);
      if (state.selected === el) state.selected = state.selection[state.selection.length - 1] || null;
    } else {
      state.selection.push(el);
      state.selInlineMap.set(el, snapshotInline(el));
      state.selected = el;
    }
    if (!state.selection.length) { deselect(); return; }
    state.selInline = state.selInlineMap.get(state.selected) || snapshotInline(state.selected);
    showHandles();
    renderInspector();
    reposition();
  }
  function deselect() {
    state.selection = []; state.selected = null; state.selInline = null; state.selInlineMap = null;
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
    if (studio) { closeInspector(); return; }
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

    var multi = !!(state.selection && state.selection.length > 1);
    if (multi) body.appendChild(h('div', { class: 'insp-multi', text: state.selection.length + ' elements selected — edits apply to all' }));

    if (isPlaceholder(el)) body.appendChild(aiGroup(el));
    else body.appendChild(aiEditGroup(el));
    if (!multi && chartRoot(el)) body.appendChild(chartGroup(chartRoot(el)));

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
      multi ? null : textContentRow(el)
    ]));
    // Appearance
    body.appendChild(group('Appearance', [
      colorRow('Background', 'backgroundColor', cs.backgroundColor, el),
      numRow('Radius', 'borderRadius', px(cs.borderTopLeftRadius), 'px', el),
      textRow('Border', 'border', cs.borderWidth !== '0px' ? (cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor) : '', el),
      rangeRow('Opacity', 'opacity', parseFloat(cs.opacity), el)
    ]));

    var actions = h('div', { class: 'insp-actions' });
    var reset = h('button', { class: 'mini', text: multi ? 'Reset all' : 'Reset element' }); reset.onclick = function (e) { e.stopPropagation(); resetSelected(); };
    var rm = h('button', { class: 'mini danger', text: multi ? 'Remove all' : 'Remove' }); rm.onclick = function (e) { e.stopPropagation(); removeSelected(); };
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
    var models = [{ id: 'auto', name: 'Auto' }].concat(state.models && state.models.length ? state.models : []);
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

  // "Edit with AI" card shown atop any (non-placeholder) element's inspector:
  // describe a change + pick a model → the host restyles the element live via a
  // whitelisted inline-CSS patch (or a Graphein spec patch for charts), recorded
  // as revertable change-set entries just like manual edits.
  function aiEditGroup(el) {
    var card = h('div', { class: 'ai-card' });
    card.appendChild(h('h5', { text: 'Edit with AI' }));
    var busy = el.getAttribute('data-rayfin-editing') === '1';
    var chart = !!chartRoot(el);
    var box = h('div', { class: 'ai-box' });
    var ta = h('textarea', {
      placeholder: chart
        ? 'Describe a chart change — e.g. “make it a horizontal bar sorted descending”'
        : 'Describe a change — e.g. “make this a pill button with a subtle shadow”',
      text: el.getAttribute('data-rayfin-edit-desc') || ''
    });
    // Persist the prompt on the element so a failed edit keeps it for tweaking
    // (cleared on a successful apply).
    ta.oninput = function () { el.setAttribute('data-rayfin-edit-desc', ta.value); };
    box.appendChild(ta);
    var foot = h('div', { class: 'ai-foot' });
    var sel = h('select', { class: 'ai-model', title: 'Model' });
    var models = [{ id: 'auto', name: 'Auto' }].concat(state.models && state.models.length ? state.models : []);
    models.forEach(function (m) {
      var o = h('option', { value: m.id, text: m.name });
      if (m.id === state.aiModel) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    sel.onchange = function () { state.aiModel = sel.value; };
    if (busy) sel.disabled = true;
    foot.appendChild(sel);
    var btn = h('button', { class: 'ai-btn' + (busy ? ' busy' : ''), text: busy ? 'Applying…' : 'Apply' });
    btn.onclick = function (e) { e.stopPropagation(); requestAiEditSelection(ta.value); };
    foot.appendChild(btn);
    box.appendChild(foot);
    card.appendChild(box);
    card.appendChild(h('div', { class: 'ai-note', text: 'Applied live as editable, revertable tweaks.' }));
    return card;
  }

  // Apply an inline style change + record it (revert restores the pre-select
  // inline value snapshot for that property).
  function applyStyle(el, jsProp, cssLabel, value, display) {
    el.style[jsProp] = value;
    // Placeholders are captured wholesale by their single 'insert' entry (live
    // size/label/position read at hand-off), so don't record per-property edits.
    if (isPlaceholder(el)) return;
    var snap = (state.selInlineMap && state.selInlineMap.get(el)) || state.selInline || {};
    var before = snap[jsProp];
    record({
      kind: 'style', property: cssLabel, selector: cssPath(el), label: describe(el), el: el,
      from: undefined, to: display != null ? display : value,
      revert: function () { el.style[jsProp] = before; },
      reapply: function () { el.style[jsProp] = value; }
    });
  }
  // Apply a style change to EVERY selected element (multi-select); each is its own
  // revertable change-set entry.
  function editSelection(jsProp, cssLabel, value, display) {
    var sel = (state.selection && state.selection.length) ? state.selection.slice() : (state.selected ? [state.selected] : []);
    sel.forEach(function (el) { applyStyle(el, jsProp, cssLabel, value, display); });
  }

  function numRow(label, jsProp, val, unit, el) {
    var inp = h('input', { type: 'number', value: String(val) });
    inp.oninput = function () { editSelection(jsProp, cssName(jsProp), inp.value === '' ? '' : (inp.value + unit), inp.value + unit); };
    return h('div', { class: 'row' }, [h('label', { text: label }), h('div', { class: 'ctl' }, [inp, h('span', { class: 'insp-sz', text: unit })])]);
  }
  function selRow(label, jsProp, opts, cur, el) {
    var sel = h('select');
    opts.forEach(function (o) { var op = h('option', { value: o, text: o }); if (String(o) === String(cur)) op.setAttribute('selected', 'selected'); sel.appendChild(op); });
    sel.onchange = function () { editSelection(jsProp, cssName(jsProp), sel.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), sel]);
  }
  function colorRow(label, jsProp, cur, el) {
    var inp = h('input', { type: 'color', value: rgbToHex(cur) });
    inp.oninput = function () { editSelection(jsProp, cssName(jsProp), inp.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), inp]);
  }
  function rangeRow(label, jsProp, cur, el) {
    var inp = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(isNaN(cur) ? 1 : cur) });
    inp.oninput = function () { editSelection(jsProp, cssName(jsProp), inp.value); };
    return h('div', { class: 'row' }, [h('label', { text: label }), inp]);
  }
  function textRow(label, jsProp, cur, el) {
    var inp = h('input', { type: 'text', value: cur || '' });
    inp.onchange = function () { editSelection(jsProp, cssName(jsProp), inp.value); };
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
      var afterHtml = el.innerHTML;
      record({
        kind: 'text', property: 'text', selector: cssPath(el), label: describe(el), el: el,
        from: fromTxt, to: ta.value.trim(),
        revert: function () { el.innerHTML = beforeHtml; },
        reapply: function () { el.innerHTML = afterHtml; }
      });
      reposition();
    };
    return h('div', { class: 'row', style: 'display:block' }, [h('label', { text: 'Content' }), ta]);
  }
  function cssName(jsProp) { return jsProp.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }); }

  // ---- chart type conversion -----------------------------------------------
  // The Type dropdown lists every visual type and lets the user switch between
  // them with a *smart* conversion: the current spec's encoding is normalized
  // into abstract roles (categories / measures / series / …) and re-emitted in
  // the target type's own channel names, so shape-compatible charts convert
  // (bar↔pie↔funnel↔treemap↔waterfall, chart→kpi/table, …) instead of breaking.
  // Targets whose required roles can't be satisfied are greyed out with a reason.
  // The helpers are pure (no DOM / no mutation) so they're unit-testable.

  // BaseSpec-level props safe to carry across a type change (structural /
  // encoding props are always rebuilt from the normalized shape).
  var CONVERT_CARRY = ['data', 'transform', 'theme', 'palette', 'title', 'description', 'legend', 'tooltip', 'animation', 'padding', 'background', 'sketch', 'dimensions', 'params', 'highlight', 'filter'];

  function cloneVal(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
  function asField(v) {
    if (v == null) return null;
    if (typeof v === 'string') return { field: v };
    if (typeof v === 'object' && v.field) return { field: v.field, type: v.type, aggregate: v.aggregate, title: v.title };
    return null;
  }
  function isMeasureField(f) { return !!(f && (f.type === 'quantitative' || f.aggregate)); }
  function isTemporalField(f) { return !!(f && f.type === 'temporal'); }

  // Normalize any chart spec into abstract roles used for convertibility + remap.
  function shapeOf(spec) {
    var t = spec && spec.type;
    var enc = (spec && spec.encoding) || {};
    var dims = [], measures = [], roles = {};
    function dim(f) { if (f) dims.push(f); }
    function meas(f) { if (f) measures.push(f); }
    var x = asField(enc.x), y = asField(enc.y), color = asField(enc.color), series = asField(enc.series),
      theta = asField(enc.theta), value = asField(enc.value), stage = asField(enc.stage),
      source = asField(enc.source), target = asField(enc.target), key = asField(enc.key),
      size = asField(enc.size), category = asField(enc.category), group = asField(enc.group),
      date = asField(enc.date);
    switch (t) {
      case 'bar': case 'line': case 'area': case 'box':
        dim(x); meas(y);
        if (series) { roles.series = series; dim(series); }
        if (isTemporalField(x)) roles.date = x;
        break;
      case 'scatter':
        if (isMeasureField(x)) meas(x); else dim(x);
        meas(y); if (size) meas(size);
        if (isTemporalField(x)) roles.date = x;
        break;
      case 'histogram':
        meas(x || y);
        break;
      case 'combo':
        dim(x); if (isTemporalField(x)) roles.date = x;
        var layers = spec.layers || [];
        for (var li = 0; li < layers.length; li++) { var ly = asField(layers[li] && layers[li].encoding && layers[li].encoding.y); if (ly) meas(ly); }
        break;
      case 'pie':
        dim(color); meas(theta);
        break;
      case 'heatmap':
        dim(x); dim(y); meas(color);
        break;
      case 'funnel': case 'waterfall':
        dim(stage || x); meas(value || y);
        break;
      case 'treemap':
        dim(category || color); meas(value || theta);
        if (group) { roles.group = group; dim(group); }
        break;
      case 'slope':
        dim(x); meas(y); if (series) { roles.series = series; dim(series); }
        break;
      case 'dumbbell':
        dim(category || x); meas(value || y);
        if (group) { roles.group = group; dim(group); }
        break;
      case 'sankey':
        if (source) { roles.source = source; dim(source); }
        if (target) { roles.target = target; dim(target); }
        meas(value);
        break;
      case 'choropleth':
        if (key) { roles.geoKey = key; dim(key); }
        meas(color);
        roles.hasGeo = !!spec.geo;
        break;
      case 'calendarHeatmap':
        if (date) { roles.date = date; dim(date); }
        meas(color || value);
        break;
      case 'kpi': case 'gauge': case 'bullet':
        meas(asField(spec.value) || value || y);
        break;
      case 'table':
        var cols = spec.columns || [];
        for (var ci = 0; ci < cols.length; ci++) { var cf = asField(cols[ci]); if (!cf) continue; if (isMeasureField(cf)) meas(cf); else dim(cf); }
        break;
      case 'matrix':
        var rws = spec.rows || [];
        for (var ri = 0; ri < rws.length; ri++) dim(asField(rws[ri]));
        var vals = spec.values || [];
        for (var vi = 0; vi < vals.length; vi++) { var vv = vals[vi]; if (vv && vv.field) meas({ field: vv.field, aggregate: vv.op }); }
        break;
      default:
        dim(x); meas(y || value || theta);
    }
    dims = dims.filter(Boolean); measures = measures.filter(Boolean);
    return {
      type: t, dims: dims, measures: measures, roles: roles,
      dimCount: dims.length, measCount: measures.length,
      series: roles.series || null, group: roles.group || null,
      source: roles.source || null, target: roles.target || null,
      geoKey: roles.geoKey || null, date: roles.date || null, hasGeo: !!roles.hasGeo
    };
  }

  // Can `shape` become `target`? → { ok:true } or { ok:false, reason:'…' }.
  function canConvert(shape, target) {
    if (!shape || !target) return { ok: false, reason: '' };
    if (target === shape.type) return { ok: true };
    var d = shape.dimCount, m = shape.measCount;
    function need(cond, reason) { return cond ? { ok: true } : { ok: false, reason: reason }; }
    switch (target) {
      case 'bar': case 'line': case 'area': case 'box':
        return need(d >= 1 && m >= 1, 'needs a category and a value');
      case 'scatter':
        return need(m >= 1 && (d + m) >= 2, 'needs two numeric fields');
      case 'histogram':
        return need(m >= 1, 'needs a numeric field');
      case 'combo':
        return need(d >= 1 && m >= 1, 'needs a category and a value');
      case 'pie': case 'funnel': case 'waterfall': case 'treemap':
        return need(d >= 1 && m >= 1, 'needs a category and a value');
      case 'heatmap':
        return need(d >= 2 && m >= 1, 'needs two categories and a value');
      case 'slope':
        return need(m >= 1 && (!!shape.series || d >= 2), 'needs a series (or two categories)');
      case 'dumbbell':
        return need(m >= 1 && (!!shape.group || d >= 2), 'needs a group (or two categories)');
      case 'sankey':
        return need(m >= 1 && ((!!shape.source && !!shape.target) || d >= 2), 'needs source & target');
      case 'choropleth':
        return need(!!shape.hasGeo, 'needs map geometry');
      case 'calendarHeatmap':
        return need(m >= 1 && !!shape.date, 'needs a date field');
      case 'kpi': case 'gauge': case 'bullet':
        return need(m >= 1, 'needs a numeric value');
      case 'table':
        return need((d + m) >= 1, 'needs at least one field');
      case 'matrix':
        return need(d >= 1 && m >= 1, 'needs a category and a value');
    }
    return { ok: true };
  }

  // Pick a sensible full-scale for a gauge from the data when available (gauge
  // requires `max`); fall back to 100.
  function gaugeMax(spec, field) {
    var data = spec && spec.data;
    if (Array.isArray(data) && field) {
      var mx = null;
      for (var i = 0; i < data.length; i++) { var v = +(data[i] && data[i][field]); if (!isNaN(v)) mx = (mx == null ? v : Math.max(mx, v)); }
      if (mx != null && mx > 0) { var mag = Math.pow(10, Math.floor(Math.log(mx) / Math.LN10)); return Math.ceil((mx * 1.1) / mag) * mag; }
    }
    return 100;
  }

  // Produce a NEW spec of `target` type, remapping the source's roles into the
  // target's channel names. Pure (no mutation) so it's unit-testable.
  function convertSpec(spec, target) {
    var shape = shapeOf(spec);
    var out = {};
    for (var i = 0; i < CONVERT_CARRY.length; i++) { var k = CONVERT_CARRY[i]; if (spec[k] !== undefined) out[k] = cloneVal(spec[k]); }
    out.type = target;
    var dim0 = shape.dims[0], dim1 = shape.dims[1], meas0 = shape.measures[0], meas1 = shape.measures[1];
    var cat = dim0 ? dim0.field : (meas0 ? meas0.field : 'category');
    var cat2 = dim1 ? dim1.field : null;
    var measure = meas0 ? meas0.field : (dim0 ? dim0.field : 'value');
    var measure2 = meas1 ? meas1.field : null;
    var agg = (meas0 && meas0.aggregate) || 'sum';
    function F(field) { return { field: field }; }
    switch (target) {
      case 'bar': case 'line': case 'area': case 'box':
        out.encoding = { x: F(cat), y: F(measure) };
        if (shape.series) out.encoding.series = F(shape.series.field);
        break;
      case 'scatter':
        out.encoding = { x: F(measure2 || cat), y: F(measure) };
        break;
      case 'histogram':
        out.encoding = { x: F(measure) };
        break;
      case 'combo':
        out.encoding = { x: F(cat) };
        out.layers = [{ mark: 'bar', encoding: { y: F(measure) } }];
        if (measure2) out.layers.push({ mark: 'line', encoding: { y: F(measure2) }, axis: 'right' });
        break;
      case 'pie':
        out.encoding = { theta: F(measure), color: F(cat) };
        break;
      case 'funnel': case 'waterfall':
        out.encoding = { stage: F(cat), value: F(measure) };
        break;
      case 'treemap':
        out.encoding = { category: F(cat), value: F(measure) };
        if (shape.group) out.encoding.group = F(shape.group.field); else if (cat2) out.encoding.group = F(cat2);
        break;
      case 'heatmap':
        out.encoding = { x: F(cat), y: F(cat2 || cat), color: F(measure) };
        break;
      case 'slope':
        out.encoding = { x: F(cat), y: F(measure), series: F((shape.series && shape.series.field) || cat2 || cat) };
        break;
      case 'dumbbell':
        out.encoding = { category: F(cat), value: F(measure), group: F((shape.group && shape.group.field) || cat2 || cat) };
        break;
      case 'sankey':
        out.encoding = { source: F((shape.source && shape.source.field) || cat), target: F((shape.target && shape.target.field) || cat2 || cat), value: F(measure) };
        break;
      case 'choropleth':
        out.encoding = { key: F((shape.geoKey && shape.geoKey.field) || cat), color: F(measure) };
        if (spec.geo) out.geo = cloneVal(spec.geo);
        if (spec.featureId) out.featureId = spec.featureId;
        if (spec.projection) out.projection = spec.projection;
        break;
      case 'calendarHeatmap':
        out.encoding = { date: F((shape.date && shape.date.field) || cat), color: F(measure) };
        break;
      case 'kpi':
        out.value = { field: measure, aggregate: agg };
        if (meas0 && meas0.title) out.label = meas0.title;
        break;
      case 'gauge':
        out.value = { field: measure, aggregate: agg };
        out.max = gaugeMax(spec, measure);
        break;
      case 'bullet':
        out.value = { field: measure, aggregate: agg };
        break;
      case 'table':
        var tcols = shape.dims.concat(shape.measures).map(function (f) { var c = { field: f.field }; if (f.title) c.title = f.title; return c; });
        if (tcols.length) out.columns = tcols;
        break;
      case 'matrix':
        out.rows = [cat];
        out.values = [{ field: measure, op: agg }];
        if (cat2) out.columns = [cat2];
        break;
    }
    return out;
  }

  // Type row: <select> with per-family <optgroup>s; non-convertible targets are
  // disabled (greyed) with the reason appended. Choosing an enabled type applies
  // convertSpec through the recorded `apply()` (unlike debug, a type change is a
  // real, undoable edit that belongs in the change-set).
  function chartTypeRow(spec, apply) {
    var shape = shapeOf(spec);
    var sel = h('select');
    for (var gi = 0; gi < TYPE_GROUPS.length; gi++) {
      var og = h('optgroup'); og.setAttribute('label', TYPE_GROUPS[gi][0]);
      var list = TYPE_GROUPS[gi][1];
      for (var ti = 0; ti < list.length; ti++) {
        var ty = list[ti], res = canConvert(shape, ty), label = typeLabel(ty);
        if (!res.ok && res.reason) label += ' · ' + res.reason;
        var op = h('option', { value: ty, text: label });
        if (!res.ok) op.setAttribute('disabled', 'disabled');
        if (ty === spec.type) op.setAttribute('selected', 'selected');
        og.appendChild(op);
      }
      sel.appendChild(og);
    }
    sel.onchange = function () {
      var v = sel.value;
      if (v === spec.type) return;
      if (!canConvert(shape, v).ok) { sel.value = spec.type; return; }
      apply(function (s) {
        var conv = convertSpec(s, v), kk;
        for (kk in s) { if (Object.prototype.hasOwnProperty.call(s, kk)) delete s[kk]; }
        for (kk in conv) { if (Object.prototype.hasOwnProperty.call(conv, kk)) s[kk] = conv[kk]; }
      });
    };
    return h('div', { class: 'row' }, [h('label', { text: 'Type' }), sel]);
  }

  // ---- Graphein spec editor (inspector section) ----------------------------
  function chartGroup(chart) {
    var g = h('div', { class: 'grp' }, [h('h5', { text: 'Chart spec' })]);
    var spec = readSpec(chart);
    if (!spec) { g.appendChild(h('div', { class: 'insp-sz', text: 'Spec unavailable' })); return g; }
    var before = JSON.parse(JSON.stringify(spec));
    var beforeAttr = chart.getAttribute('data-graphein-spec');
    function apply(mut) {
      mut(spec); writeSpec(chart, spec);
      var afterAttr = chart.getAttribute('data-graphein-spec');
      record({
        kind: 'chart', property: 'spec', selector: cssPath(chart), label: describe(chart), el: chart,
        before: stripData(before), after: stripData(spec),
        revert: function () { if (beforeAttr != null) chart.setAttribute('data-graphein-spec', beforeAttr); },
        reapply: function () { if (afterAttr != null) chart.setAttribute('data-graphein-spec', afterAttr); }
      });
    }
    g.appendChild(chartTypeRow(spec, apply));
    var titleVal = (spec.title && typeof spec.title === 'object') ? (spec.title.text || '') : (spec.title || '');
    var ti = h('input', { type: 'text', value: titleVal });
    ti.oninput = function () { apply(function (s) { if (s.title && typeof s.title === 'object') s.title.text = ti.value; else s.title = ti.value; }); };
    g.appendChild(h('div', { class: 'row' }, [h('label', { text: 'Title' }), ti]));
    g.appendChild(gsel('Palette', PALETTES, typeof spec.palette === 'string' ? spec.palette : '', function (v) { apply(function (s) { s.palette = v; }); }));
    g.appendChild(gsel('Orient', ['vertical', 'horizontal'], spec.orientation || 'vertical', function (v) { apply(function (s) { s.orientation = v; }); }));
    g.appendChild(gsel('Sort', ['none', 'ascending', 'descending'], spec.sort || 'none', function (v) { apply(function (s) { s.sort = v; }); }));
    var curFmt = (spec.encoding && spec.encoding.y && spec.encoding.y.format) || '';
    g.appendChild(gselPairs('Value fmt', FORMATS, curFmt, function (v) { apply(function (s) { s.encoding = s.encoding || {}; s.encoding.y = s.encoding.y || {}; if (v) s.encoding.y.format = v; else delete s.encoding.y.format; }); }));
    // Transient full-screen Graphein debug inspection (never recorded / sent to chat).
    var dbgBtn = h('button', { class: 'gbtn', text: 'Open debug view' });
    dbgBtn.onclick = function (e) { e.stopPropagation(); enterDebugView(chart); };
    g.appendChild(h('div', { class: 'row' }, [h('label', { text: 'Debug' }), dbgBtn]));
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
    if (!state.selected || (state.selection && state.selection.length > 1)) { hideHandles(); return; }
    elHandles.textContent = ''; elHandles.style.display = 'block';
    HANDLE_DIRS.forEach(function (d) {
      var hd = h('div', { class: 'hnd' });
      hd.style.cursor = d[3];
      hd.addEventListener('pointerdown', function (e) { startResize(e, d); });
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

  // ---- smart guides (snap resized edges to sibling/parent edges + centers) --
  function collectSnapLines(el, exclude) {
    var xs = [], ys = [];
    function add(rect) { if (!rect) return; xs.push(rect.left, rect.right, (rect.left + rect.right) / 2); ys.push(rect.top, rect.bottom, (rect.top + rect.bottom) / 2); }
    var p = el.parentElement;
    if (p) add(p.getBoundingClientRect());
    var sibs = p ? p.children : [];
    for (var i = 0; i < sibs.length; i++) { if (sibs[i] !== el && !isOurs(sibs[i]) && !(exclude && exclude.indexOf(sibs[i]) >= 0)) add(sibs[i].getBoundingClientRect()); }
    return { xs: xs, ys: ys };
  }
  function nearestLine(val, lines, thr) {
    var best = null, bd = thr;
    for (var i = 0; i < lines.length; i++) { var d = Math.abs(lines[i] - val); if (d < bd) { bd = d; best = lines[i]; } }
    return best;
  }
  function clearGuides() { if (elGuides) elGuides.textContent = ''; }
  function drawGuides(guides) {
    if (!elGuides) return;
    elGuides.textContent = '';
    for (var i = 0; i < guides.length; i++) {
      var gd = guides[i], line = h('div', { class: 'guide' + (gd.x != null ? ' v' : ' hz') });
      if (gd.x != null) line.style.left = Math.round(gd.x) + 'px';
      else line.style.top = Math.round(gd.y) + 'px';
      elGuides.appendChild(line);
    }
  }
  function startResize(e, dir) {
    if (studio) { studioResizeDown(e, dir); return; }
    e.preventDefault(); e.stopPropagation();
    var el = state.selected; if (!el) return;
    var r = el.getBoundingClientRect();
    state.resizing = { el: el, dir: dir[0], startX: e.clientX, startY: e.clientY, w0: r.width, h0: r.height, left: r.left, top: r.top, from: Math.round(r.width) + '×' + Math.round(r.height), beforeW: el.style.width, beforeH: el.style.height, snapLines: collectSnapLines(el) };
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
    // Snap the moving edge(s) to nearby sibling/parent lines + draw guides.
    if (snapOn && !e.ctrlKey && !e.metaKey && g.snapLines) {
      var guides = [];
      if (g.dir.indexOf('e') >= 0) { var sx = nearestLine(g.left + w, g.snapLines.xs, SNAP_THR); if (sx != null) { w = sx - g.left; guides.push({ x: sx }); } }
      if (g.dir.indexOf('s') >= 0) { var sy = nearestLine(g.top + ht, g.snapLines.ys, SNAP_THR); if (sy != null) { ht = sy - g.top; guides.push({ y: sy }); } }
      drawGuides(guides);
    } else clearGuides();
    g.el.style.width = Math.max(8, Math.round(w)) + 'px';
    g.el.style.height = Math.max(8, Math.round(ht)) + 'px';
    reposition();
  }
  function onResizeUp() {
    var g = state.resizing; if (!g) return;
    window.removeEventListener('pointermove', onResizeMove, true);
    window.removeEventListener('pointerup', onResizeUp, true);
    clearGuides();
    var r = g.el.getBoundingClientRect();
    if (isPlaceholder(g.el)) { state.resizing = null; renderInspector(); return; } // size captured by the insert entry
    var afterW = g.el.style.width, afterH = g.el.style.height;
    record({ kind: 'resize', property: 'size', selector: cssPath(g.el), label: describe(g.el), el: g.el, from: g.from, to: Math.round(r.width) + '×' + Math.round(r.height), revert: function () { g.el.style.width = g.beforeW; g.el.style.height = g.beforeH; }, reapply: function () { g.el.style.width = afterW; g.el.style.height = afterH; } });
    state.resizing = null; renderInspector();
  }

  // ---- move (freeform drag: live translate + alignment guides) -------------
  // Dragging repositions the element(s) with a live `transform: translate()` that
  // follows the cursor and snaps to nearby sibling/parent edges + centers (shared
  // guide system; magnet toggle, Ctrl/Cmd bypasses). The offset is kept on release
  // and recorded as a revertable `move`; Esc (or disabling) restores it. A multi-
  // selection drags every selected element by the same delta (snapping on the
  // grabbed one). A plain click (no drag) on a child drills in.
  function parseTranslate(t) { var m = /translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)/.exec(t || ''); return m ? { x: Math.round(parseFloat(m[1])), y: Math.round(parseFloat(m[2])) } : { x: 0, y: 0 }; }
  function stripTranslate(t) { return (t || '').replace(/translate\([^)]*\)/, '').replace(/\s{2,}/g, ' ').trim(); }
  function beginPendingMove(e, anchorEl, downTarget) {
    var sel = (state.selection && state.selection.length) ? state.selection.filter(function (x) { return x && x.isConnected; }) : [];
    if (sel.indexOf(anchorEl) < 0) sel = [anchorEl]; // grabbed outside the selection → move just it
    var items = sel.map(function (x) {
      var t0 = parseTranslate(x.style.transform);
      return { el: x, baseNoT: stripTranslate(x.style.transform), cx0: t0.x, cy0: t0.y, origTransform: x.style.transform, oOpacity: x.style.opacity, oShadow: x.style.boxShadow, oTransition: x.style.transition };
    });
    state.move = {
      el: anchorEl, items: items, anchor: null, downTarget: downTarget,
      startX: e.clientX, startY: e.clientY, active: false, dx: 0, dy: 0, note: '',
      startRect: anchorEl.getBoundingClientRect(), snapLines: collectSnapLines(anchorEl, sel)
    };
    for (var i = 0; i < items.length; i++) if (items[i].el === anchorEl) state.move.anchor = items[i];
    window.addEventListener('pointermove', onMoveMove, true);
    window.addEventListener('pointerup', onMoveUp, true);
  }
  function liftMove(g) {
    for (var i = 0; i < g.items.length; i++) {
      var el = g.items[i].el;
      el.style.transition = 'box-shadow .15s ease, opacity .15s ease';
      el.style.opacity = '0.85';
      el.style.boxShadow = '0 10px 28px -8px rgba(0,0,0,.45), 0 0 0 1px ' + TEAL + '99';
    }
  }
  function endMoveVisuals(g) {
    for (var i = 0; i < g.items.length; i++) {
      var it = g.items[i];
      it.el.style.opacity = it.oOpacity || ''; it.el.style.boxShadow = it.oShadow || ''; it.el.style.transition = it.oTransition || '';
    }
    clearGuides();
    if (elMoveTip) elMoveTip.style.display = 'none';
  }
  function applyMoveTransform(g) {
    for (var i = 0; i < g.items.length; i++) {
      var it = g.items[i];
      it.el.style.transform = (it.baseNoT ? it.baseNoT + ' ' : '') + 'translate(' + (it.cx0 + g.dx) + 'px, ' + (it.cy0 + g.dy) + 'px)';
    }
  }
  function showMoveTip(g) {
    if (!elMoveTip || !g.anchor) return;
    var r = g.el.getBoundingClientRect();
    elMoveTip.textContent = (g.anchor.cx0 + g.dx) + ', ' + (g.anchor.cy0 + g.dy) + ' px' + (g.note ? ' · ' + g.note : '');
    elMoveTip.style.left = clamp(r.left, 2, window.innerWidth - 130) + 'px';
    elMoveTip.style.top = clamp(r.top - 22, 2, window.innerHeight - 20) + 'px';
    elMoveTip.style.display = 'block';
  }
  function onMoveMove(e) {
    var g = state.move; if (!g || !state.enabled) return;
    if (e.buttons === 0) { onMoveUp(); return; }
    if (!g.active) {
      if (Math.abs(e.clientX - g.startX) < 4 && Math.abs(e.clientY - g.startY) < 4) return;
      g.active = true; liftMove(g);
      showHint('Drag to reposition · release to drop · Esc to cancel');
    }
    var dx = e.clientX - g.startX, dy = e.clientY - g.startY, note = '';
    // Snap the moving box's edges/centers to nearby lines + draw the guides.
    if (snapOn && !e.ctrlKey && !e.metaKey && g.snapLines) {
      var guides = [], r = g.startRect;
      var xC = [['left', r.left], ['right', r.right], ['center', (r.left + r.right) / 2]], bx = null;
      for (var xi = 0; xi < xC.length; xi++) { var lx = nearestLine(xC[xi][1] + dx, g.snapLines.xs, SNAP_THR); if (lx != null) { var dxd = Math.abs(lx - (xC[xi][1] + dx)); if (!bx || dxd < bx.d) bx = { adj: lx - (xC[xi][1] + dx), line: lx, label: xC[xi][0], d: dxd }; } }
      if (bx) { dx += bx.adj; guides.push({ x: bx.line }); note += bx.label; }
      var yC = [['top', r.top], ['bottom', r.bottom], ['middle', (r.top + r.bottom) / 2]], by = null;
      for (var yi = 0; yi < yC.length; yi++) { var ly = nearestLine(yC[yi][1] + dy, g.snapLines.ys, SNAP_THR); if (ly != null) { var dyd = Math.abs(ly - (yC[yi][1] + dy)); if (!by || dyd < by.d) by = { adj: ly - (yC[yi][1] + dy), line: ly, label: yC[yi][0], d: dyd }; } }
      if (by) { dy += by.adj; guides.push({ y: by.line }); note += (note ? '+' : '') + by.label; }
      drawGuides(guides);
    } else clearGuides();
    g.dx = Math.round(dx); g.dy = Math.round(dy); g.note = note;
    applyMoveTransform(g);
    reposition();
    showMoveTip(g);
  }
  function cancelMove() {
    var g = state.move; if (!g) return;
    window.removeEventListener('pointermove', onMoveMove, true);
    window.removeEventListener('pointerup', onMoveUp, true);
    if (g.active) { for (var i = 0; i < g.items.length; i++) g.items[i].el.style.transform = g.items[i].origTransform; endMoveVisuals(g); reposition(); }
    state.move = null;
  }
  function onMoveUp() {
    var g = state.move; if (!g) return;
    window.removeEventListener('pointermove', onMoveMove, true);
    window.removeEventListener('pointerup', onMoveUp, true);
    state.move = null;
    if (g.active) {
      endMoveVisuals(g);
      if (g.dx || g.dy) {
        for (var i = 0; i < g.items.length; i++) {
          if (isPlaceholder(g.items[i].el)) continue; // insert entry captures its live position
          (function (it) {
            var afterT = it.el.style.transform, beforeT = it.origTransform;
            record({
              kind: 'move', property: 'offset', selector: cssPath(it.el), label: describe(it.el), el: it.el,
              from: 'original position', to: (it.cx0 + g.dx) + ', ' + (it.cy0 + g.dy) + 'px' + (g.note ? ' (' + g.note + ' aligned)' : ''), after: afterT,
              revert: function () { it.el.style.transform = beforeT; },
              reapply: function () { it.el.style.transform = afterT; }
            });
          })(g.items[i]);
        }
        reposition();
      }
    } else if (g.downTarget && g.downTarget !== state.selected && !isOurs(g.downTarget) && g.downTarget.isConnected) {
      // A click (no drag) on a child of the selection drills in and selects it.
      select(chartRoot(g.downTarget) || g.downTarget);
    }
  }

  // ---- keyboard nudge ------------------------------------------------------
  function nudge(dx, dy) {
    var sel = (state.selection && state.selection.length) ? state.selection.slice() : (state.selected ? [state.selected] : []);
    sel.forEach(function (el) { nudgeOne(el, dx, dy); });
    reposition();
  }
  function nudgeOne(el, dx, dy) {
    if (!el) return;
    var snap = state.selInlineMap && state.selInlineMap.get(el);
    var before = snap ? snap.transform : el.style.transform;
    var m = /translate\((-?\d+)px,\s*(-?\d+)px\)/.exec(el.style.transform || '');
    var cx = m ? parseInt(m[1], 10) : 0, cy = m ? parseInt(m[2], 10) : 0;
    cx += dx; cy += dy;
    el.style.transform = (el.style.transform || '').replace(/translate\([^)]*\)/, '').trim() + ' translate(' + cx + 'px, ' + cy + 'px)';
    if (!isPlaceholder(el)) {
      var afterTransform = el.style.transform;
      record({
        kind: 'move', property: 'offset', selector: cssPath(el), label: describe(el), el: el,
        from: 'original position', to: cx + ', ' + cy + 'px',
        revert: function () { el.style.transform = before; },
        reapply: function () { el.style.transform = afterTransform; }
      });
    }
  }

  // ---- remove / reset / discard --------------------------------------------
  function removeSelected() {
    var sel = (state.selection && state.selection.length) ? state.selection.slice() : (state.selected ? [state.selected] : []);
    sel.forEach(function (el) {
      // Removing a placeholder deletes it entirely (undoes the insert).
      if (isPlaceholder(el)) { var ins = findInsertEntry(el); if (ins) removeEntry(ins); return; }
      var beforeDisplay = el.style.display;
      el.style.display = 'none';
      record({ kind: 'remove', property: 'display', selector: cssPath(el), label: describe(el), el: el, from: 'visible', to: 'removed', revert: function () { el.style.display = beforeDisplay; }, reapply: function () { el.style.display = 'none'; } });
    });
    deselect();
  }
  function resetSelected() {
    var sel = (state.selection && state.selection.length) ? state.selection.slice() : (state.selected ? [state.selected] : []);
    if (!sel.length) return;
    for (var i = state.changes.length - 1; i >= 0; i--) if (sel.indexOf(state.changes[i].el) >= 0) revertEntry(state.changes[i]);
    state.changes = state.changes.filter(function (c) { return sel.indexOf(c.el) < 0; });
    bump(); renderInspector(); reposition(); renderBar();
  }
  function discardAll() {
    if (state.editingText) commitText();
    for (var i = state.changes.length - 1; i >= 0; i--) revertEntry(state.changes[i]);
    state.changes = []; state.redo = [];
    deselect(); clearPins(); clearDrawings();
    if (elChanges) elChanges.style.display = 'none';
    bump(); reposition(); renderBar();
  }

  // ---- text edit (double-click quick path) ---------------------------------
  function startText(el) {
    if (studio) { studioStartText(el); return; }
    if (!el) return;
    state.editingText = { el: el, from: el.textContent || '', html: el.innerHTML };
    el.setAttribute('contenteditable', 'true'); el.classList.add('editing-text'); el.focus();
    showHint('Editing text — click away or Esc to finish');
  }
  function commitText() {
    if (studio) { studioFinishText(false); return; }
    var t = state.editingText; if (!t) return;
    state.editingText = null;
    var el = t.el; el.removeAttribute('contenteditable'); el.classList.remove('editing-text');
    // Placeholder label edits are captured by the insert entry (live text at
    // hand-off), so don't record a separate text change for them.
    if (!isPlaceholder(el) && (el.textContent || '') !== t.from) {
      var beforeHtml = t.html;
      var afterHtml = el.innerHTML;
      record({ kind: 'text', property: 'text', selector: cssPath(el), label: describe(el), el: el, from: t.from.trim(), to: (el.textContent || '').trim(), revert: function () { el.innerHTML = beforeHtml; }, reapply: function () { el.innerHTML = afterHtml; } });
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
      pin.textContent = entry.studio && studio ? String(Math.max(1, studio.history.findIndex(function (tx) { return tx.id === entry.transactionId; }) + 1)) : String(state.changes.indexOf(entry) + 1);
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
    if (studio) { studioDrawDown(e); return; }
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
    if (!ph || !desc) { showHint('Describe the component first', 'error'); return; }
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
    state.aiRequest = { id: id, description: desc, width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)), model: selectedModel() };
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
      showHint('Couldn’t generate — try a different description', 'error');
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

  // ---- Edit with AI: restyle any element -----------------------------------
  // CSS properties the controller will apply from a model restyle patch (mirrors
  // the Rust whitelist — defense-in-depth in case the contract drifts).
  var RESTYLE_ALLOWED = {
    'color': 1, 'background': 1, 'background-color': 1, 'background-image': 1, 'border': 1,
    'border-color': 1, 'border-width': 1, 'border-style': 1, 'border-radius': 1, 'padding': 1,
    'padding-top': 1, 'padding-right': 1, 'padding-bottom': 1, 'padding-left': 1, 'margin': 1,
    'margin-top': 1, 'margin-right': 1, 'margin-bottom': 1, 'margin-left': 1, 'font-size': 1,
    'font-weight': 1, 'font-style': 1, 'line-height': 1, 'letter-spacing': 1, 'text-align': 1,
    'text-transform': 1, 'text-decoration': 1, 'opacity': 1, 'box-shadow': 1, 'width': 1,
    'height': 1, 'min-width': 1, 'min-height': 1, 'max-width': 1, 'max-height': 1, 'display': 1,
    'gap': 1, 'align-items': 1, 'justify-content': 1, 'flex-direction': 1
  };
  // Current styles sent to the model as context (compact).
  var RESTYLE_SNAPSHOT = ['color', 'background-color', 'font-size', 'font-weight', 'line-height', 'text-align', 'padding', 'margin', 'border', 'border-radius', 'opacity', 'display', 'width', 'height'];

  function restyleContext(el) {
    var cs = getComputedStyle(el), styles = {};
    for (var i = 0; i < RESTYLE_SNAPSHOT.length; i++) {
      var p = RESTYLE_SNAPSHOT[i], v = cs.getPropertyValue(p);
      if (v) styles[p] = v.trim();
    }
    var chart = chartRoot(el);
    // Notable descendants the model can target via `rules` (headings, buttons,
    // text, media, or anything with a class) — capped + compact.
    var children = [];
    if (!chart) {
      var kids = el.querySelectorAll('*');
      for (var ki = 0; ki < kids.length && children.length < 40; ki++) {
        var k = kids[ki];
        if (isOurs(k) || !k.tagName) continue;
        var ktag = k.tagName.toLowerCase();
        if (ktag === 'script' || ktag === 'style') continue;
        var hasClass = typeof k.className === 'string' && k.className.trim();
        var notable = /^(h[1-6]|button|a|p|span|label|input|textarea|img|svg|li|th|td|strong|em|small)$/.test(ktag) || hasClass;
        if (!notable) continue;
        children.push({ tag: ktag, classes: hasClass ? k.className.trim() : undefined, text: shortText(k) || undefined });
      }
    }
    return {
      tag: el.tagName.toLowerCase(),
      text: shortText(el) || undefined,
      classes: (typeof el.className === 'string' && el.className.trim()) ? el.className.trim() : undefined,
      component: componentHint(el) || undefined,
      styles: styles,
      isChart: !!chart,
      chartType: chart ? (chart.getAttribute('data-graphein-type') || undefined) : undefined,
      spec: chart ? stripData(readSpec(chart)) : undefined,
      children: children.length ? children : undefined
    };
  }
  var editSeq = 0;
  function editElById(id) { try { return document.querySelector('[data-rayfin-edit-id="' + id + '"]'); } catch (e) { return null; } }

  // Queue an "Edit with AI" request for the host poll (drainAiEdit →
  // restyleElement → applyRestyle). Tags the element with a stable id and a busy
  // marker so the card shows "Applying…" and we can target it when the patch lands.
  function requestAiEdit(el, description) {
    var desc = (description || '').trim();
    if (!el || !desc) { showHint('Describe the change first', 'error'); return; }
    if (el.getAttribute('data-rayfin-editing') === '1') return;
    var id = el.getAttribute('data-rayfin-edit-id');
    if (!id) { id = 'e' + (++editSeq) + '_' + Date.now(); el.setAttribute('data-rayfin-edit-id', id); }
    el.setAttribute('data-rayfin-editing', '1');
    state.aiEditQueue.push({ id: id, description: desc, model: selectedModel(), context: restyleContext(el) });
    bump();
    if (state.selected === el) renderInspector();
  }
  // Enqueue an "Edit with AI" for the current selection. For a multi-selection we
  // send ONE request (the primary's context) and apply the resulting patch to
  // EVERY selected element, so "make them the same X" is consistent (independent
  // per-element requests can't agree on "the same"). All selected elements animate.
  function requestAiEditSelection(description) {
    var desc = (description || '').trim();
    if (!desc) { showHint('Describe the change first', 'error'); return; }
    var sel = (state.selection && state.selection.length) ? state.selection.slice() : (state.selected ? [state.selected] : []);
    sel = sel.filter(function (el) { return el && el.isConnected && el.getAttribute('data-rayfin-editing') !== '1'; });
    if (!sel.length) return;
    var ids = [];
    sel.forEach(function (el) {
      var id = el.getAttribute('data-rayfin-edit-id');
      if (!id) { id = 'e' + (++editSeq) + '_' + Date.now() + '_' + ids.length; el.setAttribute('data-rayfin-edit-id', id); }
      el.setAttribute('data-rayfin-editing', '1');
      ids.push(id);
    });
    var primary = (state.selected && sel.indexOf(state.selected) >= 0) ? state.selected : sel[0];
    state.aiEditQueue.push({ id: ids[0], ids: ids, description: desc, model: selectedModel(), context: restyleContext(primary) });
    bump();
    renderInspector();
  }

  // Apply one whitelisted inline-style change to `el` and record it (revert
  // restores the element's pre-edit inline value). Independent of the current
  // selection so it stays correct if the user re-selected during generation.
  function applyRestyleStyle(el, cssProp, jsProp, value) {
    var before = el.style[jsProp];
    el.style[jsProp] = value;
    record({
      kind: 'style', property: cssProp, selector: cssPath(el), label: describe(el), el: el,
      from: undefined, to: value,
      revert: function () { el.style[jsProp] = before; },
      reapply: function () { el.style[jsProp] = value; }
    });
  }
  function deepMerge(t, s) {
    for (var k in s) {
      if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) deepMerge(t[k], s[k]);
      else t[k] = s[k];
    }
    return t;
  }
  function applyChartPatch(chart, patch) {
    var spec = readSpec(chart);
    if (!spec || !patch || typeof patch !== 'object') return;
    var before = JSON.parse(JSON.stringify(spec));
    var beforeAttr = chart.getAttribute('data-graphein-spec');
    var p = {}; for (var k in patch) if (k !== 'data') p[k] = patch[k];
    deepMerge(spec, p); writeSpec(chart, spec);
    var afterAttr = chart.getAttribute('data-graphein-spec');
    record({
      kind: 'chart', property: 'spec', selector: cssPath(chart), label: describe(chart), el: chart,
      before: stripData(before), after: stripData(spec),
      revert: function () { if (beforeAttr != null) chart.setAttribute('data-graphein-spec', beforeAttr); },
      reapply: function () { if (afterAttr != null) chart.setAttribute('data-graphein-spec', afterAttr); }
    });
  }

  // Apply the model's restyle patch (whitelisted inline CSS + optional Graphein
  // spec patch) to the tagged element as revertable change-set entries. An empty
  // patch (failure) just clears the busy state.
  function applyRestyle(id, patch) {
    var el = editElById(id);
    if (!el) return;
    el.removeAttribute('data-rayfin-editing');
    var applied = 0, styles = patch && patch.styles;
    if (styles) {
      for (var cssProp in styles) {
        var key = String(cssProp).toLowerCase();
        if (!RESTYLE_ALLOWED[key]) continue;
        var val = String(styles[cssProp]); if (!val) continue;
        var jsProp = key.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
        applyRestyleStyle(el, key, jsProp, val); applied++;
      }
    }
    if (patch && patch.graphein && chartRoot(el)) { applyChartPatch(chartRoot(el), patch.graphein); applied++; }
    // Descendant rules — apply whitelisted styles to elements matching each
    // (element-relative) selector inside the selection, capped for safety.
    if (patch && patch.rules && patch.rules.length) {
      for (var ri = 0; ri < patch.rules.length; ri++) {
        var rule = patch.rules[ri];
        if (!rule || !rule.selector || !rule.styles) continue;
        var targets;
        try { targets = el.querySelectorAll(rule.selector); } catch (e) { continue; }
        for (var ti = 0; ti < targets.length && ti < 60; ti++) {
          var tEl = targets[ti];
          if (isOurs(tEl)) continue;
          for (var rp in rule.styles) {
            var rk = String(rp).toLowerCase();
            if (!RESTYLE_ALLOWED[rk]) continue;
            var rv = String(rule.styles[rp]); if (!rv) continue;
            applyRestyleStyle(tEl, rk, rk.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }), rv);
            applied++;
          }
        }
      }
    }
    if (!applied) showHint('Couldn’t apply the change — try rephrasing', 'error');
    else el.removeAttribute('data-rayfin-edit-desc'); // success → clear the saved prompt
    if (state.selected === el) renderInspector();
    reposition(); bump();
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

  // Neutralize design-only visuals before the "Send to chat" screenshot so the
  // agent reads the real result, not our tooling chrome. We hide the changes
  // panel, guides and morph overlays, and make inserted placeholders' dashed
  // "drop-zone" border + tint transparent (kept in the layout, generated content
  // left visible). We deliberately draw NO numbered markers over the design —
  // they read as UI badges to the agent; the change-set below carries each item's
  // selector/text/component for source mapping instead. User annotations that ARE
  // meant for the agent (comment pins, sketches) are left in. Restored on drain.
  function stripCaptureAffordances() {
    if (elChanges) elChanges.style.display = 'none';
    clearGuides();
    if (elMorph) { elMorph.textContent = ''; elMorph.style.display = 'none'; }
    try {
      var phs = document.querySelectorAll('[data-rayfin-placeholder="1"]');
      for (var i = 0; i < phs.length; i++) {
        var ph = phs[i];
        if (ph.getAttribute('data-rayfin-ph-restore') == null) ph.setAttribute('data-rayfin-ph-restore', ph.getAttribute('style') || '');
        ph.style.borderColor = 'transparent';
        ph.style.background = 'transparent';
        ph.style.boxShadow = 'none';
        // Not-yet-generated placeholders only hold our teal "New component" hint
        // (no real element children) — hide that text too so it isn't captured.
        if (!ph.querySelector('*')) ph.style.color = 'transparent';
      }
    } catch (e) {}
  }
  function restoreCaptureAffordances() {
    try {
      var phs = document.querySelectorAll('[data-rayfin-ph-restore]');
      for (var i = 0; i < phs.length; i++) {
        var ph = phs[i], s = ph.getAttribute('data-rayfin-ph-restore');
        ph.removeAttribute('data-rayfin-ph-restore');
        if (s != null) ph.setAttribute('style', s);
      }
    } catch (e) {}
  }

  function beginHandoff() {
    if (state.changes.length === 0) return;
    if (state.editingText) commitText();
    closeCommentEditor(); deselect();
    state.hoverEl = null;
    elHover.style.display = 'none'; elLabel.style.display = 'none';
    elToolbar.style.display = 'none'; elInspector.style.display = 'none';
    if (elLegend) elLegend.style.display = 'none';
    stripCaptureAffordances(); // keep the screenshot to the clean design result
    state.handoff = { instruction: composeInstruction(), changeCount: state.changes.length };
    bump();
  }

  // ---- debug view (transient full-screen Graphein inspection) --------------
  // Graphein 0.17+ replaces a chart with a multi-panel diagnostic when
  // `debug:true` is set on its spec. We flip that flag on the selected chart
  // WITHOUT recording it (so it never enters the change-set / "Send to chat"),
  // blow the chart up to fill the viewport so every panel is readable, and
  // revert cleanly on Esc / close / when design mode is disabled.
  function inDebug(node) { var dv = state.debugView; if (!dv) return false; var t = dv.target || dv.el; return !!(t && (node === t || (t.contains && t.contains(node)))); }
  function hideChromeForDebug() {
    if (!root) return;
    state.hoverEl = null;
    [elHover, elLabel, elSel, elSels, elBadges, elHandles, elMorph, elToolbar, elInspector, elChanges].forEach(function (n) { if (n) n.style.display = 'none'; });
    if (elLegend) elLegend.style.display = 'none';
    clearGuides();
  }
  function showDebugBar() {
    if (!root) return;
    if (state.debugBar) { state.debugBar.style.display = 'flex'; return; }
    var bar = h('div', { class: 'dbgbar' });
    bar.appendChild(h('span', { class: 'dbgbar-t', text: 'Debug view' }));
    var x = h('button', { class: 'dbgbar-x', text: 'Exit (Esc)' });
    x.onclick = function (e) { e.stopPropagation(); e.preventDefault(); exitDebugView(); };
    bar.appendChild(x);
    root.appendChild(bar);
    state.debugBar = bar;
  }
  function hideDebugBar() { if (state.debugBar) { try { state.debugBar.remove(); } catch (e) {} state.debugBar = null; } }

  // Ancestor properties that establish a containing block for position:fixed
  // (so the fullscreen chart would be trapped inside them) — cleared while in
  // debug and restored on exit. will-change → 'auto', everything else → 'none'.
  var DEBUG_NEUTRALIZE = { transform: 'none', perspective: 'none', filter: 'none', 'backdrop-filter': 'none', '-webkit-backdrop-filter': 'none', 'will-change': 'auto', contain: 'none' };
  var DEBUG_FS = { position: 'fixed', left: '0', top: '0', right: '0', bottom: '0', width: '100vw', height: '100vh', 'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0', margin: '0', padding: '0', 'box-sizing': 'border-box', 'z-index': '2147483630', background: PANEL_BG, overflow: 'auto', 'border-radius': '0', transform: 'none', perspective: 'none', filter: 'none', 'backdrop-filter': 'none', '-webkit-backdrop-filter': 'none', 'will-change': 'auto', contain: 'none' };
  function enterDebugView(chart) {
    if (!chart || state.debugView) return;
    var spec = readSpec(chart);
    if (!spec) return;
    if (state.editingText) commitText();
    if (state.selected) deselect();
    // Graphein sizes the chart from resolveSize(container), where container is the
    // PARENT of the element carrying data-graphein-spec (surface.root). So we blow up
    // that parent — not the root itself — otherwise the diagnostic overlay stays
    // pinned to the chart's original size and only the top-left corner fills.
    var target = (chart.parentElement && chart.parentElement.nodeType === 1) ? chart.parentElement : chart;
    var dv = { el: chart, target: target, prevSpecAttr: chart.getAttribute('data-graphein-spec'), prevTargetStyle: target.getAttribute('style'), neutralized: [] };
    // Clear containing-block props on the target's ancestors so its position:fixed is
    // viewport-relative (a transformed/filtered/contained ancestor would trap it).
    var n = target.parentElement, guard = 0, p;
    while (n && n.nodeType === 1 && guard < 300) {
      var cs = null; try { cs = getComputedStyle(n); } catch (e) {}
      if (cs && ((cs.transform && cs.transform !== 'none') || (cs.perspective && cs.perspective !== 'none') || (cs.filter && cs.filter !== 'none') || (cs.backdropFilter && cs.backdropFilter !== 'none') || (cs.willChange && cs.willChange.indexOf('transform') >= 0) || (cs.contain && /paint|layout|strict|content/.test(cs.contain)))) {
        dv.neutralized.push({ el: n, style: n.getAttribute('style') });
        for (p in DEBUG_NEUTRALIZE) { try { n.style.setProperty(p, DEBUG_NEUTRALIZE[p], 'important'); } catch (e) {} }
      }
      n = n.parentElement; guard++;
    }
    for (p in DEBUG_FS) { try { target.style.setProperty(p, DEBUG_FS[p], 'important'); } catch (e) {} }
    // Flip debug on WITHOUT recording; drop any authored width/height so the view
    // fills the now-fullscreen container rather than the chart's fixed dimensions.
    var dbgSpec = cloneVal(spec); dbgSpec.debug = true;
    if (dbgSpec.dimensions && typeof dbgSpec.dimensions === 'object') { try { delete dbgSpec.dimensions.width; delete dbgSpec.dimensions.height; } catch (e) {} }
    writeSpec(chart, dbgSpec);
    state.debugView = dv;
    hideChromeForDebug();
    showDebugBar();
  }
  function exitDebugView() {
    var dv = state.debugView;
    if (!dv) return;
    state.debugView = null;
    // Revert the spec (drops debug + restores authored dimensions) → the chart re-renders.
    try { if (dv.prevSpecAttr != null) dv.el.setAttribute('data-graphein-spec', dv.prevSpecAttr); else dv.el.removeAttribute('data-graphein-spec'); } catch (e) {}
    // Restore the fullscreen target's inline style, then any neutralized ancestors.
    try { if (dv.prevTargetStyle != null) dv.target.setAttribute('style', dv.prevTargetStyle); else dv.target.removeAttribute('style'); } catch (e) {}
    for (var i = 0; i < dv.neutralized.length; i++) { var it = dv.neutralized[i]; try { if (it.style != null) it.el.setAttribute('style', it.style); else it.el.removeAttribute('style'); } catch (e) {} }
    hideDebugBar();
    if (root && state.enabled) {
      if (elToolbar && !studio) elToolbar.style.display = 'flex';
      if (elLegend && !studio) elLegend.style.display = '';
      renderBar();
      if (dv.el && dv.el.isConnected) select(dv.el);
    }
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
    lines.push('I made these visual tweaks directly in the live preview — the attached screenshot shows the intended result. Please apply the equivalent changes to the app’s source (use each item’s `context`/selector in the change-set below to locate the element):');
    lines.push('');
    for (var i = 0; i < state.changes.length; i++) {
      var c = state.changes[i], n = (i + 1) + '. ';
      if (c.kind === 'chart') lines.push(n + c.label + ' — update the Graphein spec (before→after in the JSON below).');
      else if (c.kind === 'move') lines.push(n + c.label + ' — reposition it to a translate offset of ' + c.to + ' from its natural layout position.');
      else if (c.kind === 'text') lines.push(n + c.label + ' — change text from “' + c.from + '” to “' + c.to + '”.');
      else if (c.kind === 'resize') lines.push(n + c.label + ' — resize from ' + c.from + ' to ' + c.to + ' px.');
      else if (c.kind === 'remove') lines.push(n + c.label + ' — remove this element.');
      else if (c.kind === 'comment') lines.push(n + 'Note on ' + c.label + ': ' + (c.note || '(no text)'));
      else if (c.kind === 'annotation') lines.push(n + 'Sketch (' + c.property + ') ' + (c.region ? 'on ' + c.region : '') + ' — see the sketch in the screenshot.');
      else if (c.kind === 'insert') {
        var pr = c.el && c.el.isConnected ? c.el.getBoundingClientRect() : null;
        var desc = c.el ? (phDesc(c.el) || shortText(c.el)) : '';
        lines.push(n + 'Add a NEW UI component ' + insertLoc(c.el) + (pr ? ', ~' + Math.round(pr.width) + '×' + Math.round(pr.height) + 'px' : '') + '. Intended: “' + desc + '”.' + (c.generatedHtml ? ' A generated HTML/CSS starting point is in the change-set (`generatedHtml`) — use it as the base.' : ' (see the new component in the screenshot).'));
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
    if (studio) { studioPointerHover(e); return; }
    if (state.debugView) { state.hoverEl = null; return; }
    if (state.move || state.resizing || state.editingText) return;
    if (state.tool === 'insert') { showInsertLine(e.clientX, e.clientY); return; }
    if (state.tool !== 'select') return;
    if (isOurs(e.target)) { state.hoverEl = null; return; }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    state.hoverEl = (el && !isOurs(el)) ? (chartRoot(el) || el) : null;
    reposition();
  }

  function onPointerDown(e) {
    if (studio) { studioPointerDown(e); return; }
    if (state.debugView) return; // clicks pass through to the full-screen debug panels
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
    if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSelect(el); return; } // add/remove from multi-selection
    var inSel = !!(state.selection && state.selection.length && state.selection.indexOf(el) >= 0);
    if (inSel) {
      beginPendingMove(e, el, target); // grab any selected element → drag the whole selection
    } else if (state.selected && (el === state.selected || state.selected.contains(target) || state.selected === target)) {
      beginPendingMove(e, state.selected, target); // drag the selection to move; click a child to drill in
    } else {
      select(el);
    }
  }

  function onDblClick(e) {
    if (studio) { studioDoubleClick(e); return; }
    if (state.debugView) return;
    if (state.tool !== 'select' || isOurs(e.target)) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && !isOurs(el) && !chartRoot(el) && el.children.length === 0) { e.preventDefault(); e.stopPropagation(); select(el); startText(el); }
  }

  function blockMouse(e) {
    if (studio) { studioBlockMouse(e); return; }
    if (isOurs(e.target)) return;
    if (state.debugView) { if (inDebug(e.target)) return; e.preventDefault(); e.stopPropagation(); return; }
    if (state.editingText) { var t = e.target; if (t && (t === state.editingText.el || (state.editingText.el.contains && state.editingText.el.contains(t)))) return; }
    e.preventDefault(); e.stopPropagation();
  }

  function onKey(e) {
    if (studio) { studioKey(e); return; }
    if (state.debugView) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exitDebugView(); } return; }
    if (state.editingText) { if (e.key === 'Escape') { e.preventDefault(); commitText(); } return; }
    // Don't hijack keys while typing in one of our own inputs (inspector fields,
    // comment note, chart title) — let them behave natively (incl. Ctrl+Z).
    var ae = root && root.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { if (e.key === 'Escape') ae.blur(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.stopPropagation(); undoLast(); return; }
    if ((e.ctrlKey || e.metaKey) && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')) { e.preventDefault(); e.stopPropagation(); redoLast(); return; }
    if (state.selected && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); e.stopPropagation(); removeSelected(); return; }
    if (state.selected && e.key.indexOf('Arrow') === 0) {
      e.preventDefault(); e.stopPropagation();
      var d = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') nudge(-d, 0); else if (e.key === 'ArrowRight') nudge(d, 0);
      else if (e.key === 'ArrowUp') nudge(0, -d); else nudge(0, d);
      return;
    }
    if (e.key === 'Escape') { if (state.move) { e.preventDefault(); e.stopPropagation(); cancelMove(); return; } closeCommentEditor(); if (state.selected) deselect(); else if (state.tool !== 'select') setTool('select'); return; }
    if (e.key === 'v' || e.key === 'V') setTool('select');
    else if (e.key === 'c' || e.key === 'C') setTool('comment');
    else if (e.key === 'i' || e.key === 'I') setTool('insert');
    else if (e.key === 'd' || e.key === 'D') setTool('draw');
  }

  var rafId = 0;
  function loop() { reposition(); rafId = requestAnimationFrame(loop); }

  var MOUSE_EVENTS = ['click', 'mousedown', 'mouseup', 'dblclick', 'contextmenu'];

  // ---- theme adoption ------------------------------------------------------
  // The tools are Fabricator's own UI, so they mirror FABRICATOR's theme (not the
  // previewed app): the renderer reads its own --accent / --bg-elev / --text /
  // --border tokens + the UI zoom (100/110/125/150%) and pushes them in via
  // `setTheme` (host → controller, re-sent on reload like the model list). Until
  // one arrives we use the default dark-teal palette. Colors are normalized to
  // 6-digit hex so the alpha-suffix patterns (e.g. accent + '88') keep working.
  var DEF_THEME = { accent: TEAL, panel: PANEL_BG, txt: TXT };
  function hx2(n) { var s = Math.round(clamp(n, 0, 255)).toString(16); return s.length === 1 ? '0' + s : s; }
  function toRgb(c) {
    if (!c) return null;
    c = String(c).trim();
    if (c[0] === '#') {
      if (c.length === 4) return [parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16), parseInt(c[3] + c[3], 16)];
      if (c.length >= 7) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
      return null;
    }
    var m = c.match(/rgba?\(([^)]+)\)/i);
    if (m) { var p = m[1].split(',').map(function (x) { return parseFloat(x); }); if (p.length >= 3 && !isNaN(p[0])) return [p[0], p[1], p[2]]; }
    return null;
  }
  function toHex(c) { var r = toRgb(c); return r ? '#' + hx2(r[0]) + hx2(r[1]) + hx2(r[2]) : ''; }
  function mixc(a, b, t) { var ra = toRgb(a), rb = toRgb(b); if (!ra || !rb) return toHex(a) || a; return '#' + hx2(ra[0] + (rb[0] - ra[0]) * t) + hx2(ra[1] + (rb[1] - ra[1]) * t) + hx2(ra[2] + (rb[2] - ra[2]) * t); }
  function rgbaOf(c, a) { var r = toRgb(c); return r ? 'rgba(' + Math.round(r[0]) + ',' + Math.round(r[1]) + ',' + Math.round(r[2]) + ',' + a + ')' : c; }
  function lumOf(c) { var r = toRgb(c); return r ? (0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]) / 255 : 0; }
  function onColor(c) { return lumOf(c) > 0.55 ? '#04211f' : '#ffffff'; }
  // Chrome font px = base size * Fabricator UI zoom (themeScale).
  function fpx(n) { return Math.round(n * (themeScale || 1)) + 'px'; }
  // Apply a Fabricator theme pushed by the host (accent / surfaces / text /
  // border / UI scale). Missing fields fall back to defaults; on-accent text is
  // derived from the accent luminance so it stays readable (teal → dark ink).
  function applyHostTheme(t) {
    if (!t) return;
    var accent = toHex(t.accent) || DEF_THEME.accent;
    var panel = toHex(t.panel) || DEF_THEME.panel;
    var txt = toHex(t.txt) || DEF_THEME.txt;
    TEAL = accent;
    TEAL_HI = toHex(t.accentHi) || mixc(accent, '#ffffff', 0.2);
    PANEL_BG = panel;
    PANEL_BG2 = toHex(t.panel2) || mixc(panel, txt, 0.08);
    BORDER = toHex(t.border) || mixc(panel, txt, 0.16);
    TXT = txt;
    TXT_DIM = toHex(t.txtDim) || mixc(txt, panel, 0.4);
    PANEL_GLASS = rgbaOf(panel, 0.9);
    ON_ACCENT = onColor(accent);
    if (typeof t.scale === 'number' && t.scale > 0) themeScale = clamp(t.scale, 0.8, 2);
    state.hasTheme = true;
  }
  // Repaint the live chrome after a theme/scale change: rebuild the shadow
  // <style> + the light-DOM animation CSS + the toolbar (icon sizes), then reflow.
  // Studio shares the color/scale helpers but never rebuilds legacy panels.
  function rebuildStyle() {
    if (!state.enabled || !elStyle) return;
    if (studio) {
      studioRefresh();
      studioSilence(function () {
        elStyle.textContent = buildStyle();
        if (studio.text) studio.text.wrapper.style.outlineColor = TEAL;
        studioChrome();
        reposition();
      });
      return;
    }
    elStyle.textContent = buildStyle();
    removeGenStyle(); injectGenStyle();
    if (elToolbar) buildToolbar();
    if (state.selected) renderInspector();
    reposition();
  }

  function enable() {
    if (state.enabled) return;
    state.enabled = true;
    if (state.theme) applyHostTheme(state.theme);
    buildUI();
    injectGenStyle();
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('dblclick', onDblClick, true);
    MOUSE_EVENTS.forEach(function (t) { window.addEventListener(t, blockMouse, true); });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);
    if (!studio) {
      rafId = requestAnimationFrame(loop);
      showHint('Design mode — Select · Insert · Comment · Draw'); setTimeout(hideHint, 2800);
    }
  }

  function disable() {
    if (!state.enabled) return;
    state.enabled = false;
    exitDebugView(); // revert any transient debug view (restores the chart, no record)
    if (state.editingText) commitText();
    if (state.panelDragUp) { try { state.panelDragUp(); } catch (e) {} state.panelDragUp = null; }
    if (state.resizing) { window.removeEventListener('pointermove', onResizeMove, true); window.removeEventListener('pointerup', onResizeUp, true); state.resizing = null; }
    if (state.move) { window.removeEventListener('pointermove', onMoveMove, true); window.removeEventListener('pointerup', onMoveUp, true); if (state.move.active) { for (var mi = 0; mi < state.move.items.length; mi++) state.move.items[mi].el.style.transform = state.move.items[mi].origTransform; endMoveVisuals(state.move); } state.move = null; }
    if (state.drawing) { window.removeEventListener('pointermove', onDrawMove, true); window.removeEventListener('pointerup', onDrawUp, true); state.drawing = null; }
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('dblclick', onDblClick, true);
    MOUSE_EVENTS.forEach(function (t) { window.removeEventListener(t, blockMouse, true); });
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
    if (rafId) cancelAnimationFrame(rafId); rafId = 0;
    restoreCaptureAffordances(); // undo any un-drained pre-capture neutralization
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
    // Clear any "Edit with AI" busy markers left on elements.
    try {
      var eds = document.querySelectorAll('[data-rayfin-editing="1"]');
      for (var ei = 0; ei < eds.length; ei++) eds[ei].removeAttribute('data-rayfin-editing');
    } catch (e) {}
    removeGenStyle();
    if (host) host.remove();
    host = root = null;
    state.selected = null; state.hoverEl = null; state.handoff = null; state.aiRequest = null; state.aiEditQueue = [];
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

  // ---- local (in-frame) controller API -------------------------------------
  // These operate on THIS frame's live controller. In the direct view and inside
  // the app iframe they are the real implementation; the relay (top frame of the
  // embedded view) serves cached copies and forwards mutations to the app iframe.
  function localPeek() {
    return {
      enabled: state.enabled,
      version: state.version,
      changeCount: state.changes.length,
      handoffReady: !!state.handoff,
      aiPending: !!state.aiRequest,
      aiEditPending: state.aiEditQueue.length > 0,
      hasModels: !!(state.models && state.models.length),
      aiModel: state.aiModel || null,
      hasTheme: !!state.hasTheme
    };
  }
  function localDrain() {
    var hf = state.handoff; if (!hf) return null;
    state.handoff = null;
    var out = { instruction: hf.instruction, changeCount: hf.changeCount };
    // Clean up: clear the change-set (entries hold the undo closures) and any
    // user markup (pins/sketches); restore chrome (host typically disables next).
    state.changes = []; state.redo = []; clearPins(); clearDrawings();
    restoreCaptureAffordances(); // undo the pre-capture placeholder/overlay neutralization
    if (elChanges) elChanges.style.display = 'none';
    if (elToolbar) { elToolbar.style.display = 'flex'; renderBar(); }
    bump();
    return out;
  }
  function localDrainAi() {
    var r = state.aiRequest; if (!r) return null;
    state.aiRequest = null; bump();
    return { id: r.id, description: r.description, width: r.width, height: r.height, model: r.model };
  }
  function localDrainAiEdit() {
    var r = state.aiEditQueue.shift(); if (!r) return null;
    bump();
    return { id: r.id, ids: r.ids || [r.id], description: r.description, model: r.model, context: r.context };
  }
  function localSetModels(list, preferred) {
    try {
      state.models = Array.isArray(list) ? list : null;
      var ids = (state.models || []).map(function (m) { return m.id; });
      var valid = function (v) { return v === 'auto' || ids.indexOf(v) >= 0; };
      // 'auto' = the engine picks, and is the default. Honour a persisted
      // `preferred` when valid; else keep a still-valid pick; else fall back to Auto.
      if (preferred !== undefined && preferred !== null) {
        state.aiModel = valid(preferred) ? preferred : 'auto';
      } else if (!valid(state.aiModel)) {
        state.aiModel = 'auto';
      }
      if (state.selected) renderInspector();
    } catch (e) {}
  }
  // The model id to send to the engine for a generation ('auto' → none/default).
  function selectedModel() { return (state.aiModel && state.aiModel !== 'auto') ? state.aiModel : undefined; }
  // Apply a Fabricator theme (accent/surfaces/text/border/scale) and repaint.
  function localSetTheme(theme) {
    if (!theme) return;
    state.theme = theme;
    applyHostTheme(theme);
    rebuildStyle();
  }

  // ---- frame roles + cross-frame relay -------------------------------------
  // The host only evals in the TOP frame. When the app is embedded in a
  // cross-origin iframe (Fabric portal), the top frame runs as a `relay` that
  // bridges the host API to the app frame over postMessage; the app frame runs
  // the real controller as role `app`. In the direct view the top frame IS the
  // app (role `direct`) and everything is local.
  var MSG = 'rayfin-design';
  var frameRole = 'idle'; // 'idle' | 'direct' | 'relay' | 'app'
  var isTop = true;
  try { isTop = (window.top === window.self); } catch (e) { isTop = true; }

  // Relay side (top frame, embedded view): the app frame's window + expected
  // origin, whether design is active, buffered pre-enable hellos, the mirrored
  // status cache, and the last models pushed by the host.
  var relayActive = false, relayAppWin = null, relayAppOrigin = null;
  var pendingHellos = [];
  var cache = { status: null, handoff: null, aiRequest: null, aiEdit: null };
  var relayModels = null, relayPreferred = null, relayTheme = null;
  var pingTimer = 0, pingCount = 0;

  // App side (the embedded iframe): the top frame's origin, the upward-sync
  // timer, and whether the relay has acknowledged us (stops the hello retries).
  var topOrigin = '*', syncTimer = 0, helloAcked = false;

  function postToApp(msg) {
    try { if (relayAppWin && relayAppOrigin) relayAppWin.postMessage(msg, relayAppOrigin); } catch (e) {}
  }
  function sendEnableToApp() {
    postToApp({ ns: MSG, cmd: 'enable', models: relayModels, preferred: relayPreferred, theme: relayTheme });
  }
  function adoptPendingHellos() {
    for (var i = 0; i < pendingHellos.length; i++) {
      if (pendingHellos[i].origin === relayAppOrigin) relayAppWin = pendingHellos[i].source;
    }
    pendingHellos = [];
  }
  // The relay can't reliably enumerate deeply-nested cross-origin frames, so it
  // also pings its direct children (origin-gated) to prompt a hello — covers the
  // case where design mode is toggled long after the page settled.
  function stopPing() { if (pingTimer) { clearTimeout(pingTimer); pingTimer = 0; } }
  function pingChildrenForApp() {
    stopPing(); pingCount = 0;
    (function tick() {
      if (!relayActive || relayAppWin) { stopPing(); return; }
      try {
        var frames = window.frames;
        for (var i = 0; i < frames.length; i++) {
          try { frames[i].postMessage({ ns: MSG, cmd: 'ping' }, relayAppOrigin || '*'); } catch (e) {}
        }
      } catch (e) {}
      if (++pingCount >= 10) { stopPing(); return; }
      pingTimer = setTimeout(tick, 500);
    })();
  }
  function relayPeek() {
    if (cache.status) return cache.status;
    return {
      enabled: relayActive, version: 0, changeCount: 0, handoffReady: false,
      aiPending: false, hasModels: !!(relayModels && relayModels.length),
      aiModel: relayPreferred || null, hasTheme: !!relayTheme
    };
  }
  function relayDrain() {
    var hf = cache.handoff; if (!hf) return null;
    cache.handoff = null;
    postToApp({ ns: MSG, cmd: 'drainCommit' });
    return { instruction: hf.instruction, changeCount: hf.changeCount };
  }
  function relayDrainAi() {
    var r = cache.aiRequest; if (!r) return null;
    cache.aiRequest = null;
    postToApp({ ns: MSG, cmd: 'drainAiCommit' });
    return { id: r.id, description: r.description, width: r.width, height: r.height, model: r.model };
  }
  function relayDrainAiEdit() {
    var r = cache.aiEdit; if (!r) return null;
    cache.aiEdit = null;
    postToApp({ ns: MSG, cmd: 'drainAiEditCommit' });
    return { id: r.id, description: r.description, model: r.model, context: r.context };
  }

  // Host entry points (called from the TOP frame by `preview_design_set`).
  function hostEnable(mode, appOrigin) {
    if (studio || studioRelay) return;
    if (mode === 'relay') {
      frameRole = 'relay';
      relayActive = true;
      relayAppOrigin = appOrigin || null;
      adoptPendingHellos();
      if (relayAppWin) sendEnableToApp();
      pingChildrenForApp();
    } else {
      frameRole = 'direct';
      enable();
    }
  }
  function hostDisable() {
    if (studio || studioRelay) { studioDisconnect((studio || studioRelay).sessionId); return; }
    if (frameRole === 'relay') {
      relayActive = false;
      postToApp({ ns: MSG, cmd: 'disable' });
      cache = { status: null, handoff: null, aiRequest: null, aiEdit: null };
      stopPing();
    } else {
      disable();
    }
  }

  // App side: mirror status up to the relay, and react to relay commands.
  function postStatus() {
    if (isTop) return;
    try {
      window.top.postMessage({
        ns: MSG, evt: 'status', status: localPeek(),
        handoff: state.handoff || null, aiRequest: state.aiRequest || null, aiEdit: state.aiEditQueue[0] || null
      }, topOrigin || '*');
    } catch (e) {}
  }
  function startAppSync() { stopAppSync(); syncTimer = setInterval(postStatus, 250); }
  function stopAppSync() { if (syncTimer) { clearInterval(syncTimer); syncTimer = 0; } }
  function sayHello() {
    if (isTop) return;
    try { window.top.postMessage({ ns: MSG, evt: 'hello' }, '*'); } catch (e) {}
  }
  function scheduleHellos() {
    if (isTop) return;
    [0, 250, 750, 1500, 3000, 6000].forEach(function (ms) {
      setTimeout(function () { if (!helloAcked) sayHello(); }, ms);
    });
    try {
      document.addEventListener('DOMContentLoaded', function () { if (!helloAcked) sayHello(); });
      window.addEventListener('load', function () { if (!helloAcked) sayHello(); });
    } catch (e) {}
  }
  function onRelayCommand(d, e) {
    topOrigin = e.origin || '*';
    helloAcked = true;
    switch (d.cmd) {
      case 'ping': sayHello(); break;
      case 'enable':
        frameRole = 'app';
        if (d.models) localSetModels(d.models, d.preferred);
        if (d.theme) state.theme = d.theme;
        enable();
        startAppSync();
        postStatus();
        break;
      case 'disable': disable(); stopAppSync(); postStatus(); break;
      case 'setModels': localSetModels(d.list, d.preferred); postStatus(); break;
      case 'setTheme': localSetTheme(d.theme); postStatus(); break;
      case 'applyGenerated': applyGenerated(d.id, d.html); break;
      case 'drainCommit': localDrain(); postStatus(); break;
      case 'drainAiCommit': localDrainAi(); postStatus(); break;
      case 'drainAiEditCommit': localDrainAiEdit(); postStatus(); break;
      case 'applyRestyle': applyRestyle(d.id, d.patch); break;
    }
  }
  function onMessage(e) {
    if (studio || studioRelay) return;
    var d = e && e.data;
    if (!d || d.ns !== MSG) return;
    if (isTop) {
      // Relay side: app frames announce themselves and mirror their status.
      if (d.evt === 'hello') {
        if (frameRole === 'direct') return; // top frame is the app; ignore child hellos
        if (relayAppOrigin) {
          if (e.origin === relayAppOrigin) { relayAppWin = e.source; if (relayActive) sendEnableToApp(); }
        } else {
          pendingHellos.push({ source: e.source, origin: e.origin });
          if (pendingHellos.length > 12) pendingHellos.shift();
        }
      } else if (d.evt === 'status' && frameRole === 'relay') {
        cache.status = d.status || null;
        cache.handoff = d.handoff || null;
        cache.aiRequest = d.aiRequest || null;
        cache.aiEdit = d.aiEdit || null;
      }
    } else if (d.cmd) {
      // App side: only accept commands from the top (relay) frame.
      var fromTop = false;
      try { fromTop = (e.source === window.top); } catch (err) { fromTop = false; }
      if (fromTop) onRelayCommand(d, e);
    }
  }

  // ---- Studio: bounded JSON journal and conservative DOM identities --------
  var STUDIO_MSG = 'rayfin-design-studio';
  var STUDIO_LIMIT = { history: 300, edits: 256, nodes: 1200, children: 160, selection: 40, html: 48000, journal: 1800000 };
  var studioSeq = 0, studioEpoch = 0, studioProjectedDocument = false;
  var studioSeed = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  var studioIdentityRoute = studioRoute();
  var studioHellos = [], studioTopOrigin = null, studioHelloTimers = [];
  var STUDIO_STYLES = (
    'color accent-color background background-color background-image width height min-width max-width min-height max-height ' +
    'inline-size block-size min-inline-size max-inline-size min-block-size max-block-size aspect-ratio box-sizing ' +
    'padding padding-top padding-right padding-bottom padding-left padding-inline padding-inline-start padding-inline-end padding-block padding-block-start padding-block-end ' +
    'margin margin-top margin-right margin-bottom margin-left margin-inline margin-inline-start margin-inline-end margin-block margin-block-start margin-block-end ' +
    'font-family font-size font-weight font-style font-variant line-height letter-spacing word-spacing text-align text-transform text-decoration text-decoration-color text-wrap white-space ' +
    'border border-width border-style border-color border-radius border-top border-right border-bottom border-left border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius ' +
    'border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color ' +
    'opacity box-shadow display gap row-gap column-gap flex flex-grow flex-shrink flex-basis flex-direction flex-wrap align-items align-self align-content justify-content justify-items justify-self ' +
    'grid-template-columns grid-template-rows grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row order ' +
    'object-fit object-position list-style-type overflow overflow-x overflow-y transform transform-origin position top right bottom left z-index'
  ).split(' ');
  function studioId(prefix) { return prefix + '-' + studioSeed + '-' + (++studioSeq).toString(36); }
  function studioRoute() { return window.location.pathname + window.location.search + window.location.hash; }
  function studioDocumentIdentity() {
    var route = studioRoute();
    if (route !== studioIdentityRoute) { studioIdentityRoute = route; studioEpoch++; }
    return studioSeed + ':' + studioEpoch;
  }
  function studioError(message) { throw new Error(message); }
  function studioPlain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function studioJson(value, max) {
    var seen = new Set(), count = 0;
    function copy(v, depth, path) {
      if (++count > 40000 || depth > 24) studioError('Design data is too complex.');
      if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
      if (typeof v === 'number' && isFinite(v)) return v;
      if (!v || typeof v !== 'object' || v.nodeType || seen.has(v)) studioError('Design data must be serializable JSON at ' + path + '.');
      seen.add(v);
      var out = Array.isArray(v) ? [] : {};
      Object.keys(v).forEach(function (k) {
        if (k === '__proto__' || k === 'prototype' || k === 'constructor') studioError('Unsafe design data key.');
        out[k] = copy(v[k], depth + 1, path + '.' + k);
      });
      seen.delete(v);
      return out;
    }
    var result = copy(value, 0, 'root');
    if (JSON.stringify(result).length > (max || STUDIO_LIMIT.journal)) studioError('Design data exceeds the journal limit.');
    return result;
  }
  // Native JSON serializers may reorder object keys. Only arrays are ordered.
  function studioStableJson(value) {
    if (Array.isArray(value)) return '[' + value.map(studioStableJson).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + studioStableJson(value[key]); }).join(',') + '}';
    return JSON.stringify(value);
  }
  function studioEqual(a, b) { return studioStableJson(a) === studioStableJson(b); }
  function studioHash(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(36) + ':' + text.length;
  }
  function studioNorm(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }
  function studioFormControl(el) { return !!(el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); }
  function studioFormData(el) { return !!(el && el.closest && el.closest('input,textarea,select,datalist,option,optgroup')); }
  function studioOwnNodes(el) {
    if (!el || studioFormData(el) || el.childNodes.length > STUDIO_LIMIT.children) return [];
    return Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 3; });
  }
  function studioOwn(el) { return studioOwnNodes(el).map(function (n) { return n.nodeValue; }).join(''); }
  function studioTextInfo(el) {
    if (studioFormData(el)) return { text: '', hash: studioHash(''), complete: true };
    var walker = document.createTreeWalker(el, 5, { acceptNode: function (node) {
      return node.nodeType === 3 ? 1 : /^(INPUT|TEXTAREA|SELECT|DATALIST|OPTION|OPTGROUP)$/.test(node.tagName) ? 2 : 3;
    } }), text = '', n, count = 0, complete = true;
    while ((n = walker.nextNode())) {
      if (++count > 80) { complete = false; break; }
      if (text.length + n.nodeValue.length > 8192) { complete = false; break; }
      text += n.nodeValue;
    }
    text = studioNorm(text);
    return { text: text, hash: studioHash(text), complete: complete };
  }
  function studioAllowedElement(el) {
    return !!(el && el.nodeType === 1 && el.ownerDocument === document && !isOurs(el) &&
      !/^(SCRIPT|STYLE|LINK|META|HEAD|NOSCRIPT|IFRAME|OBJECT|EMBED|TEMPLATE)$/.test(el.tagName) &&
      (!studioFormData(el) || studioFormControl(el)) &&
      !el.closest('[data-rayfin-studio-chrome]'));
  }
  function studioIdentityKey(el) {
    var key = {};
    ['id', 'data-testid', 'data-test-id', 'data-key', 'role', 'aria-label', 'name'].forEach(function (name) {
      var value = el.getAttribute(name);
      if (value && value.length <= 256 && value.indexOf('__rayfin') !== 0) key[name] = value;
    });
    if (studioFormControl(el)) {
      ['type', 'placeholder'].forEach(function (name) {
        var value = el.getAttribute(name);
        if (value && value.length <= 256) key[name] = value;
      });
    }
    return key;
  }
  function studioQuery(selector, base) {
    if (typeof selector !== 'string' || !selector || selector.length > 1024 || /:has\(|[{}]/i.test(selector)) return [];
    try {
      var found = (base || document).querySelectorAll(selector);
      return found.length > STUDIO_LIMIT.children ? [] : Array.prototype.filter.call(found, studioAllowedElement);
    } catch (e) { return []; }
  }
  function studioSelector(el) {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    var hint = cssPath(el);
    if (studioQuery(hint).length === 1) return hint;
    var parts = [], n = el;
    for (var i = 0; n && i < 20; i++, n = n.parentElement) {
      var segment = n.tagName.toLowerCase();
      if (n.id && studioQuery('#' + cssEscape(n.id)).length === 1) { parts.unshift('#' + cssEscape(n.id)); break; }
      var siblings = n.parentElement && Array.prototype.filter.call(n.parentElement.children, function (x) { return x.tagName === n.tagName; });
      if (siblings && siblings.length > 1) segment += ':nth-of-type(' + (siblings.indexOf(n) + 1) + ')';
      parts.unshift(segment);
    }
    return parts.join(' > ');
  }
  function studioLabel(el) {
    var chart = chartRoot(el), tag = el.tagName.toLowerCase(), label;
    if (studioFormControl(el)) {
      label = tag === 'select' ? 'Dropdown' : tag === 'textarea' ? 'Text area' : studioPopupButton(el) ? 'Button' : 'Input';
      var fieldName = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      if (!fieldName && el.labels && el.labels.length) fieldName = studioTextInfo(el.labels[0]).text;
      if (!fieldName) fieldName = el.getAttribute('name') || '';
      return (label + (fieldName ? ' · ' + studioNorm(fieldName).slice(0, 60) : '')).slice(0, 120);
    }
    if (chart === el) label = 'Chart';
    else if (/^h[1-6]$/.test(tag)) label = 'Heading';
    else label = ({ button: 'Button', a: 'Link', img: 'Image', p: 'Text', section: 'Section', article: 'Card', main: 'Page', nav: 'Navigation', input: 'Input', ul: 'List', ol: 'List' })[tag] ||
      (studioPopupLayoutKind(el) === 'grid' ? 'Grid' : studioPopupLayoutKind(el) === 'stack' ? 'Stack' : '') ||
      el.getAttribute('aria-label') || (studioPopupKind(el) === 'card' ? 'Card' : el.children.length ? 'Container' : 'Text');
    var text = studioNorm(studioOwn(el));
    return (label + (text ? ' · ' + text.slice(0, 60) : '')).slice(0, 120);
  }
  function studioContext(el) {
    var info = studioIdentityText(el), parent = el.parentElement, chart = chartRoot(el) === el, form = studioFormControl(el);
    var siblings = parent && parent.children.length <= STUDIO_LIMIT.children ? Array.prototype.filter.call(parent.children, studioAllowedElement) : [];
    var index = siblings.indexOf(el);
    function neighbor(node) {
      if (!node) return null;
      var text = studioIdentityText(node);
      return { tag: node.tagName.toLowerCase(), key: studioIdentityKey(node), hash: text.hash };
    }
    return {
      tag: el.tagName.toLowerCase(), key: studioIdentityKey(el), own: chart ? '' : studioNorm(studioOwn(el)).slice(0, 4096),
      text: info.text, hash: info.hash, complete: info.complete, selector: studioSelector(el),
      children: chart || form ? [] : Array.prototype.slice.call(el.children, 0, 64).filter(studioAllowedElement).map(function (n) { return { tag: n.tagName.toLowerCase(), key: studioIdentityKey(n) }; }),
      parent: parent && studioAllowedElement(parent) ? { selector: studioSelector(parent), tag: parent.tagName.toLowerCase(), key: studioIdentityKey(parent) } : null,
      position: index < 0 ? null : { index: index, count: siblings.length, previous: neighbor(siblings[index - 1]), next: neighbor(siblings[index + 1]) }
    };
  }
  function studioIdentityText(el) {
    if (chartRoot(el) !== el) return studioTextInfo(el);
    var spec = readSpec(el);
    try { return { text: '', hash: 'chart:' + studioHash(studioStableJson(studioChartVisual(spec))), complete: true }; }
    catch (e) { return { text: '', hash: 'chart:' + (spec && spec.type || 'unavailable'), complete: false }; }
  }
  function studioTarget(el) {
    var id = studio && studio.nodeIds.get(el);
    if (!id) {
      id = studioId('target');
      if (studio) { studio.nodeIds.set(el, id); studio.bindings.set(id, el); }
    }
    if (studio && !studio.identities.has(id)) studio.identities.set(id, studioContext(el));
    var out = { id: id, selector: studioSelector(el), tag: el.tagName.toLowerCase(), label: studioLabel(el) };
    var text = studioTextInfo(el).text;
    if (text) out.text = text.slice(0, 512);
    if (el.parentElement && studioAllowedElement(el.parentElement)) out.parentSelector = studioSelector(el.parentElement);
    if (el.getAttribute('role')) out.role = el.getAttribute('role').slice(0, 256);
    if (el.getAttribute('aria-label')) out.ariaLabel = el.getAttribute('aria-label').slice(0, 256);
    var component = componentHint(el);
    if (component) out.component = component.slice(0, 120);
    return out;
  }
  function studioBind(target, el) {
    if (!studio) return;
    studio.bindings.set(target.id, el);
    studio.nodeIds.set(el, target.id);
    studio.identities.set(target.id, studioContext(el));
  }
  function studioValidTarget(target) {
    return studioPlain(target) && typeof target.id === 'string' && target.id.length > 0 && target.id.length <= 200 &&
      typeof target.selector === 'string' && target.selector.length > 0 && target.selector.length <= 1024 &&
      typeof target.tag === 'string' && /^[a-z][a-z0-9-]*$/.test(target.tag) && typeof target.label === 'string' && target.label.length <= 240 &&
      ['text', 'parentSelector', 'role', 'ariaLabel', 'component'].every(function (key) { return target[key] == null || (typeof target[key] === 'string' && target[key].length <= 1024); });
  }
  function studioKeysMatch(el, key) {
    return Object.keys(key || {}).every(function (k) { return el.getAttribute(k) === key[k]; });
  }
  function studioContextMatches(el, ctx, ignoreParent) {
    if (!ctx || el.tagName.toLowerCase() !== ctx.tag || !studioKeysMatch(el, ctx.key)) return false;
    var chart = chartRoot(el) === el, info = studioIdentityText(el);
    if (ctx.hash !== info.hash || ctx.text !== info.text || ctx.complete !== info.complete) return false;
    if (!ctx.complete && !(ctx.key.id || ctx.key['data-testid'])) return false;
    if (ctx.own !== (chart ? '' : studioNorm(studioOwn(el)).slice(0, 4096))) return false;
    var children = chart || studioFormControl(el) ? [] : Array.prototype.slice.call(el.children, 0, 64).filter(studioAllowedElement);
    if (ctx.children && (ctx.children.length !== children.length || ctx.children.some(function (child, i) {
      return children[i].tagName.toLowerCase() !== child.tag || !studioKeysMatch(children[i], child.key);
    }))) return false;
    if (!ignoreParent && ctx.parent) {
      var p = el.parentElement;
      if (!p || p.tagName.toLowerCase() !== ctx.parent.tag || !studioKeysMatch(p, ctx.parent.key)) return false;
      var parents = studioQuery(ctx.parent.selector);
      if (parents.length !== 1 || parents[0] !== p) return false;
    }
    if (!ignoreParent && ctx.position && !(ctx.key.id || ctx.key['data-testid'])) {
      var siblings = el.parentElement && Array.prototype.filter.call(el.parentElement.children, studioAllowedElement);
      if (!siblings || siblings.length !== ctx.position.count || siblings[ctx.position.index] !== el) return false;
      var adjacent = [siblings[ctx.position.index - 1], siblings[ctx.position.index + 1]];
      var expected = [ctx.position.previous, ctx.position.next];
      if (expected.some(function (neighbor, i) {
        if (!neighbor) return !!adjacent[i];
        return !adjacent[i] || adjacent[i].tagName.toLowerCase() !== neighbor.tag ||
          !studioKeysMatch(adjacent[i], neighbor.key) || studioIdentityText(adjacent[i]).hash !== neighbor.hash;
      })) return false;
    }
    return true;
  }
  function studioUnambiguous(el, ctx) {
    if (ctx.key.id && studioQuery('#' + cssEscape(ctx.key.id)).length === 1) return true;
    if (ctx.key['data-testid'] && studioQuery('[data-testid="' + cssAttr(ctx.key['data-testid']) + '"]').length === 1) return true;
    var parent = el.parentElement;
    if (!parent || parent.children.length > STUDIO_LIMIT.children) return false;
    var same = Array.prototype.filter.call(parent.children, function (n) { return studioAllowedElement(n) && studioContextMatches(n, ctx, true); });
    return same.length === 1;
  }
  function studioResolve(target, contexts, options) {
    options = options || {};
    if (!studioValidTarget(target)) studioError('Invalid design target.');
    contexts = (contexts || []).filter(Boolean);
    var bound = !options.fresh && studio && studio.bindings.get(target.id);
    if (bound && studioAllowedElement(bound) && bound.tagName.toLowerCase() === target.tag &&
      (bound.isConnected || options.detached) &&
      (!contexts.length || contexts.some(function (ctx) { return studioContextMatches(bound, ctx, options.detached); }))) return bound;
    if (!contexts.length && studio && studio.identities.has(target.id)) contexts = [studio.identities.get(target.id)];
    var candidates = studioQuery(target.selector);
    contexts.forEach(function (ctx) {
      if (ctx.selector && ctx.selector !== target.selector) candidates = candidates.concat(studioQuery(ctx.selector));
      if (ctx.parent) {
        var parents = studioQuery(ctx.parent.selector);
        if (parents.length === 1 && parents[0].children.length <= STUDIO_LIMIT.children) candidates = candidates.concat(Array.prototype.slice.call(parents[0].children));
      }
    });
    candidates = candidates.filter(function (el, i, list) {
      if (list.indexOf(el) !== i || !studioAllowedElement(el) || el.tagName.toLowerCase() !== target.tag) return false;
      if (contexts.length) return contexts.some(function (ctx) { return studioContextMatches(el, ctx, false) && studioUnambiguous(el, ctx); });
      return (!target.text || studioTextInfo(el).text.slice(0, 512) === target.text) &&
        (!target.role || el.getAttribute('role') === target.role) && (!target.ariaLabel || el.getAttribute('aria-label') === target.ariaLabel);
    });
    if (candidates.length !== 1) studioError('Target is missing or ambiguous: ' + target.label + '. Reselect it to retarget this change.');
    if (!options.fresh) studioBind(target, candidates[0]);
    return candidates[0];
  }
  function studioContexts(edit) {
    return [edit.before && edit.before.context, edit.after && edit.after.context, edit.before && edit.before.source].filter(Boolean);
  }
  function studioScope(scope) {
    if (!scope || scope === 'all' || scope === 'all-sizes') return '';
    if (typeof scope !== 'string' || scope.length > 240) studioError('Invalid breakpoint scope.');
    var value = scope.replace(/^@media\s*/i, '').trim();
    if (!/^[a-z0-9()\s.,:%<>=+-]+$/i.test(value) || !/\b(?:width|height)\b/.test(value) ||
      (value.match(/\(/g) || []).length !== (value.match(/\)/g) || []).length ||
      (typeof window.matchMedia === 'function' && window.matchMedia(value).media === 'not all')) {
      studioError('Use an explicit width/height media condition for breakpoint-scoped edits.');
    }
    return value;
  }
  function studioScopeMatches(scope) {
    if (!scope) return true;
    if (typeof window.matchMedia === 'function') return window.matchMedia(scope).matches;
    var parts = scope.match(/\([^)]*\)/g);
    if (!parts) return false;
    return parts.every(function (part) {
      var m = /\((min-|max-)?(width|height)\s*:\s*(\d+(?:\.\d+)?)(px|em|rem)\)/i.exec(part);
      if (!m) {
        var range = /\((width|height)\s*(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)(px|em|rem)\)/i.exec(part);
        if (!range) return false;
        var actual = range[1] === 'width' ? window.innerWidth : window.innerHeight, threshold = +range[3] * (range[4] === 'px' ? 1 : 16);
        return range[2] === '<=' ? actual <= threshold : range[2] === '>=' ? actual >= threshold : range[2] === '<' ? actual < threshold : range[2] === '>' ? actual > threshold : actual === threshold;
      }
      var current = m[2] === 'width' ? window.innerWidth : window.innerHeight;
      var value = +m[3] * (m[4] === 'px' ? 1 : 16);
      return m[1] === 'min-' ? current >= value : m[1] === 'max-' ? current <= value : current === value;
    });
  }
  function studioCssValue(property, value, priority, token) {
    if (typeof value !== 'string' || value.length > 4096 || /url\s*\(|expression\s*\(|@import|[{}<>\\]|\/\*/i.test(value)) studioError('Unsafe or oversized CSS value.');
    if (token ? !/^--[a-zA-Z0-9_-]{1,100}$/.test(property) : STUDIO_STYLES.indexOf(property) < 0) studioError('Unsupported style property: ' + property);
    var important = /\s*!important\s*$/i.test(value), clean = value.replace(/\s*!important\s*$/i, '').trim();
    var style = document.createElement('div').style;
    style.setProperty(property, clean);
    if (clean && !style.getPropertyValue(property)) studioError('Invalid value for ' + property + '.');
    return { value: clean ? style.getPropertyValue(property) : '', priority: clean ? (important ? 'important' : (priority || '')) : '' };
  }
  function studioStyleValue(el, property) {
    return { value: el.style.getPropertyValue(property), priority: el.style.getPropertyPriority(property), computed: getComputedStyle(el).getPropertyValue(property).trim(),
      viewport: { width: window.innerWidth, height: window.innerHeight } };
  }
  function studioStoredStyle(value) {
    var copy = Object.assign({}, value);
    ['value', 'computed'].forEach(function (key) {
      if (copy[key] && (/(?:data:image\/|blob:)/i.test(copy[key]) || copy[key].length > 4096)) {
        copy[key + 'Hash'] = studioHash(copy[key]); copy[key] = null;
      }
    });
    return copy;
  }
  function studioBase(el) {
    var target = studioTarget(el), ctx = studioContext(el);
    var source = studio.sources.get(target.id);
    if (!source) { source = ctx; studio.sources.set(target.id, source); }
    return { target: target, context: ctx, source: source };
  }
  function studioStyleEdit(el, property, value, scope, theme) {
    var base = studioBase(el), before = studioStoredStyle(studioStyleValue(el, property)), next = studioCssValue(property, value, before.priority, theme);
    before.context = base.context; before.source = base.source;
    return { kind: theme ? 'theme' : 'style', target: base.target, property: property, before: before,
      after: { value: next.value, priority: next.priority, context: base.context }, scope: scope || '' };
  }
  function studioSelectionElements() {
    var selection = (state.selection || []).filter(function (el) { return el.isConnected && studioAllowedElement(el); });
    if (!selection.length) studioError('Select an element in the app first.');
    if (selection.length > STUDIO_LIMIT.selection) studioError('Select fewer elements.');
    return selection;
  }
  function studioCanText(el) {
    return studioAllowedElement(el) && !chartRoot(el) && !/^(INPUT|TEXTAREA|SELECT|OPTION|SVG|CANVAS|VIDEO|AUDIO|HTML|BODY)$/.test(el.tagName) &&
      !el.isContentEditable && studioNorm(studioOwn(el)).length > 0 && studioOwn(el).length <= 4096;
  }
  function studioCanContain(el) {
    return studioAllowedElement(el) && el.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      !/^(HTML|P|H[1-6]|BUTTON|A|IMG|INPUT|TEXTAREA|SELECT|OPTION|TABLE|THEAD|TBODY|TFOOT|TR|UL|OL|DL|SVG|CANVAS|VIDEO|AUDIO|PICTURE|SOURCE|BR|HR)$/.test(el.tagName) &&
      !chartRoot(el) && !el.isContentEditable && el.tagName.indexOf('-') < 0;
  }

  // Effects deliberately capture the *current* DOM baseline. Inverse effects
  // only run while their projected value is still present; an app rerender is
  // never overwritten merely because an old closure retained the same node.
  function studioSilence(fn) {
    studio.mutating++;
    try { return fn(); }
    finally {
      if (studio.observer) studio.observer.takeRecords();
      studio.mutating--;
    }
  }
  function studioStyleSame(el, property, value) {
    var actual = el.style.getPropertyValue(property);
    return (value.valueHash ? studioHash(actual) === value.valueHash : actual === value.value) && el.style.getPropertyPriority(property) === (value.priority || '');
  }
  function studioSetStyle(el, property, value) {
    if (value.value) el.style.setProperty(property, value.value, value.priority || '');
    else el.style.removeProperty(property);
  }
  function studioComputedSame(el, property, value) {
    var current = getComputedStyle(el).getPropertyValue(property).trim();
    return (value.computedHash && studioHash(current) === value.computedHash) ||
      (value.computed != null && current === value.computed) || (value.value != null && value.value !== '' && current === value.value);
  }
  function studioNoEffect(el) { return { el: el, changed: false, undo: function () { return true; } }; }
  function studioSequence(parent) {
    if (parent.children.length > STUDIO_LIMIT.children) studioError('This container is too large to edit safely.');
    return Array.prototype.filter.call(parent.children, studioAllowedElement).map(function (el) {
      var info = studioTextInfo(el);
      return { tag: el.tagName.toLowerCase(), key: studioIdentityKey(el), hash: info.hash, text: info.text.slice(0, 128), complete: info.complete };
    });
  }
  function studioSequenceMatches(parent, sequence) {
    var children = Array.prototype.filter.call(parent.children, studioAllowedElement);
    return Array.isArray(sequence) && children.length === sequence.length && children.every(function (el, i) {
      var info = studioTextInfo(el), expected = sequence[i];
      return expected.tag === el.tagName.toLowerCase() && studioKeysMatch(el, expected.key) && info.hash === expected.hash && info.complete === expected.complete;
    });
  }
  function studioLocation(el) {
    var parent = el.parentElement;
    if (!parent || !studioAllowedElement(parent)) studioError('This element has no editable parent.');
    return {
      parent: studioTarget(parent), parentContext: studioContext(parent),
      index: Array.prototype.indexOf.call(parent.children, el),
      next: el.nextElementSibling && studioAllowedElement(el.nextElementSibling) ? studioTarget(el.nextElementSibling) : null,
      previous: el.previousElementSibling && studioAllowedElement(el.previousElementSibling) ? studioTarget(el.previousElementSibling) : null,
      sequence: studioSequence(parent)
    };
  }
  function studioReadText(el) {
    return { value: studioNorm(studioOwn(el)), segments: studioOwnNodes(el).map(function (n) {
      return { index: Array.prototype.indexOf.call(el.childNodes, n), text: n.nodeValue };
    }) };
  }
  function studioTextEdit(el, value) {
    if (!studioCanText(el)) studioError('Only an element’s own text is editable. Select its text-bearing child instead.');
    if (typeof value !== 'string' || value.length > 4096) studioError('Text must be at most 4096 characters.');
    var base = studioBase(el), before = studioReadText(el);
    before.context = base.context; before.source = base.source;
    return { kind: 'text', target: base.target, property: 'ownText', before: before, after: { value: value, context: base.context } };
  }
  function studioWriteOwn(el, value) {
    var nodes = studioOwnNodes(el), meaningful = nodes.filter(function (n) { return studioNorm(n.nodeValue); });
    var first = meaningful[0] || nodes[0];
    if (!first) studioError('The text node was replaced. Reselect the element.');
    var lead = (first.nodeValue.match(/^\s*/) || [''])[0], trail = (first.nodeValue.match(/\s*$/) || [''])[0];
    first.nodeValue = lead + value + trail;
    meaningful.slice(1).forEach(function (n) { n.nodeValue = ''; });
  }
  function studioImageValue(el) {
    var value = {};
    ['src', 'srcset', 'sizes', 'alt'].forEach(function (name) {
      var attr = el.getAttribute(name);
      value[name] = attr && (attr.length > 4096 || /(?:data:|blob:)/i.test(attr)) ? null : attr;
      if (attr && value[name] === null) value[name + 'Hash'] = studioHash(attr);
    });
    if (el.getAttribute('data-rayfin-studio-asset')) value.assetId = el.getAttribute('data-rayfin-studio-asset');
    return value;
  }
  // Native asset collection uses the top-level ID; value also supports existing
  // protocol-1 journals. Reject disagreement instead of importing one asset and
  // projecting another.
  function studioImageAsset(after) {
    var nested = studioPlain(after.value) ? after.value : {};
    var assetId = after.assetId != null ? after.assetId : nested.assetId;
    var alt = Object.prototype.hasOwnProperty.call(after, 'alt') ? after.alt : nested.alt;
    if (typeof assetId !== 'string' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(assetId) ||
      (alt != null && (typeof alt !== 'string' || alt.length > 4096))) studioError('Invalid image asset journal value.');
    if ((after.assetId != null && nested.assetId != null && after.assetId !== nested.assetId) ||
      (Object.prototype.hasOwnProperty.call(after, 'alt') && Object.prototype.hasOwnProperty.call(nested, 'alt') && after.alt !== nested.alt)) studioError('Conflicting image asset journal values.');
    return { assetId: assetId, alt: alt == null ? null : alt };
  }
  function studioValidateAsset(assetId, dataUrl) {
    if (typeof assetId !== 'string' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(assetId)) studioError('Invalid image asset ID.');
    if (typeof dataUrl !== 'string' || dataUrl.length > 14000000 ||
      !/^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|svg\+xml);base64,[a-zA-Z0-9+/\s]+=*$/i.test(dataUrl)) studioError('Use a validated image asset, not a remote URL.');
    if (/^data:image\/svg\+xml/i.test(dataUrl)) {
      var decoded;
      try { decoded = atob(dataUrl.slice(dataUrl.indexOf(',') + 1)); } catch (e) { studioError('Invalid SVG asset.'); }
      if (decoded.length > 1000000 || /<\s*(?:script|foreignObject|iframe|image|use|style)|\bon[a-z]+\s*=|(?:href|src)\s*=|url\s*\(|<!ENTITY|<!DOCTYPE/i.test(decoded)) {
        studioError('SVG assets must be inert and contain no scripts or external references.');
      }
    }
    return dataUrl;
  }
  function studioChartVisual(spec, snapshot) {
    var omitted = [];
    function walk(value, depth) {
      if (depth > 14) studioError('Chart specification is too deeply nested.');
      if (typeof value === 'string' && /data:image\//i.test(value)) studioError('Image bytes do not belong in chart history. Use source assets.');
      if (!value || typeof value !== 'object') return value;
      if (Array.isArray(value)) {
        if (value.length > 256) studioError('Chart configuration is too large (data belongs outside the journal).');
        return value.map(function (v) { return walk(v, depth + 1); });
      }
      var out = {};
      Object.keys(value).forEach(function (key) {
        if (key === 'data' || key === 'debug') return;
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') studioError('Unsafe chart specification key.');
        if (key === 'geo') { omitted.push('geo'); return; } // geometry, like rows, stays in the live chart
        out[key] = walk(value[key], depth + 1);
      });
      return out;
    }
    var clean = studioJson(walk(spec, 0), 40000);
    if (snapshot && omitted.length) clean.__studioOmitted = ['geo'];
    return clean;
  }
  function studioChartPatch(el, patch) {
    var chart = chartRoot(el), spec = chart && readSpec(chart);
    if (!spec || !studioPlain(patch)) studioError('Select a supported Graphein chart.');
    var safe = studioJson(patch, 30000);
    function validate(object) {
      Object.keys(object).forEach(function (key) {
        if (key === 'data' || key === 'debug' || key === 'geo') studioError('Chart data, geometry and debug mode are not persistent chart edits.');
        if (typeof object[key] === 'string' && /data:image\//i.test(object[key])) studioError('Import images as assets rather than including image bytes in chart edits.');
        if (object[key] && typeof object[key] === 'object') validate(object[key]);
      });
    }
    validate(safe);
    var before = studioChartVisual(spec), after = studioJson(before);
    if (safe.type && safe.type !== spec.type) {
      if (CHART_TYPES.indexOf(safe.type) < 0) studioError('Unknown chart type.');
      var compatible = canConvert(shapeOf(spec), safe.type);
      if (!compatible.ok) studioError('Chart conversion ' + compatible.reason + '.');
      after = studioChartVisual(convertSpec(spec.geo ? Object.assign({ geo: spec.geo }, before) : before, safe.type));
    }
    deepMerge(after, safe);
    var base = studioBase(chart);
    return { kind: 'chart', target: base.target, property: 'spec',
      before: { value: before, context: base.context, source: base.source },
      after: { value: after, context: base.context } };
  }
  function studioWriteChart(el, visual) {
    var current = readSpec(el);
    if (!current) studioError('The chart specification disappeared.');
    var next = studioJson(visual, 40000);
    ['data', 'geo', 'debug'].forEach(function (key) { if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key]; });
    el.setAttribute('data-graphein-spec', JSON.stringify(next));
  }

  // Parse prototypes in an inert template, before anything reaches the live
  // document. DOM cloning is intentionally not presented as cloning a component.
  function studioSafeHtml(html, duplicate) {
    if (typeof html !== 'string' || !html.trim() || html.length > STUDIO_LIMIT.html) studioError('Provide a nonempty HTML block under 48 KB.');
    var template = document.createElement('template');
    template.innerHTML = html;
    var nodes = template.content.querySelectorAll('*');
    if (nodes.length > 400) studioError('The block contains too many elements.');
    var tags = ('section article div span p h1 h2 h3 h4 h5 h6 button a img figure figcaption header footer main aside nav ul ol li dl dt dd strong em b i small br hr label svg g path rect circle ellipse line polyline polygon title desc defs linearGradient radialGradient stop clipPath').toLowerCase().split(' ');
    var attrs = ('class title role aria-label aria-hidden alt width height viewbox d fill stroke stroke-width stroke-linecap stroke-linejoin fill-rule clip-rule x y x1 x2 y1 y2 cx cy r rx ry points opacity offset stop-color stop-opacity preserveaspectratio').split(' ');
    Array.prototype.forEach.call(nodes, function (node) {
      var tag = node.tagName.toLowerCase();
      if (tags.indexOf(tag) < 0) { node.remove(); return; }
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        var name = attr.name.toLowerCase(), value = attr.value;
        if (name === 'style') {
          var clean = document.createElement('div').style, original = node.style;
          for (var i = 0; i < original.length; i++) {
            var property = original[i];
            if (STUDIO_STYLES.indexOf(property) < 0 || /url\s*\(|expression\s*\(|[<>\\]|\/\*/i.test(original.getPropertyValue(property))) continue;
            clean.setProperty(property, original.getPropertyValue(property), original.getPropertyPriority(property));
          }
          node.setAttribute('style', clean.cssText);
        } else if (name === 'src' && tag === 'img') {
          if (/^data:/i.test(value)) studioError('Import inline images as assets before adding or duplicating this block.');
          if (!duplicate || /^(?:javascript:|vbscript:|blob:)/i.test(value) || value.length > 2048) node.removeAttribute(attr.name);
        } else if (name === 'data-rayfin-asset' && studio.assets[value]) {
          // Only references to an already-imported asset may hydrate a prototype.
        } else if (attrs.indexOf(name) < 0 || /url\s*\(|javascript:|expression\s*\(/i.test(value)) node.removeAttribute(attr.name);
      });
      if (tag === 'button') node.setAttribute('type', 'button');
    });
    var children = Array.prototype.slice.call(template.content.children);
    if (!children.length) studioError('The generated block contains no safe visual elements.');
    if (children.length > 1) {
      var wrapper = document.createElement('div');
      wrapper.appendChild(template.content);
      template.content.appendChild(wrapper);
    }
    return template.innerHTML;
  }
  function studioPrototype(html, id) {
    var template = document.createElement('template');
    template.innerHTML = studioSafeHtml(html, true);
    var node = template.content.firstElementChild;
    node.setAttribute('data-rayfin-studio-node', id);
    node.setAttribute('data-rayfin-studio-prototype', 'true');
    var images = [node].concat(Array.prototype.slice.call(node.querySelectorAll('[data-rayfin-asset]')));
    images.forEach(function (image) {
      var asset = image.getAttribute('data-rayfin-asset');
      if (asset) {
        if (!studio.assets[asset]) studioError('An image asset preview is unavailable: ' + asset);
        image.setAttribute('src', studio.assets[asset]);
      }
    });
    node.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); }, true);
    return node;
  }
  var STUDIO_BLOCKS = {
    section: '<section style="padding:1.5rem"><h2>New section</h2><p>Add your content here.</p></section>',
    row: '<div style="display:flex;gap:1rem;align-items:center;padding:1rem"><p>First item</p><p>Second item</p></div>',
    columns: '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;padding:1rem"><div><h3>First column</h3><p>Column content.</p></div><div><h3>Second column</h3><p>Column content.</p></div></div>',
    card: '<article style="padding:1.5rem;border:1px solid currentColor;border-radius:0.75rem"><h3>New card</h3><p>Card content.</p></article>',
    heading: '<h2>New heading</h2>',
    text: '<p>Add your text here.</p>',
    button: '<button type="button" style="padding:0.65em 1.25em;border:1px solid currentColor;border-radius:0.5em">New button</button>',
    image: '<img alt="New image — choose an asset" style="width:100%;height:12rem;object-fit:cover">'
  };
  function studioInsertEdit(anchor, html, placement, block) {
    if (['inside', 'before', 'after'].indexOf(placement) < 0) studioError('Invalid insert placement.');
    var parent = placement === 'inside' ? anchor : anchor.parentElement;
    if (!parent || !studioCanContain(parent)) studioError('This element cannot contain that block. Choose a section or container.');
    var base = studioBase(anchor), parentBase = studioBase(parent);
    var location = { parent: parentBase.target, parentContext: parentBase.context, sequence: studioSequence(parent) };
    return { kind: 'insert', target: base.target, property: block || 'prototype',
      before: { context: base.context, source: base.source, location: location, present: false },
      after: { context: base.context, html: html, placement: placement, insertId: studioId('block'), present: true } };
  }
  function studioRemoveEdit(el) {
    if (el === document.body || el === document.documentElement || !studioAllowedElement(el)) studioError('The app root cannot be removed.');
    var base = studioBase(el);
    return { kind: 'remove', target: base.target, property: 'element',
      before: { context: base.context, source: base.source, location: studioLocation(el), removed: false },
      after: { context: base.context, removed: true } };
  }
  function studioLayout(parent) {
    if (!parent || !studioAllowedElement(parent) || !/^(DIV|SECTION|ARTICLE|MAIN|ASIDE|NAV|HEADER|FOOTER|UL|OL|LI)$/.test(parent.tagName) || parent.children.length > 60) return null;
    var style = getComputedStyle(parent), display = style.display || 'block';
    if (['block', 'flex', 'inline-flex', 'grid', 'inline-grid'].indexOf(display) < 0) return null;
    var children = Array.prototype.filter.call(parent.children, studioAllowedElement);
    if (children.some(function (el) {
      var s = getComputedStyle(el);
      return /^(absolute|fixed)$/.test(s.position) || (s.order && s.order !== '0') ||
        (/grid/.test(display) && [s.gridColumnStart, s.gridColumnEnd, s.gridRowStart, s.gridRowEnd].some(function (v) { return v && v !== 'auto'; }));
    })) return null;
    return { parent: parent, children: children, horizontal: /flex/.test(display) && /^row/.test(style.flexDirection || 'row'), reverse: /reverse/.test(style.flexDirection), rtl: style.direction === 'rtl', grid: /grid/.test(display) };
  }
  function studioOrderValue(parent, children) {
    return { order: children.map(function (el) { return { target: studioTarget(el), context: studioContext(el) }; }), sequence: studioSequence(parent) };
  }
  function studioReorderEdit(parent, after) {
    var base = studioBase(parent), before = studioOrderValue(parent, studioLayout(parent).children);
    before.context = base.context; before.source = base.source;
    return { kind: 'reorder', target: base.target, property: 'children', before: before,
      after: { order: after.map(function (el) { return { target: studioTarget(el), context: studioContext(el) }; }), context: base.context } };
  }
  function studioMoveEdit(selection, direction) {
    var parent = selection[0].parentElement, layout = studioLayout(parent);
    if (!layout || selection.some(function (el) { return el.parentElement !== parent; })) studioError('Reorder requires a supported, shared flow, flex, or auto-grid container.');
    var list = layout.children.slice(), indexes = selection.map(function (el) { return list.indexOf(el); }).sort(function (a, b) { return a - b; });
    if (indexes.some(function (index, i) { return index < 0 || (i && index !== indexes[i - 1] + 1); })) studioError('Select adjacent siblings to reorder them as a group.');
    var first = indexes[0], last = indexes[indexes.length - 1];
    if ((direction === 'previous' && first === 0) || (direction === 'next' && last === list.length - 1)) return null;
    var group = list.splice(first, indexes.length);
    var index = direction === 'previous' ? first - 1 : first + 1;
    Array.prototype.splice.apply(list, [index, 0].concat(group));
    return studioReorderEdit(parent, list);
  }

  function studioApplyEdit(edit, recording, transactionId) {
    var el = studioResolve(edit.target, recording ? [] : studioContexts(edit));
    var before = edit.before, after = edit.after, effect, property = edit.property;
    if (!studioPlain(before) || !studioPlain(after)) studioError('Invalid journal values.');
    if (edit.kind === 'style' || edit.kind === 'theme') {
      var scope = studioScope(edit.scope), token = edit.kind === 'theme';
      studioCssValue(property, after.value, after.priority, token);
      if (!studioScopeMatches(scope)) return studioNoEffect(el);
      if (studioStyleSame(el, property, after) || (!recording && studioComputedSame(el, property, after))) return studioNoEffect(el);
      var sameViewport = !before.viewport || (before.viewport.width === window.innerWidth && before.viewport.height === window.innerHeight);
      if (!recording && (!studioStyleSame(el, property, before) || (sameViewport && before.value === '' && (before.computed || before.computedHash) && !studioComputedSame(el, property, before)))) {
        studioError('The source value of ' + property + ' changed. Reselect or revert this transaction.');
      }
      var original = studioStyleValue(el, property);
      studioSetStyle(el, property, after);
      var expected = studioStyleValue(el, property);
      if (after.value && !after.priority && expected.computed === original.computed && after.value !== original.value) {
        // A stylesheet !important can outrank ordinary inline declarations.
        el.style.setProperty(property, after.value, 'important');
        expected = studioStyleValue(el, property);
      }
      if (recording) Object.assign(after, studioStoredStyle(expected));
      effect = { el: el, changed: true, undo: function () {
        if (!studioStyleSame(el, property, expected)) return false;
        studioSetStyle(el, property, original); return true;
      } };
    } else if (edit.kind === 'text') {
      if (typeof after.value !== 'string' || after.value.length > 4096) studioError('Invalid text journal value.');
      var currentText = studioNorm(studioOwn(el));
      if (currentText === studioNorm(after.value)) return studioNoEffect(el);
      if (!recording && currentText !== studioNorm(before.value)) studioError('The source text changed. Reselect this text.');
      var textNodes = studioOwnNodes(el), textValues = textNodes.map(function (n) { return n.nodeValue; });
      studioWriteOwn(el, after.value);
      var expectedText = textNodes.map(function (n) { return n.nodeValue; });
      if (recording) after.segments = studioReadText(el).segments;
      effect = { el: el, changed: true, undo: function () {
        if (textNodes.some(function (n, i) { return n.parentNode !== el || n.nodeValue !== expectedText[i]; })) return false;
        textNodes.forEach(function (n, i) { n.nodeValue = textValues[i]; }); return true;
      } };
    } else if (edit.kind === 'remove') {
      if (el === document.body || el === document.documentElement) studioError('The app root cannot be removed.');
      var removeParent = el.parentNode, removeNext = el.nextSibling;
      if (!removeParent) studioError('The element is no longer in the app.');
      if (!after.removed) studioError('Invalid removal journal value.');
      removeParent.removeChild(el);
      if (recording) after.sequence = studioSequence(removeParent);
      effect = { el: el, parent: removeParent, changed: true, undo: function () {
        if (el.parentNode || !removeParent.isConnected || (removeNext && removeNext.parentNode !== removeParent)) return false;
        removeParent.insertBefore(el, removeNext); return true;
      } };
    } else if (edit.kind === 'reorder') {
      var layout = studioLayout(el);
      if (!layout || !Array.isArray(after.order) || layout.children.length !== after.order.length) studioError('The layout container changed or no longer supports reordering.');
      var ordered = after.order.map(function (item) {
        var node = studioResolve(item.target, recording ? [] : [item.context]);
        if (node.parentElement !== el) studioError('A reordered element moved to another container.');
        return node;
      });
      if (new Set(ordered).size !== ordered.length) studioError('The reorder contains duplicate targets.');
      if (ordered.every(function (node, i) { return node === layout.children[i]; })) return studioNoEffect(el);
      if (!recording && !studioSequenceMatches(el, before.sequence)) studioError('The container’s source order changed.');
      var oldOrder = Array.prototype.slice.call(el.childNodes);
      ordered.forEach(function (node) { el.appendChild(node); });
      if (recording) after.sequence = studioSequence(el);
      effect = { el: el, changed: true, undo: function () {
        var current = Array.prototype.filter.call(el.children, studioAllowedElement);
        if (!el.isConnected || !ordered.every(function (node, i) { return current[i] === node; }) || current.length !== ordered.length) return false;
        oldOrder.forEach(function (node) { el.appendChild(node); }); return true;
      } };
    } else if (edit.kind === 'insert') {
      var insertParent = after.placement === 'inside' ? el : el.parentElement;
      if (!insertParent || !studioCanContain(insertParent)) studioError('The insertion container is no longer valid.');
      if (!recording && after.sequence && studioSequenceMatches(insertParent, after.sequence)) {
        var existing = insertParent.children[after.index];
        if (existing && studioContextMatches(existing, after.prototypeContext, true) && studioUnambiguous(existing, after.prototypeContext)) {
          studioBind(after.prototypeTarget, existing); return studioNoEffect(existing);
        }
      }
      if (!recording && !studioSequenceMatches(insertParent, before.location.sequence)) studioError('The insertion position changed or is ambiguous.');
      var prototype = studioPrototype(after.html, after.insertId);
      var insertNext = after.placement === 'before' ? el : after.placement === 'after' ? el.nextSibling : null;
      insertParent.insertBefore(prototype, insertNext);
      if (recording) {
        after.prototypeTarget = studioTarget(prototype);
        after.prototypeContext = studioContext(prototype);
        after.index = Array.prototype.indexOf.call(insertParent.children, prototype);
        after.sequence = studioSequence(insertParent);
      } else studioBind(after.prototypeTarget, prototype);
      effect = { el: prototype, changed: true, undo: function () {
        if (prototype.parentNode !== insertParent) return !prototype.isConnected;
        prototype.remove(); return true;
      } };
    } else if (edit.kind === 'image') {
      if (el.tagName !== 'IMG') studioError('Select an image element.');
      if (property === 'alt') {
        if (typeof after.value !== 'string' || after.value.length > 4096) studioError('Invalid alt text.');
        var oldAlt = el.getAttribute('alt');
        if (oldAlt === after.value) return studioNoEffect(el);
        if (!recording && oldAlt !== before.value) studioError('The image alt text changed in source.');
        el.setAttribute('alt', after.value);
        effect = { el: el, changed: true, undo: function () {
          if (el.getAttribute('alt') !== after.value) return false;
          if (oldAlt == null) el.removeAttribute('alt'); else el.setAttribute('alt', oldAlt);
          return true;
        } };
      } else {
        var asset = studioImageAsset(after), preview = studio.assets[asset.assetId];
        if (!preview) studioError('Image asset preview unavailable: ' + asset.assetId + '. Import or restore the asset.');
        var oldImage = ['src', 'srcset', 'sizes', 'alt', 'data-rayfin-studio-asset'].map(function (name) { return { name: name, value: el.getAttribute(name) }; });
        if (!recording && !studioEqual(studioImageValue(el), before.value)) studioError('The source image or responsive image attributes changed.');
        var sources = el.parentElement && el.parentElement.tagName === 'PICTURE' ? Array.prototype.slice.call(el.parentElement.querySelectorAll('source'), 0, 20) : [];
        var oldSources = sources.map(function (source) { return { el: source, value: source.getAttribute('srcset') }; });
        el.setAttribute('src', preview); el.removeAttribute('srcset'); el.removeAttribute('sizes');
        el.setAttribute('data-rayfin-studio-asset', asset.assetId);
        if (asset.alt != null) el.setAttribute('alt', asset.alt); else el.removeAttribute('alt');
        sources.forEach(function (source) { source.removeAttribute('srcset'); });
        effect = { el: el, changed: true, undo: function () {
          if (el.getAttribute('src') !== preview) return false;
          oldImage.forEach(function (attr) {
            if (attr.value == null) el.removeAttribute(attr.name); else el.setAttribute(attr.name, attr.value);
          });
          oldSources.forEach(function (source) { if (!source.el.hasAttribute('srcset') && source.value != null) source.el.setAttribute('srcset', source.value); });
          return true;
        } };
      }
    } else if (edit.kind === 'chart') {
      var oldVisual = studioChartVisual(readSpec(el));
      if (studioEqual(oldVisual, after.value)) return studioNoEffect(el);
      if (!recording && !studioEqual(oldVisual, before.value)) studioError('The chart configuration changed in source.');
      studioWriteChart(el, after.value);
      effect = { el: el, changed: true, undo: function () {
        if (!studioEqual(studioChartVisual(readSpec(el)), after.value)) return false;
        studioWriteChart(el, oldVisual); return true;
      } };
    } else if (edit.kind === 'comment') {
      if (typeof after.value !== 'string' || !after.value.trim() || after.value.length > 3000) studioError('A comment must contain between 1 and 3000 characters.');
      var pin = h('button', { class: 'pin', title: after.value, 'aria-label': after.value });
      pin.__entry = { el: el, studio: true, transactionId: transactionId };
      pin.onclick = function (e) { e.preventDefault(); e.stopPropagation(); studioChoose(el, false); studio.notice = after.value; studioPublish(); };
      elPins.appendChild(pin);
      effect = { el: el, changed: false, undo: function () { pin.remove(); return true; } };
    } else if (edit.kind === 'annotation') {
      var annotation = studioDrawNode(after);
      elDraw.appendChild(annotation);
      effect = { el: el, changed: false, annotation: annotation, undo: function () { annotation.remove(); return true; } };
    } else studioError('Unsupported journal edit kind: ' + edit.kind);
    if (recording && edit.kind !== 'remove') after.context = studioContext(el);
    if (effect.changed) studioProjectedDocument = true;
    return effect;
  }
  function studioUndoEffects(effects) {
    var clean = true;
    for (var i = effects.length - 1; i >= 0; i--) {
      try { if (effects[i].undo() === false) clean = false; }
      catch (e) { clean = false; }
    }
    return clean;
  }
  function studioUnproject() {
    if (!studio) return;
    studioSilence(function () {
      for (var i = studio.applied.length - 1; i >= 0; i--) studioUndoEffects(studio.applied[i].effects);
      studio.applied = [];
    });
  }
  function studioApplyTransaction(tx, recording) {
    var effects = [];
    try {
      tx.edits.forEach(function (edit) {
        if (recording) {
          var el = studioResolve(edit.target, []);
          edit.before.context = studioContext(el);
          if (edit.kind === 'insert') edit.before.location.sequence = studioSequence(edit.after.placement === 'inside' ? el : el.parentElement);
          if (edit.kind === 'remove') edit.before.location = studioLocation(el);
        }
        effects.push(studioApplyEdit(edit, recording, tx.id));
      });
      if (recording) tx.edits.forEach(function (edit, i) {
        var target = studio.bindings.get(edit.target.id);
        if (target && target.isConnected) edit.after.context = studioContext(target);
        if (edit.kind === 'reorder' && target && target.isConnected) {
          edit.after.order.forEach(function (item) {
            var node = studio.bindings.get(item.target.id);
            if (node && node.isConnected) item.context = studioContext(node);
          });
        }
        if (edit.kind === 'insert') {
          var inserted = effects[i].el;
          if (inserted && inserted.isConnected) { edit.after.prototypeContext = studioContext(inserted); edit.after.sequence = studioSequence(inserted.parentElement); }
        }
        if (edit.kind === 'remove' && effects[i].parent) edit.after.sequence = studioSequence(effects[i].parent);
      });
      return effects;
    } catch (e) { studioUndoEffects(effects); throw e; }
  }
  function studioValidateHistory(history, cursor) {
    if (!Array.isArray(history) || history.length > STUDIO_LIMIT.history ||
      !Number.isInteger(cursor) || cursor < 0 || cursor > history.length) studioError('Invalid design history or cursor.');
    var copy = studioJson(history), ids = new Set();
    function persisted(value) {
      if (typeof value === 'string' && /^\s*(?:data:|blob:)/i.test(value)) studioError('Transient data/blob URLs cannot be persisted in a draft. Import images as assets.');
      if (value && typeof value === 'object') Object.keys(value).forEach(function (key) { persisted(value[key]); });
    }
    persisted(copy);
    copy.forEach(function (tx) {
      if (!tx || typeof tx.id !== 'string' || !tx.id || ids.has(tx.id) || typeof tx.label !== 'string' ||
        typeof tx.route !== 'string' || !tx.route.startsWith('/') || !Array.isArray(tx.edits) || !tx.edits.length || tx.edits.length > STUDIO_LIMIT.edits) studioError('Invalid design transaction.');
      ids.add(tx.id);
      tx.edits.forEach(function (edit) {
        if (!studioValidTarget(edit.target) || !studioPlain(edit.before) || !studioPlain(edit.after) ||
          ['style', 'text', 'remove', 'reorder', 'insert', 'image', 'theme', 'chart', 'comment', 'annotation'].indexOf(edit.kind) < 0) studioError('Invalid design edit.');
        if (edit.kind === 'image' && edit.property !== 'alt') studioImageAsset(edit.after);
        if (edit.scope) studioScope(edit.scope);
      });
    });
    return copy;
  }
  function studioRecapture(edit) {
    var bound = studio.bindings.get(edit.target.id), el;
    if (bound && bound.isConnected && studioAllowedElement(bound)) el = bound;
    else el = studioResolve(edit.target, studioContexts(edit));
    var current = studioBase(el), before;
    if (edit.kind === 'style' || edit.kind === 'theme') before = studioStoredStyle(studioStyleValue(el, edit.property));
    else if (edit.kind === 'text') before = studioReadText(el);
    else if (edit.kind === 'chart') before = { value: studioChartVisual(readSpec(el)) };
    else if (edit.kind === 'image') before = { value: edit.property === 'alt' ? el.getAttribute('alt') : studioImageValue(el) };
    else if (edit.kind === 'remove') before = { removed: false, location: studioLocation(el) };
    else if (edit.kind === 'insert') {
      var parent = edit.after.placement === 'inside' ? el : el.parentElement;
      before = { present: false, location: { parent: studioTarget(parent), parentContext: studioContext(parent), sequence: studioSequence(parent) } };
    } else if (edit.kind === 'reorder') {
      var layout = studioLayout(el);
      if (!layout) studioError('The layout is no longer reorderable.');
      before = studioOrderValue(el, layout.children);
    } else before = { value: null };
    before.context = current.context; before.source = current.source;
    edit.before = before; edit.target = current.target;
  }
  function studioReplay(rebase) {
    if (studio.compare) {
      var activeIds = studio.history.slice(0, studio.cursor).map(function (tx) { return tx.id; });
      studio.conflicts = studio.conflicts.filter(function (conflict) { return activeIds.indexOf(conflict.transactionId) >= 0; });
      return;
    }
    studio.conflicts = [];
    studioSilence(function () {
      studio.history.slice(0, studio.cursor).forEach(function (tx) {
        if (tx.route !== studio.route) { studio.conflicts.push({ transactionId: tx.id, message: 'This change belongs to ' + tx.route + ', not the current route.' }); return; }
        try {
          if (rebase) tx.edits.forEach(studioRecapture);
          var effects = studioApplyTransaction(tx, !!rebase);
          studio.applied.push({ transactionId: tx.id, effects: effects });
        } catch (e) { studio.conflicts.push({ transactionId: tx.id, message: e.message || String(e) }); }
      });
    });
    studio.dirty = false; studio.discoveryDirty = true;
  }
  function studioChanged() {
    studio.revision++;
    studio.verification = null;
    studio.discoveryDirty = true;
    studio.lastError = null;
    studio.dirty = false;
    studioChrome(); reposition(); studioPublish();
  }
  function studioDedup(edits) {
    var result = [], keys = new Map();
    edits.forEach(function (edit) {
      var key = ['style', 'theme', 'text', 'chart', 'image'].indexOf(edit.kind) >= 0 ? edit.target.id + '|' + edit.kind + '|' + edit.property + '|' + (edit.scope || '') : null;
      if (key && keys.has(key)) { result[keys.get(key)].after = edit.after; return; }
      if (key) keys.set(key, result.length);
      result.push(edit);
    });
    return result.filter(function (edit) {
      if (edit.kind === 'style' || edit.kind === 'theme') return edit.scope || edit.before.value !== edit.after.value || edit.before.priority !== edit.after.priority;
      if (edit.kind === 'text' || edit.kind === 'chart' || (edit.kind === 'image' && edit.property === 'alt')) return !studioEqual(edit.before.value, edit.after.value);
      return true;
    });
  }
  function studioCommit(label, edits) {
    edits = studioDedup(edits);
    if (!edits.length) return;
    if (edits.length > STUDIO_LIMIT.edits || studio.cursor >= STUDIO_LIMIT.history) studioError('The draft is full. Apply or discard changes before adding more.');
    var tx = { id: studioId('transaction'), label: label, route: studio.route, edits: edits };
    var effects = studioSilence(function () { return studioApplyTransaction(tx, true); });
    try {
      var next = studioValidateHistory(studio.history.slice(0, studio.cursor).concat([tx]), studio.cursor + 1);
      studio.history = next; studio.cursor = next.length;
      studio.applied.push({ transactionId: tx.id, effects: effects });
    } catch (e) { studioSilence(function () { studioUndoEffects(effects); }); throw e; }
    studioChanged();
  }
  function studioEndGesture(id) {
    if (!id || !studio) return;
    studio.closedGestures.add(id);
    if (studio.closedGestures.size > 256) studio.closedGestures.delete(studio.closedGestures.values().next().value);
  }
  function studioCancelGesture(continuing) {
    if (!studio || !studio.gesture) return true;
    var id = studio.gesture.id;
    var clean = studioSilence(function () { return studioUndoEffects(studio.gesture.effects); });
    studio.gesture = null;
    if (!continuing) studioEndGesture(id);
    reposition();
    return clean;
  }
  function studioStyleCommand(command) {
    var phase = command.phase || 'commit', id = command.gestureId;
    if (['preview', 'commit', 'cancel'].indexOf(phase) < 0 || (phase !== 'commit' && (typeof id !== 'string' || !id || id.length > 160))) studioError('Continuous controls require a gesture ID and valid phase.');
    if (id != null && (typeof id !== 'string' || !id || id.length > 160)) studioError('Invalid style gesture ID.');
    if (!studioPlain(command.values) || Object.keys(command.values).length > 80) studioError('Invalid style values.');
    if (id && studio.closedGestures.has(id)) {
      if (phase === 'cancel') return;
      studioError('This gesture has ended. Start a new gesture.');
    }
    if (phase === 'cancel') {
      if (studio.gesture && studio.gesture.id !== id) studioError('This gesture has already ended.');
      if (!studioCancelGesture()) studioError('The app changed during this gesture. Its newer values were preserved.');
      studioEndGesture(id);
      return;
    }
    var scope = studioScope(command.scope), selection = studioSelectionElements();
    if (studio.gesture && studio.gesture.id !== id) studioFinishGesture();
    if (studio.gesture && (studio.gesture.scope !== scope || !studioEqual(studio.gesture.targets, selection.map(function (el) { return studioTarget(el).id; })))) studioError('Selection or scope changed during the gesture.');
    var previous = studio.gesture, merged = {};
    if (previous) Object.keys(previous.values).forEach(function (key) { merged[key] = previous.values[key]; });
    Object.keys(command.values).forEach(function (key) { merged[cssName(key)] = command.values[key]; });
    // Validate all members before undoing the previous optimistic frame.
    selection.forEach(function (el) { Object.keys(merged).forEach(function (key) { studioCssValue(key, merged[key], el.style.getPropertyPriority(key), false); }); });
    if (!studioCancelGesture(true)) { studioEndGesture(id); studioError('The app changed during this gesture; the gesture was cancelled.'); }
    var edits = [];
    selection.forEach(function (el) { Object.keys(merged).forEach(function (key) { edits.push(studioStyleEdit(el, key, merged[key], scope, false)); }); });
    if (phase === 'commit') {
      try { studioCommit('Change ' + Object.keys(merged).map(humanProp).join(', '), edits); }
      finally { studioEndGesture(id); }
      return;
    }
    var tx = { id: studioId('gesture'), label: 'Change style', route: studio.route, edits: edits };
    var effects = studioSilence(function () { return studioApplyTransaction(tx, true); });
    studio.gesture = { id: id, effects: effects, values: merged, scope: scope, targets: selection.map(function (el) { return studioTarget(el).id; }) };
    reposition();
  }
  function studioFinishGesture() {
    if (!studio.gesture) return;
    var gesture = studio.gesture;
    studioStyleCommand({ type: 'style', values: gesture.values, scope: gesture.scope, gestureId: gesture.id, phase: 'commit' });
  }

  // ---- Studio: event-driven discovery, snapshots and projection lifecycle --
  function studioDiscover() {
    if (!studio.discoveryDirty && studio.discovery) return studio.discovery;
    var nodes = [], layers = [], stack = document.body ? [document.body] : [], examined = 0;
    while (stack.length && examined++ < STUDIO_LIMIT.nodes) {
      var el = stack.pop();
      if (!studioAllowedElement(el)) continue;
      nodes.push(el);
      if (layers.length < 200) layers.push(studioTarget(el));
      if (studioFormControl(el) || chartRoot(el) === el || /^(SVG|CANVAS|VIDEO|AUDIO)$/i.test(el.tagName)) continue;
      for (var i = Math.min(el.children.length, STUDIO_LIMIT.children) - 1; i >= 0; i--) stack.push(el.children[i]);
    }
    var tokens = [], names = new Set(), breakpoints = new Set(), rulesRead = 0, inaccessible = false;
    function addTokens(style, targets) {
      for (var i = 0; style && i < style.length && i < 160 && tokens.length < 120; i++) {
        var name = style[i];
        if (!/^--[a-zA-Z0-9_-]{1,100}$/.test(name)) continue;
        targets.slice(0, 8).forEach(function (target) {
          var descriptor = studioTarget(target), key = descriptor.id + ':' + name;
          if (names.has(key) || tokens.length >= 120) return;
          var value = getComputedStyle(target).getPropertyValue(name).trim() || style.getPropertyValue(name).trim();
          if (!value || value.length > 512 || /url\s*\(/i.test(value)) return;
          names.add(key);
          var kind = /^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|color\()/.test(value) || /color|background|foreground|accent/.test(name) ? 'color' :
            /^-?\d*\.?\d+(px|rem|em|%|vh|vw)$/.test(value) ? 'length' : /font|family/.test(name) ? 'font' : 'other';
          tokens.push({ name: name, value: value, kind: kind, target: descriptor });
        });
      }
    }
    function visitRules(rules, depth) {
      if (!rules || depth > 5) return;
      for (var ri = 0; ri < rules.length && rulesRead++ < 1200; ri++) {
        var rule = rules[ri];
        if (rule.media && rule.media.mediaText) {
          var media = rule.media.mediaText;
          if (/width|height/.test(media) && media.length <= 240 && breakpoints.size < 24) breakpoints.add(media);
        }
        if (rule.selectorText && rule.style && rule.style.cssText.indexOf('--') >= 0) addTokens(rule.style, studioQuery(rule.selectorText));
        if (rule.cssRules) visitRules(rule.cssRules, depth + 1);
      }
    }
    nodes.concat(document.documentElement ? [document.documentElement] : []).forEach(function (node) { addTokens(node.style, [node]); });
    for (var si = 0; si < document.styleSheets.length && si < 60; si++) {
      try { visitRules(document.styleSheets[si].cssRules, 0); }
      catch (e) { inaccessible = true; } // Browsers prohibit reading cross-origin CSSOM.
    }
    if (studio.bindings.size > 2400) studio.bindings.forEach(function (node, id) {
      if (!node.isConnected) { studio.bindings.delete(id); studio.identities.delete(id); }
    });
    studio.discovery = { layers: layers, tokens: tokens, breakpoints: Array.from(breakpoints) };
    studio.discoveryDirty = false;
    studio.discoveryNotice = inaccessible ? 'Some cross-origin stylesheets cannot be inspected; token and breakpoint discovery is partial.' : (stack.length ? 'The layer outline is limited to the first 1200 elements.' : null);
    return studio.discovery;
  }
  function studioSelection(el) {
    var target = studioTarget(el), cs = getComputedStyle(el), styles = {}, inline = {}, rect = el.getBoundingClientRect();
    STUDIO_STYLES.forEach(function (property) {
      var computed = cs.getPropertyValue(property).trim();
      if (computed && computed.length <= 1024 && !/(?:data:image\/|blob:)/i.test(computed)) styles[property] = computed;
      var value = el.style.getPropertyValue(property);
      if (value && value.length <= 1024 && !/(?:data:|blob:)/i.test(value)) inline[property] = value + (el.style.getPropertyPriority(property) ? ' !important' : '');
    });
    var out = Object.assign({}, target, {
      styles: styles, inlineStyles: inline, textEditable: studioCanText(el), ownText: studioNorm(studioOwn(el)).slice(0, 4096),
      width: Math.round(rect.width * 100) / 100, height: Math.round(rect.height * 100) / 100,
      children: studioFormControl(el) ? [] : Array.prototype.slice.call(el.children, 0, 40).filter(studioAllowedElement).map(studioTarget),
      canContain: studioCanContain(el), canReorder: !!studioLayout(el.parentElement)
    });
    if (el.parentElement && studioAllowedElement(el.parentElement)) out.parent = studioTarget(el.parentElement);
    if (el.tagName === 'IMG') {
      var source = el.getAttribute('src') || '';
      out.image = { src: source.length < 2048 && !/^(?:data:|blob:)/i.test(source) ? source : '', alt: (el.getAttribute('alt') || '').slice(0, 4096) };
    }
    var chart = chartRoot(el);
    if (chart) {
      var raw = chart.getAttribute('data-graphein-spec'), cached = studio.chartCache.get(chart);
      if (!cached || cached.raw !== raw) {
        var spec = readSpec(chart);
        if (spec) {
          var shape = shapeOf(spec), visual;
          try { visual = studioChartVisual(spec, true); }
          catch (e) { visual = { type: spec.type || '', __studioOmitted: ['oversized configuration'] }; studio.notice = e.message; }
          cached = { raw: raw, chart: { spec: visual, types: CHART_TYPES.map(function (type) {
            var result = canConvert(shape, type);
            return { value: type, label: typeLabel(type) + (!result.ok && result.reason ? ' · ' + result.reason : ''), enabled: result.ok };
          }) } };
          studio.chartCache.set(chart, cached);
        }
      }
      if (cached) out.chart = cached.chart;
    }
    return out;
  }
  function studioEmpty(sessionId, documentId, error, commandId, route) {
    var out = {
      protocol: 1, sessionId: sessionId || '', documentId: documentId || '', revision: 0, enabled: false,
      route: route || '', tool: 'select', compare: false, selection: [], layers: [], tokens: [], breakpoints: [],
      viewport: { width: 0, height: 0 }, history: [], cursor: 0, conflicts: [], acknowledged: commandId ? [commandId] : []
    };
    if (error) out.error = error;
    return out;
  }
  function studioSnapshot(error, commandId) {
    if (!studio) return studioEmpty('', '', error, commandId, '');
    var discovery, selections = [];
    try {
      discovery = studioDiscover();
      selections = (state.selection || []).filter(function (el) { return el.isConnected && studioAllowedElement(el); }).slice(0, STUDIO_LIMIT.selection).map(studioSelection);
    } catch (e) {
      discovery = studio.discovery || { layers: [], tokens: [], breakpoints: [] };
      error = error || ('Unable to inspect the app: ' + (e.message || e));
    }
    var acknowledged = studio.acknowledged.slice();
    if (commandId && acknowledged.indexOf(commandId) < 0) acknowledged.push(commandId);
    var out = {
      protocol: 1, sessionId: studio.sessionId, documentId: studio.documentId, revision: studio.revision,
      enabled: state.enabled, route: studio.route, tool: state.tool, compare: studio.compare,
      selection: selections, layers: discovery.layers, tokens: discovery.tokens, breakpoints: discovery.breakpoints,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      history: studio.history, cursor: studio.cursor, conflicts: studio.conflicts, acknowledged: acknowledged
    };
    var reportedError = error === undefined ? studio.lastError : error;
    if (reportedError) out.error = reportedError;
    if (studio.notice || studio.discoveryNotice) out.notice = studio.notice || studio.discoveryNotice;
    if (studio.verification) out.verification = studio.verification;
    try { return studioJson(out, STUDIO_LIMIT.journal + 600000); }
    catch (e) {
      var compact = studioEmpty(studio.sessionId, studio.documentId, 'Snapshot metadata exceeded its limit: ' + (e.message || e), null, studio.route);
      Object.assign(compact, {
        revision: studio.revision, enabled: state.enabled, tool: state.tool, compare: studio.compare,
        viewport: out.viewport, history: studioJson(studio.history), cursor: studio.cursor,
        conflicts: studioJson(studio.conflicts), acknowledged: acknowledged
      });
      return compact;
    }
  }
  function studioChrome() {
    if (!studio || !host) return;
    var hidden = studio.compare || studio.capture || state.tool === 'interact';
    host.style.display = hidden ? 'none' : '';
    [elToolbar, elInspector, elLegend, elChanges, elMorph].forEach(function (node) { if (node) node.style.display = 'none'; });
    if (elDraw) elDraw.style.pointerEvents = !hidden && state.tool === 'draw' ? 'auto' : 'none';
    if (hidden) { clearGuides(); state.hoverEl = null; }
    studioPopupSync();
  }
  function studioRelevantMutation(record) {
    var target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    return !!target && !isOurs(target) && !(target.closest && target.closest('[data-rayfin-studio-chrome]'));
  }
  function studioObserve() {
    studio.observer = new MutationObserver(function (records) {
      if (!studio || studio.mutating || !records.some(studioRelevantMutation)) return;
      studio.dirty = true; studio.discoveryDirty = true;
      if (!studio.refreshTimer) studio.refreshTimer = setTimeout(function () {
        if (!studio) return;
        studio.refreshTimer = 0;
        try { studioRefresh(); studioPublish(); }
        catch (e) { studio.lastError = 'Unable to reconcile the app: ' + (e.message || e); studioPublish(); }
      }, 80);
    });
    studio.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window.addEventListener('popstate', studioRouteEvent);
    window.addEventListener('hashchange', studioRouteEvent);
    window.addEventListener('resize', studioRouteEvent);
    window.addEventListener('pointercancel', studioPointerCancel, true);
    window.addEventListener('keyup', studioKeyUp, true);
    window.addEventListener('click', studioClick, true);
  }
  function studioRouteEvent() {
    if (!studio) return;
    studio.dirty = true;
    studioRefresh(); studioPublish();
  }
  function studioRefresh() {
    if (!studio || studio.mutating) return;
    if (studio.observer && studio.observer.takeRecords().some(studioRelevantMutation)) { studio.dirty = true; studio.discoveryDirty = true; }
    var route = studioRoute(), routeChanged = route !== studio.route;
    var viewportChanged = studio.viewportWidth !== window.innerWidth || studio.viewportHeight !== window.innerHeight;
    if (studio.gesture && studio.gesture.targets.some(function (id) { var node = studio.bindings.get(id); return !node || !node.isConnected; })) {
      studioCancelGesture(); studio.lastError = 'The selection was replaced during a gesture; the gesture was cancelled.';
    }
    if (studio.pointer && studio.pointer.el && !studio.pointer.el.isConnected) studioFinishPointer(true);
    if (studio.keyGesture && studio.keyGesture.bases.some(function (base) { return !base.el.isConnected; })) studioFinishKey(true);
    if (studio.text && !studio.text.el.isConnected) studioFinishText(true);
    if (routeChanged) {
      studioFinishText(true); studioFinishPointer(true); studioCancelGesture();
      exitDebugView(); restoreCaptureAffordances(); studio.capture = false;
      studioUnproject();
      studio.route = route; studio.documentId = studioDocumentIdentity(); studio.epoch = studioEpoch;
      studio.compare = false; studio.verification = null; studio.acknowledged = []; studio.results.clear();
      state.selected = null; state.selection = []; state.hoverEl = null;
      studio.dirty = true;
    }
    if ((studio.dirty || viewportChanged) && !studio.gesture && !studio.pointer && !studio.keyGesture && !studio.text && !state.debugView && !studio.capture) {
      var selectedTargets = (state.selection || []).map(studioTarget);
      if (!routeChanged) studioUnproject();
      if (!host || !host.isConnected) buildUI();
      studioReplay(false);
      state.selection = selectedTargets.map(function (target) {
        var bound = studio.bindings.get(target.id);
        if (bound && bound.isConnected) return bound;
        try { return studioResolve(target, []); } catch (e) { return null; }
      }).filter(Boolean);
      state.selected = state.selection[state.selection.length - 1] || null;
      if (state.selected) showHandles(); else hideHandles();
      studio.viewportWidth = window.innerWidth; studio.viewportHeight = window.innerHeight;
      studioChrome(); reposition();
    }
  }
  function studioChoose(el, toggle) {
    if (!studioAllowedElement(el)) studioError('This surface is not editable.');
    studioPopupFinish(false);
    studioFinishKey(false);
    studioFinishPointer(true); studioFinishGesture(); studioFinishText(false);
    if (toggle && (state.selection || []).length >= STUDIO_LIMIT.selection && state.selection.indexOf(el) < 0) studioError('Select at most 40 elements.');
    if (toggle) toggleSelect(el); else select(el);
    studioTarget(el); studio.notice = /^(CANVAS|IFRAME|VIDEO)$/i.test(el.tagName) && !chartRoot(el) ? 'This surface has no editable DOM content; only its container appearance can be changed.' : null;
    studioChrome(); studioPublish();
  }
  function studioSetTool(tool) {
    if (['select', 'interact', 'comment', 'draw'].indexOf(tool) < 0) studioError('Unknown design tool.');
    studioPopupFinish(false);
    studioFinishText(false); studioFinishPointer(true); studioFinishGesture(); studioFinishKey(false); closeCommentEditor();
    if (state.debugView) exitDebugView();
    state.tool = tool; state.hoverEl = null;
    studioChrome(); reposition();
  }
  function studioHistoryChange(next, cursor, rebase) {
    var previous = studioJson(studio.history), previousCursor = studio.cursor;
    studioFinishText(true); studioFinishPointer(true); studioCancelGesture(); exitDebugView();
    studioUnproject();
    try {
      studio.history = next; studio.cursor = cursor;
      studioReplay(rebase);
      studio.history = studioValidateHistory(studio.history, studio.cursor);
    } catch (e) {
      studioUnproject(); studio.history = previous; studio.cursor = previousCursor;
      studioReplay(false); throw e;
    }
    state.selection = (state.selection || []).filter(function (el) { return el.isConnected; });
    state.selected = state.selection[state.selection.length - 1] || null;
    studioChanged();
  }
  function studioClearHistory() {
    studioFinishText(true); studioFinishPointer(true); studioCancelGesture(); studioFinishKey(true);
    exitDebugView(); closeCommentEditor();
    var changed = studio.history.length > 0;
    // Clear accepts the current DOM as the new baseline. Unlike Discard, it
    // drops inverse effects without running them; it is not proof of source.
    studio.history = []; studio.cursor = 0; studio.applied = []; studio.conflicts = [];
    studio.sources.clear(); studio.identities.clear();
    studio.compare = false; studio.verification = null;
    studio.discoveryDirty = true; studio.dirty = false;
    clearPins(); clearDrawings();
    studio.notice = 'History cleared; the current app DOM was preserved. Reload to verify source.';
    if (changed) studioChanged();
  }
  function studioReject(envelope, message) {
    var out;
    var session = studio || studioRelay;
    var documentId = studio ? studio.documentId : studioRelay && studioRelay.snapshot ? studioRelay.snapshot.documentId : '';
    if (!session || !envelope || envelope.sessionId !== session.sessionId || envelope.documentId !== documentId) {
      return studioEmpty(envelope && envelope.sessionId, envelope && envelope.documentId, message, envelope && envelope.commandId, '/');
    }
    if (studio) out = studioSnapshot(message, envelope && envelope.commandId);
    else if (studioRelay && studioRelay.snapshot) {
      out = studioJson(studioRelay.snapshot);
      out.error = message;
      if (envelope && envelope.commandId && out.acknowledged.indexOf(envelope.commandId) < 0) out.acknowledged.push(envelope.commandId);
    } else out = studioEmpty(envelope && envelope.sessionId, envelope && envelope.documentId, message, envelope && envelope.commandId, studioRelay && studioRelay.options.route);
    return out;
  }
  function studioAck(envelope, error) {
    studio.acknowledged.push(envelope.commandId);
    if (studio.acknowledged.length > 128) studio.acknowledged.shift();
    studio.results.set(envelope.commandId, { error: error || null });
    if (studio.results.size > 256) studio.results.delete(studio.results.keys().next().value);
    studio.lastError = error || null;
    studioPublish();
    return studioSnapshot();
  }
  function studioRunCommand(c) {
    if (studio.popup && studio.popup.edit && c.type !== 'style') {
      studioPopupFinish(c.type === 'capture' && studio.popup.edit.kind === 'slider');
    }
    if ((c.type === 'undo' || c.type === 'redo') && studio.text) studioFinishText(false);
    if (c.type === 'style') { studioStyleCommand(c); return; }
    if (['undo', 'redo', 'discard', 'clear', 'reset', 'compare', 'capture'].indexOf(c.type) < 0) studioFinishGesture();
    var selection, edits, next, index;
    switch (c.type) {
      case 'select':
        studioChoose(studioResolve(c.target, []), !!c.toggle); break;
      case 'tool':
        studioSetTool(c.tool); break;
      case 'text':
        studioCommit('Edit text', studioSelectionElements().map(function (el) { return studioTextEdit(el, c.value); })); break;
      case 'undo': case 'redo':
        studioCancelGesture(); studioFinishPointer(true);
        index = studio.cursor + (c.type === 'undo' ? -1 : 1);
        if (index >= 0 && index <= studio.history.length && index !== studio.cursor) studioHistoryChange(studio.history, index, false);
        break;
      case 'discard':
        studioCancelGesture(); studioFinishPointer(true); studioFinishText(true);
        if (studio.history.length) studioHistoryChange([], 0, false);
        state.selection = []; state.selected = null; closeCommentEditor(); break;
      case 'clear':
        studioClearHistory(); break;
      case 'reset':
        selection = studioSelectionElements().map(function (el) { return studioTarget(el).id; });
        next = studioJson(studio.history).map(function (tx) {
          tx.edits = tx.edits.filter(function (edit) { return selection.indexOf(edit.target.id) < 0; }); return tx;
        });
        index = next.slice(0, studio.cursor).filter(function (tx) { return tx.edits.length; }).length;
        next = next.filter(function (tx) { return tx.edits.length; });
        if (!studioEqual(next, studio.history)) studioHistoryChange(next, index, true);
        break;
      case 'revert':
        index = studio.history.findIndex(function (tx) { return tx.id === c.transactionId; });
        if (index < 0) studioError('That transaction no longer exists.');
        next = studioJson(studio.history); next.splice(index, 1);
        studioHistoryChange(next, studio.cursor - (index < studio.cursor ? 1 : 0), true);
        break;
      case 'retarget':
        index = studio.history.findIndex(function (tx) { return tx.id === c.transactionId; });
        if (index < 0) studioError('That transaction no longer exists.');
        selection = [studioResolve(c.target, [])];
        var targetIds = new Set(studio.history[index].edits.map(function (edit) { return edit.target.id; }));
        if (targetIds.size !== 1) studioError('A multi-target transaction cannot be retargeted to one element. Revert it and reapply to a new selection.');
        studio.history[index].edits.forEach(function (edit) {
          if (edit.kind === 'text' && !studioCanText(selection[0])) studioError('Retarget text to an element with editable own text.');
          if (edit.kind === 'chart' && !selection[0].hasAttribute('data-graphein-spec')) studioError('Retarget a chart edit to a Graphein chart root.');
          if (edit.kind === 'image' && selection[0].tagName !== 'IMG') studioError('Retarget an image edit to an image.');
          if (edit.kind === 'reorder') studioError('Reordering cannot be retargeted to a different container. Reapply it to the intended siblings.');
          if (edit.kind === 'insert' && !studioCanContain(edit.after.placement === 'inside' ? selection[0] : selection[0].parentElement)) studioError('Choose a valid insertion container.');
        });
        next = studioJson(studio.history);
        next[index].route = studio.route;
        next[index].edits.forEach(function (edit) {
          edit.target = studioTarget(selection[0]);
          edit.before.context = studioContext(selection[0]); edit.before.source = edit.before.context;
        });
        studioHistoryChange(next, studio.cursor, true);
        break;
      case 'compare':
        if (typeof c.enabled !== 'boolean') studioError('Invalid comparison state.');
        studioFinishPointer(true); studioCancelGesture(); studioFinishText(true); exitDebugView();
        if (studio.compare !== c.enabled) {
          studioUnproject(); studio.compare = c.enabled;
          if (!c.enabled) studioReplay(false);
        }
        break;
      case 'capture':
        if (typeof c.enabled !== 'boolean') studioError('Invalid capture state.');
        if (c.enabled) { studioFinishText(false); studioFinishPointer(false); studioFinishGesture(); exitDebugView(); stripCaptureAffordances(); hideHint(); }
        else restoreCaptureAffordances();
        studio.capture = c.enabled; break;
      case 'freeMove':
        if (typeof c.enabled !== 'boolean') studioError('Invalid movement mode.');
        studioFinishPointer(true); studio.freeMove = c.enabled;
        studio.notice = c.enabled ? 'Free move uses visual transform offsets, not responsive layout reflow.' : 'Dragging reorders within supported layout containers.';
        break;
      case 'move':
        if (c.direction !== 'previous' && c.direction !== 'next') studioError('Invalid movement direction.');
        selection = studioSelectionElements();
        if (c.free || studio.freeMove) {
          edits = selection.map(function (el) {
            var original = el.style.transform, offset = parseTranslate(original), base = stripTranslate(original);
            return studioStyleEdit(el, 'transform', (base ? base + ' ' : '') + 'translate(' + (offset.x + (c.direction === 'previous' ? -1 : 1)) + 'px, ' + offset.y + 'px)', '', false);
          });
          studioCommit('Move with transform', edits);
        } else {
          var reorder = studioMoveEdit(selection, c.direction);
          if (reorder) studioCommit('Reorder ' + c.direction, [reorder]); else studio.notice = 'Already at the edge of this container.';
        }
        break;
      case 'remove':
        selection = studioSelectionElements();
        selection = selection.filter(function (el) { return !selection.some(function (parent) { return parent !== el && parent.contains(el); }); });
        studioCommit('Remove selection', selection.map(studioRemoveEdit));
        state.selection = []; state.selected = null; break;
      case 'duplicate':
        selection = studioSelectionElements();
        edits = selection.map(function (el) { return studioInsertEdit(el, studioSafeHtml(el.outerHTML, true), 'after', 'duplicate'); });
        studioCommit('Duplicate as visual prototype', edits);
        studio.notice = 'Duplicates are static visual prototypes. IDs, handlers and bindings are not cloned; Apply must wire real components.';
        break;
      case 'insert':
        if (!Object.prototype.hasOwnProperty.call(STUDIO_BLOCKS, c.block)) studioError('Unknown block preset.');
        edits = studioSelectionElements().map(function (el) { return studioInsertEdit(el, STUDIO_BLOCKS[c.block], c.placement, c.block); });
        studioCommit('Insert ' + c.block, edits);
        studio.notice = 'Inserted blocks are visual prototypes until Apply updates source and behavior.';
        break;
      case 'image':
        selection = studioSelectionElements();
        studioValidateAsset(c.assetId, c.dataUrl);
        if (selection.some(function (el) { return el.tagName !== 'IMG'; }) || (c.alt != null && (typeof c.alt !== 'string' || c.alt.length > 4096))) studioError('Select only images and provide valid alt text.');
        studio.assets[c.assetId] = c.dataUrl;
        edits = selection.map(function (el) {
          var base = studioBase(el), alt = c.alt != null ? c.alt : el.getAttribute('alt');
          return { kind: 'image', target: base.target, property: 'asset',
            before: { value: studioImageValue(el), context: base.context, source: base.source },
            after: { assetId: c.assetId, alt: alt, value: { assetId: c.assetId, alt: alt }, context: base.context } };
        });
        studioCommit('Replace image', edits); break;
      case 'attribute':
        if (c.name !== 'alt' || typeof c.value !== 'string' || c.value.length > 4096) studioError('Only image alt text can be edited as an attribute.');
        edits = studioSelectionElements().map(function (el) {
          if (el.tagName !== 'IMG') studioError('Select only image elements to edit alt text.');
          var base = studioBase(el);
          return { kind: 'image', target: base.target, property: 'alt', before: { value: el.getAttribute('alt'), context: base.context, source: base.source }, after: { value: c.value, context: base.context } };
        });
        studioCommit('Edit image alt text', edits); break;
      case 'theme':
        if (!Array.isArray(c.values) || !c.values.length || c.values.length > 120) studioError('Choose discovered app theme tokens.');
        var discovered = studioDiscover().tokens;
        edits = c.values.map(function (item) {
          var token = item.token, found = token && discovered.find(function (known) { return known.name === token.name && known.target.id === token.target.id; });
          if (!found) studioError('That token was not discovered in this app scope.');
          return studioStyleEdit(studioResolve(found.target, []), found.name, item.value, '', true);
        });
        studioCommit('Change app theme', edits); break;
      case 'chart':
        studioCommit('Edit chart', studioSelectionElements().map(function (el) { return studioChartPatch(el, c.patch); })); break;
      case 'debug':
        if (typeof c.enabled !== 'boolean') studioError('Invalid chart debug state.');
        if (!c.enabled) exitDebugView();
        else {
          selection = studioSelectionElements();
          if (selection.length !== 1 || !chartRoot(selection[0])) studioError('Select one Graphein chart to inspect.');
          enterDebugView(chartRoot(selection[0]));
        }
        break;
      case 'comment':
        if (typeof c.value !== 'string' || !c.value.trim() || c.value.length > 3000) studioError('Enter a comment of at most 3000 characters.');
        edits = studioSelectionElements().map(function (el) {
          var base = studioBase(el);
          return { kind: 'comment', target: base.target, property: 'note', before: { value: null, context: base.context, source: base.source }, after: { value: c.value.trim(), context: base.context } };
        });
        studioCommit('Add comment', edits); break;
      case 'drawOptions':
        if (['pen', 'arrow', 'rect', 'ellipse'].indexOf(c.shape) < 0 || typeof c.color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(c.color)) studioError('Choose a drawing shape and hex color.');
        state.drawShape = c.shape; state.drawColor = c.color; break;
      case 'restyle':
        studioRestyle(c.patch); break;
      case 'generated':
        var clean = studioSafeHtml(c.html, false);
        edits = studioSelectionElements().map(function (el) { return studioInsertEdit(el, clean, 'inside', 'generated'); });
        studioCommit('Add generated visual prototype', edits);
        studio.notice = 'Generated markup was sanitized. It is a static prototype, not a live component.';
        break;
      case 'verify':
        studio.verification = studioVerify(c.history, c.cursor); break;
      default: studioError('Unknown Studio command: ' + c.type);
    }
    studioChrome(); reposition();
  }
  function studioRestyle(patch) {
    if (!studioPlain(patch) || !studioPlain(patch.styles)) studioError('The assistant returned no usable restyle patch.');
    var edits = [];
    studioSelectionElements().forEach(function (el) {
      Object.keys(patch.styles).forEach(function (property) {
        var key = property.toLowerCase();
        if (RESTYLE_ALLOWED[key]) edits.push(studioStyleEdit(el, key, patch.styles[property], '', false));
      });
      if (patch.graphein) edits.push(studioChartPatch(el, patch.graphein));
      if (patch.rules) {
        if (!Array.isArray(patch.rules) || patch.rules.length > 40) studioError('Too many descendant restyle rules.');
        patch.rules.forEach(function (rule) {
          if (!rule || !studioPlain(rule.styles)) studioError('Invalid descendant restyle rule.');
          var matches = studioQuery(rule.selector, el);
          if (!matches.length) studioError('A descendant restyle target is missing or ambiguous: ' + rule.selector);
          matches.slice(0, 60).forEach(function (child) {
            Object.keys(rule.styles).forEach(function (property) {
              var key = property.toLowerCase();
              if (RESTYLE_ALLOWED[key]) edits.push(studioStyleEdit(child, key, rule.styles[property], '', false));
            });
          });
        });
      }
    });
    if (!edits.length) studioError('The assistant returned no supported visual changes.');
    studioCommit('Restyle selection', edits);
  }

  // ---- Studio: point-and-change controls ----------------------------------
  function studioPopupCss() {
    var light = lumOf(PANEL_BG) > 0.55;
    var edge = mixc(PANEL_BG, TXT, light ? 0.13 : 0.18);
    var accentWash = mixc(PANEL_BG, TEAL, light ? 0.09 : 0.16);
    var accentInk = mixc(TXT, TEAL, light ? 0.48 : 0.62);
    var shadow = light ? '0 16px 44px #17263f18,0 3px 10px #17263f0d,inset 0 1px #ffffffcc' :
      '0 18px 48px #0006,0 4px 12px #0003,inset 0 1px #ffffff0a';
    return [
      '.studio-context{position:fixed;z-index:2147483646;pointer-events:auto;box-sizing:border-box;max-width:calc(100vw - 16px);padding:' + fpx(6) + ';border:1px solid ' + edge + ';border-radius:' + fpx(16) + ';background:' + rgbaOf(PANEL_BG, 0.97) + ';' + GLASS_FX + ';color:' + TXT + ';box-shadow:' + shadow + ';font-size:var(--fs-small);animation:studio-context-enter .16s cubic-bezier(.2,.8,.2,1)}',
      '.studio-context[hidden],.studio-options:empty{display:none!important}',
      '.studio-context[data-placement=above]{transform-origin:50% 100%}.studio-context[data-placement=below]{transform-origin:50% 0}',
      '.studio-context-row{display:flex;flex-wrap:wrap;align-items:center;gap:' + fpx(3) + '}',
      '.studio-context-label{color:' + TXT_DIM + ';font-size:var(--fs-micro);font-weight:500;padding:0 ' + fpx(9) + ';margin-right:' + fpx(2) + ';border-right:1px solid ' + edge + ';white-space:nowrap}',
      '.studio-context button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:' + fpx(6) + ';color:' + TXT_DIM + ';font-size:var(--fs-small);font-weight:500;line-height:1.25;padding:' + fpx(9) + ' ' + fpx(10) + ';border-radius:' + fpx(10) + ';white-space:nowrap;transition:background-color .13s,color .13s,box-shadow .13s,transform .13s}',
      '.studio-context button:hover{background:' + PANEL_BG2 + ';color:' + TXT + '}',
      '.studio-context button[data-studio-action][aria-expanded=true]{background:' + accentWash + ';color:' + accentInk + ';box-shadow:inset 0 0 0 1px ' + rgbaOf(TEAL, light ? 0.13 : 0.23) + '}',
      '.studio-context button:active{transform:scale(.97)}',
      '.studio-action-icon{display:flex;align-items:center;opacity:.85}.studio-action-icon svg{width:' + fpx(14) + ';height:' + fpx(14) + '}',
      '.studio-context button:focus-visible,.studio-context input:focus-visible{outline:2px solid ' + TEAL + ';outline-offset:2px}',
      '.studio-options{box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:' + edge + ' transparent;margin-top:' + fpx(6) + ';padding:' + fpx(14) + ' ' + fpx(12) + ' ' + fpx(11) + ';border-radius:' + fpx(11) + ';background:' + mixc(PANEL_BG, TXT, light ? 0.025 : 0.035) + ';box-shadow:inset 0 1px ' + rgbaOf(TXT, 0.035) + ';animation:studio-options-enter .14s ease-out}',
      '.studio-swatches{display:flex;flex-wrap:wrap;gap:' + fpx(7) + ';max-width:' + fpx(294) + ';padding:' + fpx(2) + '}',
      '.studio-context .studio-swatch{position:relative;width:' + fpx(34) + ';height:' + fpx(34) + ';padding:0;border-radius:50%;border:2px solid transparent;background:transparent;box-shadow:none}',
      '.studio-swatch::before{content:"";position:absolute;inset:' + fpx(3) + ';border-radius:50%;background:linear-gradient(var(--swatch),var(--swatch)),repeating-conic-gradient(#c6cbd2 0 25%,#f5f5f5 0 50%) 0/8px 8px;box-shadow:inset 0 0 0 1px #00000012,0 1px 3px #00000010}',
      '.studio-context .studio-swatch:hover{background:transparent;transform:translateY(-2px)}',
      '.studio-context .studio-swatch[aria-pressed=true]{border-color:' + TEAL + ';box-shadow:0 0 0 2px ' + rgbaOf(TEAL, 0.10) + '}',
      '.studio-swatch-check{position:relative;width:' + fpx(13) + ';height:' + fpx(13) + ';color:var(--swatch-ink);opacity:0;transform:scale(.7);transition:opacity .12s,transform .12s}',
      '.studio-swatch[aria-pressed=true] .studio-swatch-check{opacity:1;transform:scale(1)}',
      '.studio-context-feedback{margin-top:' + fpx(10) + ';font-size:var(--fs-micro);line-height:1.4;color:' + TXT_DIM + ';min-height:1.4em}',
      '.studio-range{width:' + fpx(245) + ';max-width:min(100%,calc(100vw - ' + fpx(52) + '));display:grid;gap:' + fpx(8) + '}',
      '.studio-range-heading{display:flex;align-items:center;justify-content:space-between;gap:' + fpx(16) + ';font-size:var(--fs-small);font-weight:500}',
      '.studio-range-labels{display:flex;justify-content:space-between;gap:' + fpx(12) + ';font-size:var(--fs-micro);color:' + TXT_DIM + '}',
      '.studio-range output{color:' + accentInk + ';background:' + accentWash + ';border-radius:' + fpx(6) + ';padding:' + fpx(4) + ' ' + fpx(7) + ';font-size:var(--fs-micro);font-variant-numeric:tabular-nums;min-width:' + fpx(42) + ';text-align:center}',
      '.studio-range input{display:block;appearance:none;-webkit-appearance:none;width:100%;height:' + fpx(27) + ';padding:0;border:0;margin:0;background:transparent;cursor:ew-resize;accent-color:' + TEAL + '}',
      '.studio-range input::-webkit-slider-runnable-track{height:' + fpx(5) + ';border-radius:9px;background:linear-gradient(to right,' + TEAL + ' 0%,' + TEAL + ' var(--studio-progress),' + edge + ' var(--studio-progress),' + edge + ' 100%)}',
      '.studio-range input::-moz-range-track{height:' + fpx(5) + ';border-radius:9px;background:' + edge + '}.studio-range input::-moz-range-progress{height:' + fpx(5) + ';border-radius:9px;background:' + TEAL + '}',
      '.studio-range input::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:' + fpx(17) + ';height:' + fpx(17) + ';margin-top:' + fpx(-6) + ';border:1px solid #0000001a;border-radius:50%;background:#fff;box-shadow:0 1px 5px #0003;transition:transform .12s,box-shadow .12s}',
      '.studio-range input::-moz-range-thumb{width:' + fpx(17) + ';height:' + fpx(17) + ';border:1px solid #0000001a;border-radius:50%;background:#fff;box-shadow:0 1px 5px #0003}',
      '.studio-range input:hover::-webkit-slider-thumb,.studio-range input:focus-visible::-webkit-slider-thumb{transform:scale(1.12);box-shadow:0 1px 5px #0003,0 0 0 4px ' + rgbaOf(TEAL, 0.13) + '}',
      '.studio-looks{display:flex;flex-wrap:wrap;gap:' + fpx(7) + '}',
      '.studio-context .studio-look{display:flex;flex-direction:column;gap:' + fpx(9) + ';padding:' + fpx(8) + ';width:' + fpx(78) + ';font-size:var(--fs-micro);border:1px solid transparent}',
      '.studio-context .studio-look:hover{transform:translateY(-2px);background:' + PANEL_BG2 + '}',
      '.studio-context .studio-look[aria-pressed=true]{border-color:' + rgbaOf(TEAL, 0.4) + ';background:' + accentWash + ';color:' + accentInk + '}',
      '.studio-look-sample{position:relative;display:flex;flex-direction:column;justify-content:center;gap:' + fpx(4) + ';width:100%;height:' + fpx(45) + ';padding:' + fpx(9) + ';box-sizing:border-box;overflow:hidden}',
      '.studio-look-line{height:' + fpx(3) + ';width:82%;border-radius:4px;background:var(--look-ink)}.studio-look-line:last-child{width:58%;opacity:.4}',
      '.studio-layout-group{display:grid;gap:' + fpx(7) + ';width:' + fpx(250) + ';max-width:min(100%,calc(100vw - ' + fpx(52) + '));margin-bottom:' + fpx(12) + '}',
      '.studio-layout-label{font-size:var(--fs-micro);font-weight:500;color:' + TXT_DIM + '}',
      '.studio-layout-choices{display:flex;gap:' + fpx(3) + ';padding:' + fpx(3) + ';border-radius:' + fpx(9) + ';background:' + PANEL_BG2 + '}',
      '.studio-layout-choices button{flex:1;min-width:min-content;padding:' + fpx(7) + ' ' + fpx(6) + ';font-size:var(--fs-micro)}',
      '.studio-layout-choices button[aria-pressed=true]{background:' + accentWash + ';color:' + accentInk + ';box-shadow:inset 0 0 0 1px ' + rgbaOf(TEAL, 0.18) + '}',
      '.studio-context-note{max-width:' + fpx(240) + ';font-size:var(--fs-small);color:' + TXT_DIM + ';line-height:1.5}',
      '@keyframes studio-context-enter{from{opacity:0;transform:translateY(3px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '@keyframes studio-options-enter{from{opacity:0}to{opacity:1}}',
      '@media(max-width:480px){.studio-action-icon{display:none}.studio-context button[data-studio-action]{padding-inline:' + fpx(8) + '}.studio-layout-align{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}}',
      '@media (prefers-reduced-motion:reduce){.studio-context,.studio-context *,.studio-context *::before,.studio-context *::after,.studio-context input::-webkit-slider-thumb{animation:none!important;transition:none!important}.studio-context button:hover,.studio-range input:hover::-webkit-slider-thumb,.studio-range input:focus-visible::-webkit-slider-thumb{transform:none!important}}'
    ].join('\n');
  }
  function studioPopupIcon(name) {
    var path = {
      Color: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none"/>',
      Size: '<path d="M2 4V2.5h12V4M8 2.5v11M5.5 13.5h5"/>',
      Weight: '<path d="M4 2.5h4a3 3 0 0 1 0 6H4m0-6v11h5a2.5 2.5 0 0 0 0-5H4"/>',
      Space: '<path d="M2 3v10M14 3v10M4.5 8h7M6 6.5 4.5 8 6 9.5M10 6.5 11.5 8 10 9.5"/>',
      Shape: '<path d="M3 13V7a4 4 0 0 1 4-4h6"/><path d="M3 13h10V3" opacity=".35"/>',
      Look: '<rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="M5.5 6h5M5.5 9h3"/>',
      Layout: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'
    }[name] || '';
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
  }
  function studioPopupButton(el) { return !!(el && el.matches && el.matches('button,[role="button"],a[href],input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]')); }
  function studioPopupFieldType(el) {
    if (!studioFormControl(el) || el.tagName !== 'INPUT') return 'text';
    return /^(checkbox|radio)$/.test(el.type) ? 'choice' : el.type === 'range' ? 'range' : el.type === 'color' ? 'color' : 'text';
  }
  function studioPopupLayoutKind(el) {
    if (!el || studioFormControl(el) || !el.children.length) return '';
    if (/^(UL|OL)$/.test(el.tagName) || el.getAttribute('role') === 'list') return 'list';
    var display = getComputedStyle(el).display;
    return /^(inline-)?flex$/.test(display) ? 'stack' : /^(inline-)?grid$/.test(display) ? 'grid' : '';
  }
  function studioPopupKind(el) {
    if (!studioAllowedElement(el) || chartRoot(el) || /^(OPTION|SVG|CANVAS|VIDEO|AUDIO|HTML|BODY)$/i.test(el.tagName)) return '';
    if (studioFormControl(el)) return el.tagName === 'INPUT' && el.type === 'hidden' ? '' : studioPopupButton(el) ? 'button' : 'field';
    if (el.closest('input,textarea,select,[contenteditable]:not([data-rayfin-studio-text])')) return '';
    if (studioPopupButton(el)) return 'button';
    if (studio && studio.text && studio.text.el === el) return 'text';
    var text = studioCanText(el) && !Array.prototype.some.call(el.children, function (child) { return /^(DIV|SECTION|ARTICLE|P|H[1-6]|UL|OL|TABLE)$/.test(child.tagName); });
    if (text && !/^(ARTICLE|SECTION|ASIDE|MAIN|NAV|HEADER|FOOTER|LI|UL|OL)$/.test(el.tagName) && el.getAttribute('role') !== 'list') return 'text';
    var layout = studioPopupLayoutKind(el);
    if (layout) return layout;
    if (/^(ARTICLE|SECTION|ASIDE|MAIN|NAV|HEADER|FOOTER|LI)$/.test(el.tagName)) return 'card';
    if (text) return 'text';
    if (studioCanContain(el) && el.children.length) {
      var cs = getComputedStyle(el);
      if (/flex|grid/.test(cs.display) || parseFloat(cs.paddingTop) || parseFloat(cs.paddingLeft) ||
        parseFloat(cs.borderTopWidth) || (cs.backgroundColor && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(cs.backgroundColor)) ||
        /(?:^|[-_\s])(card|panel|tile)(?:$|[-_\s])/i.test((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : ''))) return 'card';
    }
    return '';
  }
  function studioMeaningful(el) {
    if (!el || !el.closest || isOurs(el)) return null;
    if (studio && studio.text && studio.text.wrapper.contains(el)) return studio.text.el;
    var control = el.closest('input,textarea,select,[contenteditable]:not([data-rayfin-studio-text])');
    if (control) return studioAllowedElement(control) ? control : null;
    var chart = chartRoot(el);
    if (chart) return chart;
    var button = el.closest('button,[role="button"],a[href]');
    if (button && studioAllowedElement(button)) return button;
    var decoration = el.closest('[aria-hidden="true"],svg');
    if (decoration) el = decoration.parentElement;
    for (var i = 0; el && i < 10 && el !== document.body && el !== document.documentElement; i++, el = el.parentElement) {
      if (studioPopupKind(el)) return el;
    }
    return null;
  }
  function studioPopupMount() {
    if (!studio || !root) return;
    var node = h('div', { class: 'studio-context', role: 'toolbar', 'aria-label': 'Edit selection', hidden: '' });
    var row = h('div', { class: 'studio-context-row' }), options = h('div', { class: 'studio-options' });
    node.appendChild(row); node.appendChild(options); root.appendChild(node);
    studio.popup = { node: node, row: row, options: options, target: null, kind: '', option: '', edit: null, range: null, choices: [], feedback: null };
    node.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  }
  function studioPopupSync() {
    var p = studio && studio.popup;
    if (!p) return;
    var target = state.selection.length === 1 ? state.selected : null;
    var visible = studioInteractive() && state.tool === 'select' && !state.debugView && target && target.isConnected;
    var kind = visible ? studioPopupKind(target) : '';
    if (!kind) { p.node.hidden = true; if (p.range) p.range.closed = true; return; }
    if (target !== p.target || kind !== p.kind) {
      studioPopupFinish(false);
      p.target = target; p.kind = kind; p.option = ''; p.range = null; p.choices = []; p.feedback = null; p.options.textContent = ''; p.row.textContent = '';
      var labels = { text: 'Text', button: 'Button', card: 'Card', field: p.target.tagName === 'SELECT' ? 'Dropdown' : p.target.tagName === 'TEXTAREA' ? 'Text area' : 'Input', stack: 'Stack', list: 'List', grid: 'Grid' };
      p.row.appendChild(h('span', { class: 'studio-context-label', text: labels[kind] }));
      var actions = kind === 'text' ? ['Color', 'Size', 'Weight'] : kind === 'button' ? ['Color', 'Shape', 'Look'] :
        kind === 'field' ? (studioPopupFieldType(target) === 'choice' || studioPopupFieldType(target) === 'range' ? ['Color', 'Size'] : studioPopupFieldType(target) === 'color' ? ['Size', 'Shape'] : ['Color', 'Size', 'Shape']) :
          /^(stack|list|grid)$/.test(kind) ? ['Color', 'Space', 'Layout'] : ['Color', 'Space', 'Look'];
      actions.forEach(function (name) {
        var button = h('button', { type: 'button', 'data-studio-action': name, 'aria-expanded': 'false' }, [
          h('span', { class: 'studio-action-icon', 'aria-hidden': 'true', html: studioPopupIcon(name) }),
          h('span', { text: name })
        ]);
        button.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          try { studioPopupOpen(name); } catch (error) { studioGestureError(error); }
        });
        p.row.appendChild(button);
      });
    }
    p.node.hidden = false;
    if (p.range && !p.edit) {
      var value = studioPopupRangeValue(p.target, p.option);
      p.range.input.value = String(clamp(value, +p.range.input.min, +p.range.input.max));
      studioPopupPaintRange(p.range, p.option);
    }
    if (!p.edit) studioPopupRefreshChoices(p);
    studioPopupPosition();
  }
  function studioPopupPosition() {
    var p = studio && studio.popup;
    if (!p || p.node.hidden || !p.target || !p.target.isConnected || p.edit) return;
    var viewportWidth = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
    var viewportHeight = Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight);
    var margin = 8, gap = 12 * themeScale;
    p.node.style.maxWidth = Math.max(1, viewportWidth - margin * 2) + 'px';
    var r = p.target.getBoundingClientRect(), box = p.node.getBoundingClientRect();
    var width = Math.min(p.node.offsetWidth || box.width || (p.option ? 276 : 250) * themeScale, Math.max(1, viewportWidth - margin * 2));
    var optionsHeight = p.options.offsetHeight || p.options.getBoundingClientRect().height;
    // Layout dimensions ignore entrance motion and preserve the user's scroll position.
    var baseHeight = p.node.offsetHeight || box.height;
    var height = (baseHeight || (p.option ? 124 : 44) * themeScale) + Math.max(0, p.options.scrollHeight - p.options.clientHeight);
    var fullHeight = Math.max(0, viewportHeight - margin * 2), chromeHeight = baseHeight - optionsHeight;
    var above = clamp(r.top - gap - margin, 0, fullHeight), below = clamp(viewportHeight - margin - r.bottom - gap, 0, fullHeight);
    var beside = r.right + gap + width <= viewportWidth - margin || r.left - gap - width >= margin;
    var available = Math.max(above, below, beside ? fullHeight : 0);
    var minimumOptions = Math.min(p.options.scrollHeight, 92 * themeScale);
    if (p.option === 'Layout' && p.options.firstElementChild) {
      var first = p.options.firstElementChild, optionsStyle = getComputedStyle(p.options);
      minimumOptions = (first.offsetHeight || first.getBoundingClientRect().height) +
        (parseFloat(optionsStyle.paddingTop) || 0) + (parseFloat(optionsStyle.paddingBottom) || 0);
    }
    if (p.option && optionsHeight && height > available && available >= chromeHeight + minimumOptions) {
      // Parent and options dimensions can round in opposite directions.
      p.options.style.maxHeight = Math.floor(available - chromeHeight - 1) + 'px';
      height = p.node.offsetHeight || p.node.getBoundingClientRect().height;
    } else if (p.options.style.maxHeight) {
      p.options.style.maxHeight = '';
      height = p.node.offsetHeight || p.node.getBoundingClientRect().height;
    }
    var left = clamp(r.left + r.width / 2 - width / 2, margin, Math.max(margin, viewportWidth - width - margin));
    var top, placement;
    if (height <= above) { top = Math.min(r.top - gap - height, viewportHeight - margin - height); placement = 'above'; }
    else if (height <= below) { top = Math.max(margin, r.bottom + gap); placement = 'below'; }
    else if (height <= fullHeight && r.right + gap + width <= viewportWidth - margin) { left = r.right + gap; top = clamp(r.top, margin, viewportHeight - height - margin); placement = 'right'; }
    else if (height <= fullHeight && r.left - gap - width >= margin) { left = r.left - gap - width; top = clamp(r.top, margin, viewportHeight - height - margin); placement = 'left'; }
    else {
      p.node.hidden = true;
      studio.notice = 'Select a smaller visible element to show controls beside it.';
      return;
    }
    if (studio.notice === 'Select a smaller visible element to show controls beside it.') studio.notice = null;
    p.node.style.left = Math.round(left) + 'px'; p.node.style.top = Math.round(top) + 'px';
    p.node.setAttribute('data-placement', placement);
  }
  function studioPopupFinish(commit) {
    var p = studio && studio.popup, edit = p && p.edit;
    if (!edit) return;
    p.edit = null;
    if (p.range) p.range.closed = true;
    if (!studio.gesture || studio.gesture.id !== edit.id) { studioEndGesture(edit.id); return; }
    try {
      studioStyleCommand({ values: commit ? edit.values : {}, gestureId: edit.id, phase: commit ? 'commit' : 'cancel' });
      if (p.feedback && edit.kind === 'hover') {
        p.feedback.textContent = commit ? (edit.owner.getAttribute('data-studio-look') || edit.owner.title || 'Color') + ' selected' : 'Hover to preview · click to keep';
      }
    }
    catch (error) {
      if (commit) throw error;
      studio.lastError = error.message || String(error); studioPublish();
    }
  }
  function studioPopupDismiss(cancelText) {
    if (!studio) return;
    studioPopupFinish(false);
    studioFinishText(!!cancelText);
    if (studio.popup) { studio.popup.node.hidden = true; studio.popup.option = ''; studio.popup.options.textContent = ''; studio.popup.range = null; studio.popup.choices = []; studio.popup.feedback = null; }
    state.hoverEl = null;
    deselect(); studioPublish();
  }
  function studioPopupPreview(values, kind, owner) {
    var p = studio.popup;
    if (!studioInteractive() || state.tool !== 'select' || state.selected !== p.target || !p.target.isConnected) return;
    if (p.edit && (p.edit.kind !== kind || p.edit.owner !== owner)) studioPopupFinish(false);
    if (typeof values === 'function') values = values();
    if (!p.edit) p.edit = { id: studioId('context-gesture'), kind: kind, owner: owner, values: values };
    p.edit.values = values;
    studioStyleCommand({ values: values, gestureId: p.edit.id, phase: 'preview' });
    if (p.feedback && kind === 'hover') p.feedback.textContent = 'Previewing ' + (owner.getAttribute('data-studio-look') || owner.title || 'color').toLowerCase();
  }
  function studioPopupChoice(button, values, computed) {
    var popup = studio.popup, target = popup.target, option = popup.option;
    popup.choices.push({ button: button, values: values, computed: !!computed });
    button.setAttribute('aria-pressed', 'false');
    function current() { return studio && studio.popup === popup && button.isConnected && !popup.node.hidden && popup.target === target && state.selected === target && popup.option === option; }
    button.addEventListener('pointerenter', function () {
      if (!current()) return;
      try { studioPopupPreview(values, 'hover', button); } catch (error) { studioPopupFinish(false); studioGestureError(error); }
    });
    button.addEventListener('focus', function () {
      if (!current()) return;
      try { studioPopupPreview(values, 'hover', button); } catch (error) { studioGestureError(error); }
    });
    function leave() {
      if (studio && studio.popup && studio.popup.edit && studio.popup.edit.owner === button) {
        try { studioPopupFinish(false); studioPopupPosition(); } catch (error) { studioGestureError(error); }
      }
    }
    button.addEventListener('pointerleave', leave);
    button.addEventListener('blur', leave);
    button.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!studioInteractive() || !current()) return;
      try {
        var p = studio.popup;
        if (!p.target || state.selected !== p.target || !p.target.isConnected) return;
        if (p.edit && p.edit.owner === button) studioPopupFinish(true);
        else {
          studioPopupFinish(false);
          studioStyleCommand({ values: typeof values === 'function' ? values() : values, gestureId: studioId('context-choice'), phase: 'commit' });
          if (p.feedback) p.feedback.textContent = (button.getAttribute('data-studio-look') || button.title || 'Color') + ' selected';
        }
        studioPopupPosition();
      } catch (error) { studioGestureError(error); }
    });
  }
  function studioPopupRefreshChoices(p) {
    if (!p.target || !p.target.isConnected || !p.choices.length) return;
    var cs = getComputedStyle(p.target), probe = document.createElement('span').style;
    p.choices.forEach(function (choice) {
      var values = typeof choice.values === 'function' ? choice.values() : choice.values;
      var selected = Object.keys(values).every(function (property) {
        var wanted = values[property];
        if (property === 'color' || property === 'background-color' || property === 'accent-color') {
          var a = studioPopupRgb(studioPopupResolveColor(p.target, cs.getPropertyValue(property)));
          var b = studioPopupRgb(wanted);
          return a && b && a.every(function (value, i) { return Math.abs(value - b[i]) < (i === 3 ? 0.01 : 1); });
        }
        probe.setProperty(property, wanted);
        if (property === 'grid-template-columns' && choice.button.hasAttribute('data-studio-columns')) {
          return studioPopupColumns(p.target) === +choice.button.getAttribute('data-studio-columns');
        }
        return (choice.computed ? cs.getPropertyValue(property) : p.target.style.getPropertyValue(property)) === probe.getPropertyValue(property);
      });
      choice.button.setAttribute('aria-pressed', String(!!selected));
    });
  }
  function studioPopupFeedback(p) {
    p.feedback = h('div', { class: 'studio-context-feedback', text: 'Hover to preview · click to keep' });
    p.options.appendChild(p.feedback);
  }
  function studioPopupResolveColor(el, color) {
    for (var i = 0; i < 5 && /var\(/.test(color || ''); i++) {
      var match = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(color.trim());
      if (!match) return '';
      var value = '', node = el;
      for (var depth = 0; node && depth < 16 && !value; depth++, node = node.parentElement) value = getComputedStyle(node).getPropertyValue(match[1]).trim();
      color = value || match[2] || '';
    }
    if (/^(canvastext|buttontext|fieldtext)$/i.test(color || '')) return studioPopupDarkCanvas() ? '#eeeeee' : '#20232a';
    return color || '';
  }
  function studioPopupDarkCanvas() {
    var scheme = getComputedStyle(document.documentElement).colorScheme || '';
    return /dark/.test(scheme) && (!/light/.test(scheme) || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches));
  }
  function studioPopupRgb(color) {
    if (!color || /var\(/.test(color)) return null;
    if (color === 'transparent') return [0, 0, 0, 0];
    var perceptual = /^(oklch|oklab)\(([^)]+)\)$/i.exec(color);
    if (perceptual) {
      var segments = perceptual[2].split('/'), channels = segments[0].trim().split(/\s+/);
      if (channels.length !== 3) return null;
      var light = parseFloat(channels[0]) / (/%$/.test(channels[0]) ? 100 : 1);
      var a = parseFloat(channels[1]) * (/%$/.test(channels[1]) ? 0.004 : 1), b = parseFloat(channels[2]);
      if (perceptual[1].toLowerCase() === 'oklch') { var angle = b * Math.PI / 180; b = a * Math.sin(angle); a *= Math.cos(angle); }
      else if (/%$/.test(channels[2])) b *= 0.004;
      var l = Math.pow(light + 0.3963377774 * a + 0.2158037573 * b, 3);
      var m0 = Math.pow(light - 0.1055613458 * a - 0.0638541728 * b, 3);
      var s = Math.pow(light - 0.0894841775 * a - 1.291485548 * b, 3);
      var output = [4.0767416621 * l - 3.3077115913 * m0 + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m0 - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m0 + 1.707614701 * s].map(function (n) {
        return clamp((n <= 0.0031308 ? 12.92 * n : 1.055 * Math.pow(n, 1 / 2.4) - 0.055) * 255, 0, 255);
      });
      if (output.some(function (n) { return !isFinite(n); })) return null;
      return output.concat([segments[1] ? clamp(parseFloat(segments[1]) / (/%\s*$/.test(segments[1]) ? 100 : 1), 0, 1) : 1]);
    }
    var rgb = toRgb(color);
    var alpha = 1, m = /^rgba?\(([^)]+)\)/i.exec(color);
    if (m) {
      var parts = m[1].replace(/[,/]/g, ' ').trim().split(/\s+/);
      if (parts.length < 3) return null;
      rgb = parts.slice(0, 3).map(function (part) { return clamp(parseFloat(part) * (/%$/.test(part) ? 2.55 : 1), 0, 255); });
      if (parts[3]) alpha = clamp(parseFloat(parts[3]) / (/%$/.test(parts[3]) ? 100 : 1), 0, 1);
    } else if (!rgb) return null;
    else if (/^#[0-9a-f]{8}$/i.test(color)) alpha = parseInt(color.slice(7, 9), 16) / 255;
    else if (/^#[0-9a-f]{4}$/i.test(color)) alpha = parseInt(color[4] + color[4], 16) / 255;
    return rgb.concat([alpha]);
  }
  function studioPopupRgbCss(rgb) { return 'rgb(' + rgb.slice(0, 3).map(function (n) { return Math.round(n); }).join(', ') + ')'; }
  function studioPopupBlend(fg, bg) {
    var alpha = fg[3] == null ? 1 : fg[3];
    return [0, 1, 2].map(function (i) { return fg[i] * alpha + bg[i] * (1 - alpha); }).concat([1]);
  }
  function studioPopupBackground(el) {
    var chain = [], node = el;
    for (var i = 0; node && i < 16; i++, node = node.parentElement) chain.unshift(node);
    var dark = studioPopupDarkCanvas();
    var color = dark ? [18, 18, 18, 1] : [255, 255, 255, 1];
    chain.forEach(function (item) {
      var current = studioPopupRgb(studioPopupResolveColor(item, getComputedStyle(item).backgroundColor));
      if (current) color = studioPopupBlend(current, color);
    });
    return color;
  }
  function studioPopupContrast(fg, bg) {
    fg = studioPopupBlend(fg, bg);
    function luminance(rgb) {
      var channels = rgb.slice(0, 3).map(function (n) { n /= 255; return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4); });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    var a = luminance(fg), b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  function studioPopupInks(el) {
    var inks = [], stack = [el], count = 0;
    while (stack.length && count++ < 60) {
      var node = stack.pop(), cs = getComputedStyle(node), background = studioPopupRgb(studioPopupResolveColor(node, cs.backgroundColor));
      if (node !== el && ((background && background[3] > 0.95) || (cs.backgroundImage && cs.backgroundImage !== 'none') || chartRoot(node))) continue;
      if (studioNorm(studioOwn(node)) || studioFormControl(node)) {
        var color = studioPopupRgb(studioPopupResolveColor(node, cs.color));
        if (color && !inks.some(function (known) { return studioEqual(known, color); })) inks.push(color);
      }
      for (var i = Math.min(node.children.length, 30) - 1; i >= 0; i--) stack.push(node.children[i]);
    }
    return inks;
  }
  function studioPopupColors(p) {
    var fieldType = studioPopupFieldType(p.target);
    var property = p.kind === 'text' ? 'color' : p.kind === 'field' && /^(choice|range)$/.test(fieldType) ? 'accent-color' : 'background-color', cs = getComputedStyle(p.target);
    var original = studioPopupResolveColor(p.target, cs.getPropertyValue(property)), background = studioPopupBackground(p.target);
    var candidates = [{ name: 'Current', color: original }], seen = new Set(), colors = h('div', { class: 'studio-swatches' });
    if (property === 'background-color' && cs.backgroundImage && cs.backgroundImage !== 'none') {
      p.options.appendChild(h('div', { class: 'studio-context-note', text: 'This background contains imagery. Its colors are kept intact.' })); return;
    }
    studioDiscover().tokens.filter(function (token) { return token.kind === 'color'; }).slice(0, 12).forEach(function (token) {
      try { candidates.push({ name: 'App ' + token.name.replace(/^--/, '').replace(/-/g, ' '), color: studioPopupResolveColor(studioResolve(token.target, []), token.value) }); } catch (e) { /* stale optional color suggestions are omitted */ }
    });
    [
      ['Ink', '#20232a'], ['Lavender', '#7066a6'], ['Clay', '#956453'], ['Sage', '#426d60'], ['Blue', '#426aa0'], ['Plum', '#79556f'],
      ['Paper', '#f6f4f0'], ['Soft lavender', '#eeedf8'], ['Soft sage', '#edf2ee'], ['Soft blue', '#eaf0f8'], ['Soft rose', '#f6eee8'], ['Sand', '#f6f2e6']
    ].forEach(function (entry) { candidates.push({ name: entry[0], color: entry[1] }); });
    var inks = property === 'color' ? [] : studioPopupInks(p.target), originalInk = studioPopupRgb(studioPopupResolveColor(p.target, cs.color));
    candidates.forEach(function (candidate, index) {
      var rgb = studioPopupRgb(candidate.color);
      if (!rgb || colors.children.length >= 7 || seen.has(studioStableJson(rgb))) return;
      var safe = property === 'accent-color' ? true : property === 'color' ? studioPopupContrast(rgb, background) >= Math.min(4.5, originalInk ? studioPopupContrast(originalInk, background) : 4.5) - 0.02 :
        inks.every(function (ink) { return studioPopupContrast(ink, studioPopupBlend(rgb, background)) >= Math.min(4.5, studioPopupContrast(ink, background)) - 0.02; });
      if (index && !safe) return;
      seen.add(studioStableJson(rgb));
      var button = h('button', { type: 'button', class: 'studio-swatch', 'aria-label': candidate.name + ' color', title: candidate.name, 'data-studio-color': candidate.color });
      button.style.setProperty('--swatch', candidate.color);
      var uiBackground = studioPopupRgb(PANEL_BG2) || [255, 255, 255, 1];
      var displayed = studioPopupBlend(rgb, uiBackground);
      var mark = studioPopupContrast([255, 255, 255, 1], displayed) > studioPopupContrast([25, 30, 40, 1], displayed) ? '#ffffff' : '#191e28';
      button.style.setProperty('--swatch-ink', mark);
      var check = svg('svg', { class: 'studio-swatch-check', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' });
      check.appendChild(svg('path', { d: 'M3.5 8.5 6.5 11 12.5 5', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      button.appendChild(check);
      var values = {}; values[property] = candidate.color;
      studioPopupChoice(button, values); colors.appendChild(button);
    });
    p.options.appendChild(colors.children.length ? colors : h('div', { class: 'studio-context-note', text: 'This app color cannot be resolved safely in this frame.' }));
    if (colors.children.length) studioPopupFeedback(p);
  }
  function studioPopupLooks(p) {
    var cs = getComputedStyle(p.target), background = studioPopupBackground(p.target);
    var ink = studioPopupRgb(studioPopupResolveColor(p.target, cs.color)) || [100, 100, 100, 1];
    var line = studioPopupRgbCss(studioPopupBlend([ink[0], ink[1], ink[2], 0.22], background));
    var looks = h('div', { class: 'studio-looks' });
    ['Clean', 'Soft', 'Bold'].forEach(function (name, index) {
      var radius = [8, 18, 6][index], width = index === 2 ? '2px' : '1px';
      var values = { 'box-shadow': index === 1 ? '0 6px 20px rgba(' + ink.slice(0, 3).map(Math.round).join(',') + ',0.12)' : 'none' };
      ['top', 'right', 'bottom', 'left'].forEach(function (side) {
        values['border-' + side + '-style'] = 'solid'; values['border-' + side + '-width'] = width; values['border-' + side + '-color'] = line;
      });
      ['top-left', 'top-right', 'bottom-left', 'bottom-right'].forEach(function (corner) { values['border-' + corner + '-radius'] = radius + 'px'; });
      var button = h('button', { type: 'button', class: 'studio-look', 'aria-label': name + ' look', 'data-studio-look': name });
      var sample = h('span', { class: 'studio-look-sample', 'aria-hidden': 'true' });
      sample.style.backgroundColor = studioPopupRgbCss(background); sample.style.border = width + ' solid ' + line;
      sample.style.borderRadius = radius + 'px'; sample.style.boxShadow = values['box-shadow'];
      sample.style.setProperty('--look-ink', studioPopupRgbCss(ink));
      sample.appendChild(h('span', { class: 'studio-look-line' }));
      sample.appendChild(h('span', { class: 'studio-look-line' }));
      button.appendChild(sample); button.appendChild(document.createTextNode(name));
      studioPopupChoice(button, values); looks.appendChild(button);
    });
    p.options.appendChild(looks);
    studioPopupFeedback(p);
  }
  function studioPopupLength(value, el, font) {
    var number = parseFloat(value);
    if (!isFinite(number)) return 0;
    if (/rem$/.test(value)) return number * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    if (/em$/.test(value)) return number * (parseFloat(getComputedStyle(font ? (el.parentElement || document.documentElement) : el).fontSize) || 16);
    if (/%$/.test(value)) return number * Math.min(el.getBoundingClientRect().width || 64, el.getBoundingClientRect().height || 64) / 100;
    return number;
  }
  function studioPopupRangeValue(el, name) {
    var cs = getComputedStyle(el);
    if (name === 'Weight') return parseFloat(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : 400);
    if (name === 'Size' && studioFormControl(el) && studioPopupFieldType(el) !== 'text') {
      return el.getBoundingClientRect().width || studioPopupLength(cs.width, el, false) || 16;
    }
    if (name === 'Size') return studioPopupLength(cs.fontSize, el, true) || 16;
    if (name === 'Shape') return studioPopupLength(cs.borderTopLeftRadius || cs.borderRadius, el, false);
    if (name === 'Space' && studioPopupLayoutKind(el)) {
      return (studioPopupLength(cs.rowGap || cs.gap, el, false) + studioPopupLength(cs.columnGap || cs.gap, el, false)) / 2;
    }
    return ['Top', 'Right', 'Bottom', 'Left'].reduce(function (sum, side) { return sum + studioPopupLength(cs['padding' + side], el, false); }, 0) / 4;
  }
  function studioPopupRangeLabel(name, value) { return name === 'Weight' ? String(value) : Math.round(value) + ' px'; }
  function studioPopupPaintRange(control, name) {
    var input = control.input, value = +input.value, min = +input.min, max = +input.max;
    var label = studioPopupRangeLabel(name, value);
    control.output.textContent = label;
    input.style.setProperty('--studio-progress', clamp((value - min) / Math.max(1, max - min) * 100, 0, 100).toFixed(2) + '%');
    input.setAttribute('aria-valuetext', label);
  }
  function studioPopupRange(p, name) {
    var fieldType = p.kind === 'field' ? studioPopupFieldType(p.target) : 'text';
    var physical = name === 'Size' && fieldType !== 'text';
    var weight = name === 'Weight', min = weight ? 300 : physical ? fieldType === 'range' ? 80 : 8 : name === 'Size' ? 10 : 0;
    var current = studioPopupRangeValue(p.target, name), max = weight ? 800 : name === 'Size' ? Math.max(72, Math.min(128, Math.ceil(current))) : 64;
    if (physical) max = fieldType === 'choice' ? 64 : fieldType === 'range' ? Math.max(400, Math.min(1200, current)) : 200;
    var input = h('input', { type: 'range', min: String(min), max: String(max), step: weight ? '100' : '1', 'aria-label': name });
    input.value = String(clamp(current, min, max));
    var captions = { Size: ['Smaller', 'Larger'], Weight: ['Lighter', 'Bolder'], Space: ['Tighter', 'Roomier'], Shape: ['Square', 'Round'] }[name];
    var output = h('output', { text: studioPopupRangeLabel(name, +input.value) });
    var titles = { Size: 'Text size', Weight: 'Text weight', Space: 'Spacing', Shape: 'Corner radius' };
    if (physical) { titles.Size = fieldType === 'choice' ? 'Control size' : 'Width'; captions = ['Smaller', 'Larger']; }
    if (name === 'Space' && studioPopupLayoutKind(p.target)) titles.Space = 'Space between items';
    var heading = h('div', { class: 'studio-range-heading' }, [h('span', { text: titles[name] }), output]);
    var labels = h('div', { class: 'studio-range-labels' }, [h('span', { text: captions[0] }), h('span', { text: captions[1] })]);
    p.options.appendChild(h('div', { class: 'studio-range' }, [heading, input, labels]));
    var control = { input: input, output: output, closed: false };
    p.range = control;
    studioPopupPaintRange(control, name);
    function preview() {
      if (!studio || studio.popup !== p || p.range !== control || !studioInteractive()) return;
      if (control.closed) {
        input.value = String(clamp(studioPopupRangeValue(p.target, name), min, max));
        studioPopupPaintRange(control, name);
        return;
      }
      var values = {}, value = +input.value;
      if (physical) {
        values.width = value + 'px';
        if (fieldType === 'choice') values.height = value + 'px';
      }
      else if (name === 'Size') values['font-size'] = value + 'px';
      else if (name === 'Weight') values['font-weight'] = String(value);
      else if (name === 'Space') {
        if (studioPopupLayoutKind(p.target)) {
          values.gap = value + 'px';
          if (p.kind === 'list' && !/flex|grid/.test(getComputedStyle(p.target).display)) {
            values.display = 'flex'; values['flex-direction'] = 'column';
          }
        } else ['top', 'right', 'bottom', 'left'].forEach(function (side) { values['padding-' + side] = value + 'px'; });
      }
      else ['top-left', 'top-right', 'bottom-left', 'bottom-right'].forEach(function (corner) { values['border-' + corner + '-radius'] = value + 'px'; });
      studioPopupPaintRange(control, name);
      studioPopupPreview(values, 'slider', input);
    }
    function finish(commit) {
      if (control.closed) return;
      control.closed = true;
      if (studio && studio.popup === p && p.edit && p.edit.owner === input) studioPopupFinish(commit);
      studioPopupSync();
    }
    function guarded(fn) { return function (e) { try { fn(e); } catch (error) { studioPopupFinish(false); studioGestureError(error); } }; }
    input.addEventListener('pointerdown', guarded(function (e) {
      control.closed = false;
      if (e.pointerId != null && input.setPointerCapture) { try { input.setPointerCapture(e.pointerId); } catch (error) { /* keyboard/synthetic pointers need no capture */ } }
    }));
    input.addEventListener('input', guarded(preview));
    input.addEventListener('change', guarded(function () { if (!control.closed && !p.edit) preview(); finish(true); }));
    input.addEventListener('pointerup', guarded(function () { finish(true); }));
    input.addEventListener('pointercancel', guarded(function () { finish(false); }));
    input.addEventListener('blur', guarded(function () { finish(true); }));
    input.addEventListener('keydown', guarded(function (e) {
      if (!/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(e.key)) return;
      e.preventDefault(); e.stopPropagation(); control.closed = false;
      var step = +input.step * (e.shiftKey || /^Page/.test(e.key) ? 5 : 1), direction = /Left|Down/.test(e.key) ? -1 : 1;
      input.value = String(e.key === 'Home' ? min : e.key === 'End' ? max : clamp(+input.value + direction * step, min, max));
      preview();
    }));
    input.addEventListener('keyup', guarded(function (e) {
      if (/^(Arrow|Home|End|Page)/.test(e.key)) { e.preventDefault(); e.stopPropagation(); finish(true); }
    }));
  }
  function studioPopupColumns(el) {
    var columns = getComputedStyle(el).gridTemplateColumns || '';
    var repeat = /^repeat\(\s*(\d+)\s*,\s*(?:[\d.]+(?:px|fr|%)|minmax\(\s*0(?:px)?\s*,\s*1fr\s*\))\s*\)$/.exec(columns);
    if (repeat) return +repeat[1];
    columns = columns.replace(/\[[^\]]*\]/g, '').trim();
    return /^(?:[\d.]+px\s*)+$/.test(columns) ? columns.split(/\s+/).length : 0;
  }
  function studioPopupLayout(p) {
    function group(label, choices) {
      var row = h('div', { class: 'studio-layout-group' }, [h('span', { class: 'studio-layout-label', text: label })]);
      var buttons = h('div', { class: 'studio-layout-choices' + (label === 'Align items' ? ' studio-layout-align' : ''), role: 'group', 'aria-label': label });
      choices.forEach(function (choice) {
        var button = h('button', { type: 'button', text: choice.label, title: choice.label, 'aria-label': label + ': ' + choice.label, 'data-studio-layout': choice.id });
        if (choice.columns) button.setAttribute('data-studio-columns', String(choice.columns));
        studioPopupChoice(button, choice.values, true);
        buttons.appendChild(button);
      });
      row.appendChild(buttons); p.options.appendChild(row);
    }
    var cs = getComputedStyle(p.target), grid = /^(inline-)?grid$/.test(cs.display);
    if (grid) {
      group('Columns', [1, 2, 3, 4].map(function (count) {
        return { id: 'columns-' + count, columns: count, label: String(count), values: { 'grid-template-columns': 'repeat(' + count + ', minmax(0, 1fr))' } };
      }));
    } else {
      group('Flow', [
        { id: 'horizontal', label: 'Horizontal', direction: 'row' },
        { id: 'vertical', label: 'Vertical', direction: 'column' }
      ].map(function (choice) {
        choice.values = function () { return { display: getComputedStyle(p.target).display === 'inline-flex' ? 'inline-flex' : 'flex', 'flex-direction': choice.direction }; };
        return choice;
      }));
    }
    group('Align items', [
      { id: 'align-start', label: 'Start', values: { 'align-items': grid ? 'start' : 'flex-start' } },
      { id: 'align-center', label: 'Center', values: { 'align-items': 'center' } },
      { id: 'align-end', label: 'End', values: { 'align-items': grid ? 'end' : 'flex-end' } },
      { id: 'align-stretch', label: 'Stretch', values: { 'align-items': 'stretch' } }
    ].map(function (choice) {
      var values = choice.values;
      choice.values = function () {
        return p.kind === 'list' && !/flex|grid/.test(getComputedStyle(p.target).display) ?
          Object.assign({ display: 'flex', 'flex-direction': 'column' }, values) : values;
      };
      return choice;
    }));
    if (p.kind === 'list' && Array.prototype.some.call(p.target.children, function (child) { return getComputedStyle(child).display === 'list-item'; })) {
      group('Markers', [
        { id: 'bullets', label: 'Bullets', values: { 'list-style-type': 'disc' } },
        { id: 'numbers', label: 'Numbers', values: { 'list-style-type': 'decimal' } },
        { id: 'no-markers', label: 'None', values: { 'list-style-type': 'none' } }
      ]);
    } else if (!grid) {
      group('Wrapping', [
        { id: 'nowrap', label: 'Single line', values: { 'flex-wrap': 'nowrap' } },
        { id: 'wrap', label: 'Wrap', values: { 'flex-wrap': 'wrap' } }
      ]);
    }
    studioPopupFeedback(p);
  }
  function studioPopupOpen(name) {
    var p = studio && studio.popup;
    if (!p || !studioInteractive() || state.tool !== 'select' || !p.target || !p.target.isConnected) return;
    studioPopupFinish(false); studioFinishText(false);
    p.option = p.option === name ? '' : name; p.range = null; p.choices = []; p.feedback = null; p.options.textContent = '';
    Array.prototype.forEach.call(p.row.querySelectorAll('[data-studio-action]'), function (button) { button.setAttribute('aria-expanded', String(button.getAttribute('data-studio-action') === p.option)); });
    if (p.option === 'Color') studioPopupColors(p);
    else if (p.option === 'Look') studioPopupLooks(p);
    else if (p.option === 'Layout') studioPopupLayout(p);
    else if (p.option) studioPopupRange(p, name);
    studioPopupSync();
  }

  // ---- Studio: native gestures (never wait for a host poll) -----------------
  function studioGestureError(error) {
    if (!studio) return;
    studio.lastError = error.message || String(error);
    if (root && !studio.capture) showHint(studio.lastError, 'error');
    studioPublish();
  }
  function studioInteractive() { return studio && !studio.compare && !studio.capture && state.tool !== 'interact'; }
  function studioHit(event) {
    var el = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(event.clientX, event.clientY) : event.target;
    return el && studioAllowedElement(el) ? studioMeaningful(el) : null;
  }
  function studioPointerHover(e) {
    if (!studioInteractive() || studio.pointer || studio.text || state.debugView || state.tool !== 'select') return;
    state.hoverEl = isOurs(e.target) ? null : studioHit(e);
    reposition();
  }
  function studioPointerDown(e) {
    if (!studioInteractive() || isOurs(e.target) || state.debugView || state.tool === 'draw' || e.button > 0) return;
    try {
      studioRefresh();
      if (studio.text && studio.text.wrapper.contains(e.target)) { e.stopPropagation(); return; }
      studioFinishText(false);
      var target = studioHit(e);
      if (!target) { studioPopupDismiss(false); return; }
      studio.lastPointerPick = { target: target, time: Date.now() };
      e.preventDefault(); e.stopPropagation();
      if (state.tool === 'comment') { studioChoose(target, false); studioCommentEditor(target, e.clientX, e.clientY); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) { studioChoose(target, true); return; }
      if (studioPopupKind(target) === 'text' && !studio.freeMove) {
        studioChoose(target, false); studioStartText(target, e); return;
      }
      if (studioFormControl(target)) { studioChoose(target, false); return; }
      var selected = (state.selection || []).indexOf(target) >= 0;
      var anchor = selected ? target : state.selected && state.selected.contains(target) ? state.selected : null;
      if (!anchor) { studioChoose(target, false); return; }
      studioFinishGesture();
      var items = studioSelectionElements();
      var g = { kind: studio.freeMove ? 'free' : 'reorder', id: studioId('pointer'), el: anchor, downTarget: target, items: items,
        startX: e.clientX, startY: e.clientY, active: false, effects: [], edits: [],
        layout: studioLayout(anchor.parentElement), rect: anchor.getBoundingClientRect(),
        bases: items.map(function (el) { return { el: el, transform: el.style.transform, offset: parseTranslate(el.style.transform) }; }) };
      if (anchor.parentElement && anchor.parentElement.children.length <= STUDIO_LIMIT.children) g.snapLines = collectSnapLines(anchor, items);
      studioPointerStart(g, e);
    } catch (error) { studioGestureError(error); }
  }
  function studioClick(e) {
    if (!studioInteractive() || state.tool !== 'select' || isOurs(e.target) || state.debugView) return;
    var target = studioHit(e), last = studio.lastPointerPick;
    studio.lastPointerPick = null;
    if (last && last.target === target && Date.now() - last.time < 600) return;
    if (studio.text && target === studio.text.el) return;
    try {
      if (!target) { studioPopupDismiss(false); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) { studioChoose(target, true); return; }
      studioChoose(target, false);
      if (studioPopupKind(target) === 'text' && !studio.freeMove) studioStartText(target, e);
    } catch (error) { studioGestureError(error); }
  }
  function studioPointerStart(gesture, event) {
    studio.pointer = gesture;
    gesture.captureTarget = event.target;
    gesture.pointerId = event.pointerId;
    if (event.pointerId != null && event.target.setPointerCapture) {
      try { event.target.setPointerCapture(event.pointerId); } catch (e) { /* detached hit targets cannot capture */ }
    }
    window.addEventListener('pointermove', studioPointerMove, true);
    window.addEventListener('pointerup', studioPointerUp, true);
    window.addEventListener('blur', studioPointerCancel, true);
  }
  function studioPointerPreview(g, build) {
    if ((g.el && !g.el.isConnected) || (g.items && g.items.some(function (el) { return !el.isConnected; })) ||
      (g.bases && g.bases.some(function (base) { return !base.el.isConnected; }))) studioError('The app replaced the gesture target; the gesture was cancelled.');
    studioSilence(function () {
      var clean = studioUndoEffects(g.effects); g.effects = []; g.edits = [];
      if (!clean) studioError('The app changed during the gesture; its newer values were preserved.');
      var edits = studioDedup(build());
      if (!edits.length) return;
      g.effects = studioApplyTransaction({ id: g.id, label: 'Gesture preview', route: studio.route, edits: edits }, true);
      g.edits = edits;
    });
    reposition();
  }
  function studioResizeDown(e, dir) {
    if (!studioInteractive() || state.tool !== 'select' || !state.selected || (state.selection || []).length !== 1) return;
    e.preventDefault(); e.stopPropagation();
    try {
      studioFinishGesture(); studioFinishPointer(true);
      var el = state.selected, rect = el.getBoundingClientRect();
      studioPointerStart({ kind: 'resize', id: studioId('resize'), el: el, dir: dir[0], rect: rect, startX: e.clientX, startY: e.clientY,
        effects: [], edits: [], active: false, snapLines: el.parentElement && el.parentElement.children.length <= STUDIO_LIMIT.children ? collectSnapLines(el) : null }, e);
    } catch (error) { studioGestureError(error); }
  }
  function studioPointerMove(e) {
    var g = studio && studio.pointer;
    if (!g || !studioInteractive()) return;
    if (e.buttons === 0) { studioFinishPointer(false); return; }
    e.preventDefault(); e.stopPropagation();
    try {
      var dx = e.clientX - g.startX, dy = e.clientY - g.startY;
      if (!g.active && Math.abs(dx) + Math.abs(dy) < 4) return;
      g.active = true;
      if (g.kind === 'draw') {
        var point = [e.clientX, e.clientY];
        if (g.after.shape === 'pen') {
          var last = g.after.points[g.after.points.length - 1];
          if (Math.abs(point[0] - last[0]) + Math.abs(point[1] - last[1]) >= 2) {
            if (g.after.points.length >= 512) g.after.points = g.after.points.filter(function (_, i) { return i % 2 === 0; });
            g.after.points.push(point);
          }
        } else g.after.points = [g.after.points[0], point];
        var node = studioDrawNode(g.after);
        g.node.replaceWith(node); g.node = node;
        return;
      }
      if (g.kind === 'free') {
        if (snapOn && !e.ctrlKey && !e.metaKey && g.snapLines) {
          var sx = nearestLine(g.rect.left + dx, g.snapLines.xs, SNAP_THR), sy = nearestLine(g.rect.top + dy, g.snapLines.ys, SNAP_THR), guides = [];
          if (sx != null) { dx = sx - g.rect.left; guides.push({ x: sx }); }
          if (sy != null) { dy = sy - g.rect.top; guides.push({ y: sy }); }
          drawGuides(guides);
        } else clearGuides();
        studioPointerPreview(g, function () {
          return g.bases.map(function (base) {
            var transform = stripTranslate(base.transform);
            return studioStyleEdit(base.el, 'transform', (transform ? transform + ' ' : '') + 'translate(' + (base.offset.x + Math.round(dx)) + 'px, ' + (base.offset.y + Math.round(dy)) + 'px)', '', false);
          });
        });
      } else if (g.kind === 'resize') {
        studioPointerPreview(g, function () {
          var edits = [], guides = [], width = Math.max(8, Math.round(g.rect.width + dx)), height = Math.max(8, Math.round(g.rect.height + dy));
          if (snapOn && !e.ctrlKey && !e.metaKey && g.snapLines) {
            var x = nearestLine(g.rect.left + width, g.snapLines.xs, SNAP_THR), y = nearestLine(g.rect.top + height, g.snapLines.ys, SNAP_THR);
            if (x != null && g.dir.indexOf('e') >= 0) { width = Math.max(8, x - g.rect.left); guides.push({ x: x }); }
            if (y != null && g.dir.indexOf('s') >= 0) { height = Math.max(8, y - g.rect.top); guides.push({ y: y }); }
          }
          drawGuides(guides);
          if (g.dir.indexOf('e') >= 0) edits.push(studioStyleEdit(g.el, 'width', width + 'px', '', false));
          if (g.dir.indexOf('s') >= 0) edits.push(studioStyleEdit(g.el, 'height', height + 'px', '', false));
          return edits;
        });
      } else {
        if (!g.layout || g.items.some(function (el) { return el.parentElement !== g.layout.parent; })) studioError('Drag reordering needs siblings in a supported layout. Enable Free move for transform offsets.');
        var target = studioHit(e);
        while (target && target.parentElement !== g.layout.parent && target !== g.layout.parent) target = target.parentElement;
        if (!target || target === g.layout.parent || target.parentElement !== g.layout.parent) {
          studioPointerPreview(g, function () { return []; }); g.invalid = true; clearGuides(); return;
        }
        if (g.items.indexOf(target) >= 0) return;
        g.invalid = false;
        var rect = target.getBoundingClientRect(), horizontal = g.layout.horizontal || g.layout.grid;
        var after = horizontal ? e.clientX >= rect.left + rect.width / 2 : e.clientY >= rect.top + rect.height / 2;
        if (g.layout.reverse !== (horizontal && g.layout.rtl)) after = !after;
        studioPointerPreview(g, function () {
          var list = g.layout.children.filter(function (el) { return g.items.indexOf(el) < 0; });
          var group = g.layout.children.filter(function (el) { return g.items.indexOf(el) >= 0; });
          var index = list.indexOf(target);
          if (index < 0) studioError('The drop target changed.');
          Array.prototype.splice.apply(list, [index + (after ? 1 : 0), 0].concat(group));
          return list.every(function (el, i) { return el === g.layout.children[i]; }) ? [] : [studioReorderEdit(g.layout.parent, list)];
        });
        drawGuides(horizontal ? [{ x: after ? rect.right : rect.left }] : [{ y: after ? rect.bottom : rect.top }]);
      }
    } catch (error) { studioFinishPointer(true); studioGestureError(error); }
  }
  function studioPointerUp() { try { studioFinishPointer(false); } catch (error) { studioGestureError(error); } }
  function studioPointerCancel() {
    if (!studio) return;
    if (studio.popup && studio.popup.range) studio.popup.range.closed = true;
    studioPopupFinish(false);
    studio.lastPointerPick = null;
    studioFinishPointer(true); studioCancelGesture(); studioFinishKey(true); studioFinishText(true);
    studioChrome(); reposition(); studioPublish();
  }
  function studioFinishPointer(cancel) {
    if (!studio || !studio.pointer) return;
    var g = studio.pointer; studio.pointer = null;
    window.removeEventListener('pointermove', studioPointerMove, true);
    window.removeEventListener('pointerup', studioPointerUp, true);
    window.removeEventListener('blur', studioPointerCancel, true);
    if (g.pointerId != null && g.captureTarget && g.captureTarget.releasePointerCapture) {
      try { g.captureTarget.releasePointerCapture(g.pointerId); } catch (e) { /* capture may already have been lost */ }
    }
    clearGuides();
    var clean = studioSilence(function () { var ok = studioUndoEffects(g.effects || []); if (g.node) g.node.remove(); return ok; });
    if (!clean || (g.el && !g.el.isConnected)) { cancel = true; studio.lastError = 'The app changed during the gesture; it was cancelled without overwriting source.'; }
    if (!cancel && g.active && !g.invalid) {
      if (g.kind === 'draw' && g.after.points.length > 1) {
        var base = studioBase(document.body);
        studioCommit('Draw ' + g.after.shape, [{ kind: 'annotation', property: g.after.shape, target: base.target,
          before: { value: null, context: base.context, source: base.source }, after: g.after }]);
      } else if (g.edits.length) studioCommit(g.kind === 'reorder' ? 'Drag to reorder' : g.kind === 'resize' ? 'Resize element' : 'Free move selection', g.edits);
    } else if (!cancel && !g.active && g.downTarget && g.downTarget !== g.el) studioChoose(g.downTarget, false);
    if (!cancel && g.invalid) { studio.lastError = 'Drop within the original supported container; the drag was cancelled.'; studioPublish(); }
    reposition();
  }
  function studioDrawNode(after) {
    if (['pen', 'arrow', 'rect', 'ellipse'].indexOf(after.shape) < 0 || !/^#[a-fA-F0-9]{6}$/.test(after.color) ||
      !Array.isArray(after.points) || !after.points.length || after.points.length > 512 ||
      after.points.some(function (point) { return !Array.isArray(point) || point.length !== 2 || point.some(function (v) { return typeof v !== 'number' || !isFinite(v) || Math.abs(v) > 100000; }); }) ||
      !after.viewport || !(after.viewport.width > 0) || !(after.viewport.height > 0)) studioError('Invalid drawing annotation.');
    var points = after.points, first = points[0], last = points[points.length - 1];
    var group = svg('g', { 'data-studio-drawing': 'true', transform: 'scale(' + (window.innerWidth / after.viewport.width) + ',' + (window.innerHeight / after.viewport.height) + ')' });
    var attrs = { fill: 'none', stroke: after.color, 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, node;
    if (after.shape === 'pen') { attrs.d = points.map(function (point, i) { return (i ? 'L' : 'M') + point.join(','); }).join(' '); node = svg('path', attrs); }
    else if (after.shape === 'rect') {
      Object.assign(attrs, { x: Math.min(first[0], last[0]), y: Math.min(first[1], last[1]), width: Math.abs(last[0] - first[0]), height: Math.abs(last[1] - first[1]) }); node = svg('rect', attrs);
    } else if (after.shape === 'ellipse') {
      Object.assign(attrs, { cx: (first[0] + last[0]) / 2, cy: (first[1] + last[1]) / 2, rx: Math.abs(last[0] - first[0]) / 2, ry: Math.abs(last[1] - first[1]) / 2 }); node = svg('ellipse', attrs);
    } else {
      var markerId = studioId('arrow'), defs = svg('defs'), marker = svg('marker', { id: markerId, viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto' });
      marker.appendChild(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: after.color })); defs.appendChild(marker); group.appendChild(defs);
      Object.assign(attrs, { x1: first[0], y1: first[1], x2: last[0], y2: last[1], 'marker-end': 'url(#' + markerId + ')' }); node = svg('line', attrs);
    }
    group.appendChild(node);
    return group;
  }
  function studioDrawDown(e) {
    if (!studioInteractive() || state.tool !== 'draw') return;
    e.preventDefault(); e.stopPropagation();
    try {
      studioFinishGesture();
      var after = { shape: state.drawShape, color: state.drawColor, points: [[e.clientX, e.clientY]], viewport: { width: window.innerWidth, height: window.innerHeight } };
      var node = studioDrawNode(after); elDraw.appendChild(node);
      studioPointerStart({ kind: 'draw', id: studioId('draw'), startX: e.clientX, startY: e.clientY, after: after, node: node, active: false, effects: [], edits: [] }, e);
    } catch (error) { studioGestureError(error); }
  }
  function studioDoubleClick(e) {
    if (!studioInteractive() || state.tool !== 'select' || isOurs(e.target) || state.debugView) return;
    var el = studioHit(e);
    if (studio.text && el === studio.text.el) return;
    if (!el || !studioCanText(el)) return;
    e.preventDefault(); e.stopPropagation();
    try { studioFinishPointer(true); studioChoose(el, false); studioStartText(el, e); }
    catch (error) { studioGestureError(error); }
  }
  function studioTextCaret(el, event) {
    if (!event) return null;
    var node, offset, caret;
    try {
      if (document.caretPositionFromPoint) { caret = document.caretPositionFromPoint(event.clientX, event.clientY); node = caret && caret.offsetNode; offset = caret && caret.offset; }
      else if (document.caretRangeFromPoint) { caret = document.caretRangeFromPoint(event.clientX, event.clientY); node = caret && caret.startContainer; offset = caret && caret.startOffset; }
    } catch (e) { return null; }
    var nodes = studioOwnNodes(el), index = nodes.indexOf(node);
    if (index < 0 || typeof offset !== 'number') return null;
    var raw = nodes.slice(0, index).map(function (text) { return text.nodeValue; }).join('') + node.nodeValue.slice(0, offset);
    return raw.replace(/\s+/g, ' ').replace(/^\s+/, '').length;
  }
  function studioStartText(el, event) {
    if (!studioCanText(el)) studioError('Select editable own text, not a container’s nested markup.');
    var caretOffset = studioTextCaret(el, event);
    studioFinishGesture(); studioFinishText(false);
    var nodes = studioOwnNodes(el), values = nodes.map(function (n) { return n.nodeValue; });
    var first = nodes.find(function (n) { return studioNorm(n.nodeValue); }), wrapper = h('span', { contenteditable: 'plaintext-only', 'data-rayfin-studio-text': 'true', style: 'outline:1px dashed ' + TEAL + ';outline-offset:2px' });
    var edit = { el: el, nodes: nodes, values: values, first: first, wrapper: wrapper, onBlur: null };
    studio.text = edit;
    state.editingText = { el: el };
    studioSilence(function () {
      el.insertBefore(wrapper, first);
      wrapper.appendChild(first); first.nodeValue = studioNorm(values.join(''));
      nodes.forEach(function (n) { if (n !== first && studioNorm(n.nodeValue)) n.nodeValue = ''; });
    });
    studioProjectedDocument = true;
    wrapper.addEventListener('paste', function (e) {
      e.preventDefault();
      var text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text == null) return;
      var selection = window.getSelection(), range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      text = text.slice(0, Math.max(0, 4096 - (wrapper.textContent || '').length));
      if (range && wrapper.contains(range.commonAncestorContainer)) {
        range.deleteContents(); var pasted = document.createTextNode(text); range.insertNode(pasted);
        range.setStartAfter(pasted); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
      }
    });
    edit.onBlur = function () {
      if (!studio || studio.text !== edit) return;
      try { studioFinishText(false); studioPopupSync(); studioPublish(); }
      catch (error) { studioGestureError(error); }
    };
    wrapper.addEventListener('blur', edit.onBlur);
    window.addEventListener('blur', edit.onBlur);
    wrapper.focus({ preventScroll: true });
    var selection = window.getSelection();
    if (selection) {
      var range = document.createRange();
      if (event) { range.setStart(first, clamp(caretOffset == null ? first.nodeValue.length : caretOffset, 0, first.nodeValue.length)); range.collapse(true); }
      else range.selectNodeContents(wrapper);
      selection.removeAllRanges(); selection.addRange(range);
    }
    studioPopupSync();
  }
  function studioFinishText(cancel) {
    if (!studio || !studio.text) return;
    var edit = studio.text, value = edit.wrapper.textContent || '', connected = edit.el.isConnected && edit.wrapper.parentNode === edit.el;
    studio.text = null; state.editingText = null;
    edit.wrapper.removeEventListener('blur', edit.onBlur);
    window.removeEventListener('blur', edit.onBlur);
    studioSilence(function () {
      if (edit.wrapper.parentNode) edit.wrapper.parentNode.insertBefore(edit.first, edit.wrapper);
      edit.wrapper.remove();
      edit.nodes.forEach(function (n, i) { n.nodeValue = edit.values[i]; });
    });
    if (!cancel && connected) studioCommit('Edit text', [studioTextEdit(edit.el, value)]);
    else if (!cancel && !connected) studio.lastError = 'The text changed in the app during editing; the gesture was cancelled.';
  }
  function studioBlockMouse(e) {
    if (!studioInteractive() || isOurs(e.target)) return;
    if (state.debugView && inDebug(e.target)) return;
    if (studio.text && studio.text.wrapper.contains(e.target)) { e.stopPropagation(); return; }
    e.preventDefault(); e.stopPropagation();
  }
  function studioCommentEditor(el, x, y) {
    closeCommentEditor();
    elCommentEditor = h('div', { class: 'cmt' });
    var field = h('textarea', { placeholder: 'What should change here?', 'aria-label': 'Element comment' }), actions = h('div', { class: 'r' });
    var cancel = h('button', { text: 'Cancel' }), save = h('button', { class: 'ok', text: 'Save' });
    cancel.onclick = function () { closeCommentEditor(); };
    save.onclick = function () {
      try {
        if (!el.isConnected) studioError('The comment target disappeared.');
        studioChoose(el, false); studioRunCommand({ type: 'comment', value: field.value }); closeCommentEditor();
      } catch (error) { studioGestureError(error); }
    };
    actions.appendChild(cancel); actions.appendChild(save);
    elCommentEditor.appendChild(field); elCommentEditor.appendChild(actions);
    elCommentEditor.style.left = clamp(x + 12, 8, window.innerWidth - 232) + 'px';
    elCommentEditor.style.top = clamp(y + 12, 8, window.innerHeight - 150) + 'px';
    root.appendChild(elCommentEditor); field.focus();
  }
  function studioKey(e) {
    if (!studioInteractive()) return;
    try {
      if (e.key === 'Escape') {
        if (state.debugView) exitDebugView();
        else {
          studioPopupFinish(false);
          if (studio.pointer || studio.gesture || studio.keyGesture) studioPointerCancel();
          studioPopupDismiss(true); closeCommentEditor();
          if (state.tool !== 'select') studioSetTool('select');
        }
        e.preventDefault(); e.stopPropagation(); studioPublish(); return;
      }
      if (state.debugView) return;
      if (studio.text) {
        if ((e.ctrlKey || e.metaKey) && /^(z|y)$/i.test(e.key)) {
          e.preventDefault(); e.stopPropagation();
          studioRunCommand({ type: e.shiftKey || /^y$/i.test(e.key) ? 'redo' : 'undo' });
          studioPublish(); return;
        }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); studioFinishText(false); }
        return;
      }
      var active = root && root.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && active.type !== 'range') return;
      if ((e.ctrlKey || e.metaKey) && /^(z|y)$/i.test(e.key)) {
        e.preventDefault(); e.stopPropagation();
        if (studio.popup && studio.popup.edit) { studioPopupFinish(false); studioPopupSync(); return; }
        studioFinishKey(false);
        studioRunCommand({ type: e.shiftKey || /^y$/i.test(e.key) ? 'redo' : 'undo' }); studioPublish(); return;
      }
      if (active && active.type === 'range') return;
      var appInput = document.activeElement;
      if (appInput && !isOurs(appInput) && (appInput.matches('input,textarea,select,[contenteditable]'))) {
        if (e.key !== 'Tab') { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (state.selected && /^(Delete|Backspace)$/.test(e.key)) {
        e.preventDefault(); e.stopPropagation(); studioRunCommand({ type: 'remove' }); return;
      }
      if (state.selected && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        if (!studio.freeMove) return;
        e.preventDefault(); e.stopPropagation();
        if (!studio.freeMove) {
          if (!e.repeat) studioRunCommand({ type: 'move', direction: /Left|Up/.test(e.key) ? 'previous' : 'next' });
        } else {
          if (!studio.keyGesture) studio.keyGesture = { id: studioId('key'), effects: [], edits: [], dx: 0, dy: 0, bases: studioSelectionElements().map(function (el) { return { el: el, transform: el.style.transform, offset: parseTranslate(el.style.transform) }; }) };
          var g = studio.keyGesture, amount = e.shiftKey ? 10 : 1;
          g.dx += e.key === 'ArrowLeft' ? -amount : e.key === 'ArrowRight' ? amount : 0;
          g.dy += e.key === 'ArrowUp' ? -amount : e.key === 'ArrowDown' ? amount : 0;
          studioPointerPreview(g, function () { return g.bases.map(function (base) {
            var transform = stripTranslate(base.transform);
            return studioStyleEdit(base.el, 'transform', (transform ? transform + ' ' : '') + 'translate(' + (base.offset.x + g.dx) + 'px, ' + (base.offset.y + g.dy) + 'px)', '', false);
          }); });
        }
        return;
      }
    } catch (error) { studioFinishKey(true); studioGestureError(error); }
  }
  function studioFinishKey(cancel) {
    if (!studio || !studio.keyGesture) return;
    var gesture = studio.keyGesture; studio.keyGesture = null;
    var clean = studioSilence(function () { return studioUndoEffects(gesture.effects); });
    if (!clean || gesture.bases.some(function (base) { return !base.el.isConnected; })) cancel = true;
    if (!cancel && gesture.edits.length) studioCommit('Nudge selection', gesture.edits);
  }
  function studioKeyUp(e) {
    if (studio && /^Arrow/.test(e.key)) { try { studioFinishKey(false); } catch (error) { studioGestureError(error); } }
  }

  // Verification only reads a clean, freshly loaded document. In particular it
  // does NOT temporarily undo the draft and mistake that projection for source.
  function studioVerifyEdit(edit, contexts) {
    if (edit.kind === 'comment' || edit.kind === 'annotation') studioError('Intent and annotations require human review; they are not verifiable source changes.');
    if (edit.scope && !studioScopeMatches(studioScope(edit.scope))) studioError('Verify this change at a viewport matching ' + edit.scope + '.');
    var after = edit.after, el;
    if (edit.kind === 'remove') {
      var location = edit.before.location, parents = location && studioQuery(location.parent.selector);
      if (!parents || parents.length !== 1 || !studioKeysMatch(parents[0], location.parentContext.key)) studioError('The original removal container is missing or ambiguous.');
      var stable = edit.before.context && edit.before.context.key;
      if (!stable || !(stable.id || stable['data-testid'])) studioError('Removal of an anonymous element cannot be proven from selector absence.');
      if (studioQuery(edit.target.selector).length) studioError('The removed element is still present.');
      if (!studioSequenceMatches(parents[0], after.sequence)) studioError('The removal’s exact after-context does not match source.');
      return;
    }
    el = studioResolve(edit.target, contexts.concat(studioContexts(edit)), { fresh: true });
    if (edit.kind === 'style' || edit.kind === 'theme') {
      if (!studioStyleSame(el, edit.property, after) && !studioComputedSame(el, edit.property, after)) studioError('Source does not have the expected ' + edit.property + ' value.');
    } else if (edit.kind === 'text') {
      if (studioNorm(studioOwn(el)) !== studioNorm(after.value)) studioError('Source does not contain the expected own text.');
    } else if (edit.kind === 'chart') {
      if (!studioEqual(studioChartVisual(readSpec(el)), after.value)) studioError('Source chart configuration does not match the draft.');
    } else if (edit.kind === 'image') {
      if (edit.property === 'alt') {
        if (el.getAttribute('alt') !== after.value) studioError('Source image alt text does not match.');
      } else {
        var asset = studioImageAsset(after), data = studio.assets[asset.assetId];
        if (!data || el.getAttribute('src') !== data || el.getAttribute('alt') !== asset.alt || el.hasAttribute('srcset')) {
          studioError('The deployed image bytes cannot be verified from its URL alone. Review the staged asset and image visually.');
        }
      }
    } else if (edit.kind === 'reorder') {
      var children = Array.prototype.filter.call(el.children, studioAllowedElement);
      if (children.length !== after.order.length) studioError('Source layout has a different number of children.');
      after.order.forEach(function (item, i) {
        if (studioResolve(item.target, [item.context], { fresh: true }) !== children[i]) studioError('Source sibling order does not match.');
      });
    } else if (edit.kind === 'insert') {
      var parent = after.placement === 'inside' ? el : el.parentElement;
      if (!parent || !studioSequenceMatches(parent, after.sequence)) studioError('The inserted block’s exact source context does not match.');
      var inserted = parent.children[after.index];
      if (!inserted || !studioContextMatches(inserted, after.prototypeContext, true) || !studioUnambiguous(inserted, after.prototypeContext)) studioError('The inserted source block is missing or ambiguous.');
      var template = document.createElement('template');
      template.innerHTML = after.html;
      function check(actual, expected, depth) {
        if (!actual || !expected || depth > 20 || actual.tagName !== expected.tagName) studioError('The inserted source structure differs.');
        if (studioNorm(studioOwn(actual)) !== studioNorm(studioOwn(expected))) studioError('The inserted source content differs.');
        ['alt', 'role', 'aria-label', 'title', 'src'].forEach(function (name) {
          if (expected.hasAttribute(name) && actual.getAttribute(name) !== expected.getAttribute(name)) studioError('The inserted block’s ' + name + ' does not match source.');
        });
        for (var i = 0; i < expected.style.length; i++) {
          var prop = expected.style[i], value = expected.style.getPropertyValue(prop);
          if (actual.style.getPropertyValue(prop) !== value && getComputedStyle(actual).getPropertyValue(prop).trim() !== value) studioError('The inserted block’s ' + prop + ' requires review.');
        }
        if (actual.children.length !== expected.children.length) studioError('The inserted source hierarchy differs.');
        Array.prototype.forEach.call(expected.children, function (child, i) { check(actual.children[i], child, depth + 1); });
      }
      check(inserted, template.content.firstElementChild, 0);
    } else studioError('This edit cannot be verified automatically.');
  }
  function studioVerify(history, cursor) {
    var checked = studioValidateHistory(history, cursor).slice(0, cursor), final = new Map(), contexts = new Map();
    function facet(edit) {
      return edit.target.id + '|' + (edit.kind === 'theme' ? 'style' : edit.kind) + '|' + (edit.property || '') + '|' + (edit.scope || '');
    }
    checked.forEach(function (tx) {
      tx.edits.forEach(function (edit) {
        final.set(facet(edit), edit);
        var list = contexts.get(edit.target.id) || [];
        if (edit.after.context) list.unshift(edit.after.context);
        contexts.set(edit.target.id, list);
      });
    });
    return checked.map(function (tx) {
      try {
        if (tx.route !== studioRoute()) studioError('This transaction belongs to another route.');
        if (studioProjectedDocument || studio.gesture || studio.pointer || studio.text || studio.capture || state.debugView) studioError('Reload the real source and connect without draft history before verification. Projected DOM is not proof of source.');
        tx.edits.forEach(function (edit) {
          var effective = final.get(facet(edit));
          studioVerifyEdit(effective, contexts.get(edit.target.id) || []);
        });
        return { transactionId: tx.id, ok: true };
      } catch (e) { return { transactionId: tx.id, ok: false, message: e.message || String(e) }; }
    });
  }

  function studioOptions(options) {
    if (!studioPlain(options) || typeof options.sessionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(options.sessionId) ||
      typeof options.embedded !== 'boolean' || typeof options.appUrl !== 'string' || options.appUrl.length > 2048 ||
      !Number.isSafeInteger(options.revision) || options.revision < 0) studioError('Invalid Studio connection options.');
    var url;
    try { url = new URL(options.appUrl); } catch (e) { studioError('The app URL must be absolute.'); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) studioError('The app URL must have an HTTP(S) origin.');
    if (options.route != null && (typeof options.route !== 'string' || !options.route.startsWith('/') || options.route.length > 4096)) studioError('Invalid draft route.');
    var history = studioValidateHistory(options.history, options.cursor), previews = Object.create(null), bytes = 0;
    if (options.assetPreviews != null) {
      if (!studioPlain(options.assetPreviews) || Object.keys(options.assetPreviews).length > 100) studioError('Invalid asset previews.');
      Object.keys(options.assetPreviews).forEach(function (key) {
        var value = studioValidateAsset(key, options.assetPreviews[key]);
        bytes += value.length;
        if (bytes > 32000000) studioError('Too many image preview bytes in this connection.');
        previews[key] = value;
      });
    }
    return { sessionId: options.sessionId, embedded: options.embedded, appUrl: url.href, origin: url.origin,
      route: options.route || (url.pathname + url.search + url.hash), history: history, cursor: options.cursor, revision: options.revision, assetPreviews: previews };
  }
  function studioConnect(options) {
    try {
      var normalized = studioOptions(options);
      if (normalized.embedded && isTop) return studioConnectRelay(normalized);
      if (normalized.origin !== window.location.origin) studioError('Refusing to edit this frame: it is not the configured app origin.');
      if (normalized.embedded) studioError('Only the top frame may create a Studio relay.');
      if (studio && studio.sessionId === normalized.sessionId) { studioRefresh(); return studioSnapshot(); }
      if (studio || studioRelay) studioDisconnect((studio || studioRelay).sessionId);
      if (state.changes.length) studioError('Finish or discard legacy Design changes before connecting Studio.');
      if (state.enabled) disable();
      if (!document.documentElement || !document.body) studioError('The app document is not ready yet.');
      frameRole = 'idle';
      var documentId = studioDocumentIdentity();
      studio = {
        sessionId: normalized.sessionId, documentId: documentId, epoch: studioEpoch,
        origin: normalized.origin, route: studioRoute(), history: normalized.history, cursor: normalized.cursor, revision: normalized.revision,
        assets: normalized.assetPreviews, nodeIds: new WeakMap(), bindings: new Map(), identities: new Map(), sources: new Map(), chartCache: new WeakMap(),
        applied: [], conflicts: [], acknowledged: [], results: new Map(), compare: false, capture: false, freeMove: false,
        dirty: false, mutating: 0, discoveryDirty: true, discovery: null, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        gesture: null, closedGestures: new Set(), popup: null, pointer: null, text: null, keyGesture: null, observer: null, refreshTimer: 0, lastError: null, notice: null, verification: null
      };
      state.tool = 'select'; state.selection = []; state.selected = null;
      enable(); studioChrome();
      if (normalized.route !== studio.route && normalized.history.length) studio.notice = 'Recovered draft is scoped to ' + normalized.route + '; other routes will not be edited.';
      studioReplay(false); studioObserve(); studioPublish();
      return studioSnapshot();
    } catch (e) {
      if (studio && options && options.sessionId === studio.sessionId) return studioSnapshot(e.message || String(e));
      return studioEmpty(options && options.sessionId, '', e.message || String(e), null, options && options.route);
    }
  }
  function studioPeek(sessionId) {
    if (studioRelay) {
      if (studioRelay.sessionId !== sessionId || studioRelay.connecting || !studioRelay.snapshot) return null;
      return studioJson(studioRelay.snapshot, STUDIO_LIMIT.journal + 600000);
    }
    if (!studio || studio.sessionId !== sessionId) return null;
    try { studioRefresh(); return studioSnapshot(); }
    catch (e) { return studioSnapshot('Unable to refresh Studio: ' + (e.message || e)); }
  }
  function studioCommand(envelope) {
    if (!envelope || typeof envelope.commandId !== 'string' || !envelope.commandId || envelope.commandId.length > 200 ||
      typeof envelope.sessionId !== 'string' || typeof envelope.documentId !== 'string') return studioReject(envelope, 'Invalid command envelope.');
    if (studioRelay) return studioRelayCommand(envelope);
    if (!studio) return studioReject(envelope, 'Studio is not connected.');
    if (envelope.sessionId !== studio.sessionId || envelope.documentId !== studio.documentId || studioRoute() !== studio.route) {
      return studioReject(envelope, 'Stale session or document. Reconnect before editing.');
    }
    if (studio.results.has(envelope.commandId)) return studioSnapshot(studio.results.get(envelope.commandId).error, envelope.commandId);
    studio.lastError = null;
    try {
      if (envelope.type === 'verify') {
        studio.verification = studioVerify(envelope.history, envelope.cursor);
        return studioAck(envelope, null);
      }
      if (studio.capture && envelope.type !== 'capture') studioError('Capture is in progress; restore the canvas before editing.');
      if (studio.compare && ['compare', 'capture', 'tool', 'select', 'clear', 'discard'].indexOf(envelope.type) < 0) studioError('Original comparison is read-only. Return to Draft to edit.');
      studioRefresh();
      if (studio.pointer && envelope.type !== 'capture') studioFinishPointer(true);
      studioFinishKey(false);
      studio.notice = null;
      studioRunCommand(envelope);
      return studioAck(envelope, null);
    } catch (e) { return studioAck(envelope, e.message || String(e)); }
  }
  function studioDisconnect(sessionId) {
    if (studioRelay) {
      if (studioRelay.sessionId !== sessionId) return;
      studioRelaySend({ cmd: 'disconnect', sessionId: sessionId, documentId: studioRelay.snapshot && studioRelay.snapshot.documentId });
      if (studioRelay.timer) clearTimeout(studioRelay.timer);
      studioRelay = null;
      return;
    }
    if (!studio || studio.sessionId !== sessionId) return;
    studioPopupFinish(false);
    studioFinishPointer(true); studioCancelGesture(); studioFinishKey(true); studioFinishText(true);
    restoreCaptureAffordances(); exitDebugView(); closeCommentEditor(); hideHint();
    studioUnproject();
    if (studio.observer) studio.observer.disconnect();
    if (studio.refreshTimer) clearTimeout(studio.refreshTimer);
    if (studio.syncTimer) clearInterval(studio.syncTimer);
    window.removeEventListener('popstate', studioRouteEvent);
    window.removeEventListener('hashchange', studioRouteEvent);
    window.removeEventListener('resize', studioRouteEvent);
    window.removeEventListener('pointercancel', studioPointerCancel, true);
    window.removeEventListener('keyup', studioKeyUp, true);
    window.removeEventListener('click', studioClick, true);
    disable();
    state.selection = []; state.selected = null; state.tool = 'select';
    studio = null;
  }

  // ---- Studio: correlated, origin + source + document gated frame relay ----
  var studioTopGeneration = -1;
  function studioSourceWindow(source) {
    if (!source || source === window || typeof source.postMessage !== 'function') return false;
    try { return source.top === window; } catch (e) { return false; }
  }
  function studioFramePresent(wanted) {
    var stack = [{ frame: window, depth: 0 }], count = 0;
    while (stack.length && count++ < 80) {
      var item = stack.pop();
      if (item.frame === wanted) return true;
      if (item.depth >= 8) return null;
      try {
        for (var i = 0; i < item.frame.frames.length && i < 40; i++) stack.push({ frame: item.frame.frames[i], depth: item.depth + 1 });
      } catch (e) { return null; }
    }
    return stack.length ? null : false;
  }
  function studioRelaySend(message) {
    if (!studioRelay || !studioRelay.appWindow) return;
    var packet = Object.assign({ ns: STUDIO_MSG, protocol: 1, bridgeId: studioRelay.bridgeId, generation: studioRelay.generation }, message);
    try { studioRelay.appWindow.postMessage(packet, studioRelay.origin); }
    catch (e) {
      studioRelay.error = 'Unable to reach the app frame: ' + (e.message || e);
      if (studioRelay.snapshot) studioRelay.snapshot.error = studioRelay.error;
    }
  }
  function studioRelayConnectApp() {
    var previous = studioRelay.snapshot, options = Object.assign({}, studioRelay.options, { embedded: false });
    delete options.origin;
    if (previous) {
      options.history = previous.history; options.cursor = previous.cursor; options.revision = previous.revision;
      // Preserve the draft's original route, not the Fabric portal route.
      options.route = studioRelay.options.route;
    }
    studioRelaySend({ cmd: 'connect', sessionId: studioRelay.sessionId, pageId: studioRelay.pageId, options: options,
      theme: studioRelay.theme || state.theme, models: studioRelay.models || state.models, preferred: studioRelay.preferred || state.aiModel });
  }
  function studioRelayAdopt(hello) {
    if (!studioRelay || hello.origin !== studioRelay.origin || !studioSourceWindow(hello.source) || typeof hello.pageId !== 'string' || hello.pageId.length > 200) return;
    if (studioRelay.appWindow && hello.source !== studioRelay.appWindow && studioFramePresent(studioRelay.appWindow) !== false) return;
    if (studioRelay.retired.has(hello.pageId)) return;
    if (studioRelay.pageId && studioRelay.pageId !== hello.pageId) {
      studioRelay.retired.add(studioRelay.pageId);
      studioRelay.bridgeId = studioId('bridge'); studioRelay.generation = ++studioSeq; studioRelay.epoch = -1;
      studioRelay.connecting = true; studioRelay.pending.clear();
    }
    studioRelay.appWindow = hello.source; studioRelay.pageId = hello.pageId;
    if (studioRelay.timer) { clearTimeout(studioRelay.timer); studioRelay.timer = 0; }
    studioRelayConnectApp();
  }
  function studioRelayPing() {
    if (!studioRelay || studioRelay.appWindow) return;
    var packet = { ns: STUDIO_MSG, protocol: 1, cmd: 'discover', sessionId: studioRelay.sessionId, bridgeId: studioRelay.bridgeId, generation: studioRelay.generation };
    var stack = [{ frame: window, depth: 0 }], count = 0;
    while (stack.length && count++ < 80) {
      var item = stack.pop();
      if (item.depth >= 8) continue;
      try {
        for (var i = 0; i < item.frame.frames.length && i < 40; i++) {
          var child = item.frame.frames[i];
          child.postMessage(packet, studioRelay.origin);
          stack.push({ frame: child, depth: item.depth + 1 });
        }
      } catch (e) { studioRelay.error = 'Some nested frames could not be discovered; waiting for the app handshake.'; }
    }
    studioRelay.attempts++;
    if (studioRelay.attempts < 12) studioRelay.timer = setTimeout(studioRelayPing, 500);
    else studioRelay.error = 'The app frame did not connect. Open the deployed app directly or reload the preview.';
  }
  function studioConnectRelay(options) {
    if (studioRelay && studioRelay.sessionId === options.sessionId) return studioRelay.snapshot ? studioJson(studioRelay.snapshot, STUDIO_LIMIT.journal + 600000) : studioPendingSnapshot();
    if (studio || studioRelay) studioDisconnect((studio || studioRelay).sessionId);
    if (state.changes.length) studioError('Finish or discard legacy Design changes before connecting Studio.');
    if (state.enabled) disable();
    if (relayActive) { relayActive = false; postToApp({ ns: MSG, cmd: 'disable' }); stopPing(); }
    frameRole = 'idle';
    studioRelay = { sessionId: options.sessionId, options: options, origin: options.origin, snapshot: null, appWindow: null,
      pageId: null, bridgeId: studioId('bridge'), generation: ++studioSeq, epoch: -1, retired: new Set(), attempts: 0, timer: 0, pending: new Set(), error: null, connecting: true };
    var hellos = studioHellos; studioHellos = [];
    hellos.forEach(studioRelayAdopt);
    studioRelayPing();
    return studioRelay.snapshot ? studioJson(studioRelay.snapshot, STUDIO_LIMIT.journal + 600000) : studioPendingSnapshot();
  }
  function studioPendingSnapshot() {
    var pending = studioEmpty(studioRelay.sessionId, '', studioRelay.error, null, studioRelay.options.route);
    pending.history = studioJson(studioRelay.options.history); pending.cursor = studioRelay.options.cursor; pending.revision = studioRelay.options.revision;
    pending.notice = 'Waiting for the embedded app frame. The Fabric shell is never edited.';
    return pending;
  }
  function studioRelayCommand(envelope) {
    if (envelope.sessionId !== studioRelay.sessionId || studioRelay.connecting || !studioRelay.snapshot || envelope.documentId !== studioRelay.snapshot.documentId) return studioReject(envelope, 'Stale or unavailable app document. Wait for the app frame to connect.');
    if (studioRelay.snapshot.acknowledged.indexOf(envelope.commandId) >= 0) return studioJson(studioRelay.snapshot, STUDIO_LIMIT.journal + 600000);
    if (studioRelay.pending.has(envelope.commandId)) return studioJson(studioRelay.snapshot, STUDIO_LIMIT.journal + 600000);
    if (envelope.type === 'image') {
      try { studioRelay.options.assetPreviews[envelope.assetId] = studioValidateAsset(envelope.assetId, envelope.dataUrl); }
      catch (e) { return studioReject(envelope, e.message || String(e)); }
    }
    delete studioRelay.snapshot.error;
    studioRelay.error = null;
    studioRelay.pending.add(envelope.commandId);
    if (studioRelay.pending.size > 128) { studioRelay.pending.delete(envelope.commandId); return studioReject(envelope, 'Too many unacknowledged commands. Reconnect the app frame.'); }
    studioRelaySend({ cmd: 'command', sessionId: studioRelay.sessionId, documentId: envelope.documentId, envelope: envelope });
    return studioJson(studioRelay.snapshot, STUDIO_LIMIT.journal + 600000);
  }
  function studioPublish(snapshot) {
    if (!studio || isTop || !studio.bridgeId || !studioTopOrigin) return;
    var result = snapshot || studioSnapshot();
    try {
      window.top.postMessage({ ns: STUDIO_MSG, protocol: 1, evt: 'snapshot', bridgeId: studio.bridgeId, pageId: studioSeed,
        epoch: studio.epoch, sessionId: studio.sessionId, snapshot: result }, studioTopOrigin);
    } catch (e) { studio.lastError = 'Unable to send Studio status: ' + (e.message || e); }
  }
  function studioHello(replyOrigin, bridgeId, sessionId) {
    if (isTop || !window[NS] || window[NS].studio !== studioApi) return;
    window.top.postMessage({ ns: STUDIO_MSG, protocol: 1, evt: 'hello', pageId: studioSeed, bridgeId: bridgeId || null, sessionId: sessionId || null }, replyOrigin || '*');
  }
  function studioValidSnapshot(snapshot) {
    function strings(record) {
      return studioPlain(record) && Object.keys(record).length <= 160 && Object.keys(record).every(function (key) { return typeof record[key] === 'string' && record[key].length <= 2048; });
    }
    function selected(element) {
      return studioValidTarget(element) && strings(element.styles) && strings(element.inlineStyles) &&
        typeof element.textEditable === 'boolean' && typeof element.ownText === 'string' && element.ownText.length <= 4096 &&
        typeof element.width === 'number' && isFinite(element.width) && typeof element.height === 'number' && isFinite(element.height) &&
        typeof element.canContain === 'boolean' && typeof element.canReorder === 'boolean' &&
        Array.isArray(element.children) && element.children.length <= 40 && element.children.every(studioValidTarget) &&
        (!element.parent || studioValidTarget(element.parent)) &&
        (!element.image || (typeof element.image.src === 'string' && typeof element.image.alt === 'string')) &&
        (!element.chart || (studioPlain(element.chart.spec) && Array.isArray(element.chart.types) && element.chart.types.length <= 40 &&
          element.chart.types.every(function (type) { return typeof type.value === 'string' && typeof type.label === 'string' && typeof type.enabled === 'boolean'; })));
    }
    return snapshot && snapshot.protocol === 1 && typeof snapshot.sessionId === 'string' && typeof snapshot.documentId === 'string' &&
      Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 && typeof snapshot.enabled === 'boolean' &&
      typeof snapshot.route === 'string' && ['select', 'interact', 'comment', 'draw'].indexOf(snapshot.tool) >= 0 && typeof snapshot.compare === 'boolean' &&
      ['selection', 'layers', 'tokens', 'breakpoints', 'history', 'conflicts', 'acknowledged'].every(function (key) { return Array.isArray(snapshot[key]); }) &&
      snapshot.selection.length <= STUDIO_LIMIT.selection && snapshot.selection.every(selected) &&
      snapshot.layers.length <= 200 && snapshot.layers.every(studioValidTarget) &&
      snapshot.tokens.length <= 120 && snapshot.tokens.every(function (token) {
        return token && typeof token.name === 'string' && /^--[a-zA-Z0-9_-]{1,100}$/.test(token.name) &&
          typeof token.value === 'string' && token.value.length <= 512 && ['color', 'length', 'font', 'other'].indexOf(token.kind) >= 0 && studioValidTarget(token.target);
      }) &&
      snapshot.breakpoints.length <= 24 && snapshot.breakpoints.every(function (scope) { return typeof scope === 'string' && scope.length <= 240; }) &&
      snapshot.conflicts.length <= STUDIO_LIMIT.history && snapshot.conflicts.every(function (conflict) { return conflict && typeof conflict.transactionId === 'string' && typeof conflict.message === 'string'; }) &&
      Number.isInteger(snapshot.cursor) && snapshot.cursor >= 0 && snapshot.cursor <= snapshot.history.length &&
      snapshot.acknowledged.length <= 129 && snapshot.acknowledged.every(function (id) { return typeof id === 'string' && id.length <= 200; }) &&
      snapshot.viewport && typeof snapshot.viewport.width === 'number' && isFinite(snapshot.viewport.width) && snapshot.viewport.width >= 0 &&
      typeof snapshot.viewport.height === 'number' && isFinite(snapshot.viewport.height) && snapshot.viewport.height >= 0 &&
      (snapshot.error == null || typeof snapshot.error === 'string') && (snapshot.notice == null || typeof snapshot.notice === 'string') &&
      (snapshot.verification == null || (Array.isArray(snapshot.verification) && snapshot.verification.length <= STUDIO_LIMIT.history &&
        snapshot.verification.every(function (verdict) { return verdict && typeof verdict.transactionId === 'string' && typeof verdict.ok === 'boolean' && (verdict.message == null || typeof verdict.message === 'string'); })));
  }
  function studioMessage(e) {
    if (!window[NS] || window[NS].studio !== studioApi) return;
    var d = e && e.data;
    if (!d || d.ns !== STUDIO_MSG || d.protocol !== 1) return;
    if (isTop) {
      if (d.evt === 'hello') {
        if (!studioSourceWindow(e.source) || typeof d.pageId !== 'string') return;
        var hello = { source: e.source, origin: e.origin, pageId: d.pageId };
        if (studioRelay) {
          if ((d.sessionId && d.sessionId !== studioRelay.sessionId) || (d.bridgeId && d.bridgeId !== studioRelay.bridgeId)) return;
          studioRelayAdopt(hello);
        } else if (!studio) { studioHellos.push(hello); if (studioHellos.length > 12) studioHellos.shift(); }
      } else if (d.evt === 'snapshot' && studioRelay) {
        if (e.origin !== studioRelay.origin || e.source !== studioRelay.appWindow || d.bridgeId !== studioRelay.bridgeId ||
          d.pageId !== studioRelay.pageId || d.sessionId !== studioRelay.sessionId || !Number.isInteger(d.epoch) || d.epoch < studioRelay.epoch) return;
        if (d.snapshot && d.snapshot.sessionId !== studioRelay.sessionId) return;
        try {
          if (!studioValidSnapshot(d.snapshot) || d.snapshot.sessionId !== studioRelay.sessionId) studioError('The app frame returned an invalid Studio snapshot.');
          if (studioRelay.snapshot && (d.snapshot.revision < studioRelay.snapshot.revision ||
            (d.epoch === studioRelay.epoch && d.snapshot.documentId !== studioRelay.snapshot.documentId))) return;
          studioValidateHistory(d.snapshot.history, d.snapshot.cursor);
          if (studioRelay.snapshot && d.snapshot.documentId !== studioRelay.snapshot.documentId) studioRelay.pending.clear();
          var acknowledgesPending = d.snapshot.acknowledged.some(function (id) { return studioRelay.pending.has(id); });
          studioRelay.epoch = d.epoch;
          studioRelay.snapshot = studioJson(d.snapshot, STUDIO_LIMIT.journal + 600000);
          if (studioRelay.pending.size && !acknowledgesPending) delete studioRelay.snapshot.error;
          studioRelay.connecting = false;
          d.snapshot.acknowledged.forEach(function (id) { studioRelay.pending.delete(id); });
          studioRelay.error = null;
        } catch (error) {
          studioRelay.error = error.message || String(error);
          if (studioRelay.snapshot) studioRelay.snapshot.error = studioRelay.error;
        }
      }
      return;
    }
    if (e.source !== window.top || !e.origin || e.origin === 'null' || (studioTopOrigin && e.origin !== studioTopOrigin)) return;
    if (d.cmd === 'discover') { studioHello(e.origin, d.bridgeId, d.sessionId); return; }
    if (d.cmd === 'connect') {
      if (!Number.isInteger(d.generation) || d.generation < studioTopGeneration || d.pageId !== studioSeed ||
        !d.options || d.options.sessionId !== d.sessionId || typeof d.bridgeId !== 'string') return;
      studioTopGeneration = d.generation; studioTopOrigin = e.origin;
      studioHelloTimers.forEach(clearTimeout); studioHelloTimers = [];
      var connected = studioConnect(d.options);
      if (studio) {
        studio.bridgeId = d.bridgeId;
        if (d.theme) localSetTheme(d.theme);
        if (d.models) localSetModels(d.models, d.preferred);
        if (!studio.syncTimer) studio.syncTimer = setInterval(function () {
          if (!studio) return;
          try { studioRefresh(); studioPublish(); } catch (e) { studio.lastError = e.message || String(e); studioPublish(); }
        }, 250);
        studioPublish(connected);
      }
      else window.top.postMessage({ ns: STUDIO_MSG, protocol: 1, evt: 'snapshot', bridgeId: d.bridgeId, pageId: studioSeed,
        epoch: studioEpoch, sessionId: d.sessionId, snapshot: connected }, e.origin);
    } else if (studio && d.bridgeId === studio.bridgeId && d.sessionId === studio.sessionId && d.documentId === studio.documentId) {
      if (d.cmd === 'command' && d.envelope) studioPublish(studioCommand(d.envelope));
      else if (d.cmd === 'disconnect') studioDisconnect(d.sessionId);
      else if (d.cmd === 'theme') localSetTheme(d.theme);
      else if (d.cmd === 'models') localSetModels(d.list, d.preferred);
    }
  }
  // Direct calls return snapshots synchronously. A relay command returns its
  // cache; the native caller waits for commandId in snapshot.acknowledged.
  // Missing sessions/documents yield null from peek, not an empty JSON object.
  var studioApi = { connect: studioConnect, peek: studioPeek, command: studioCommand, disconnect: studioDisconnect };

  // ---- public API ----------------------------------------------------------
  // Host calls always land in the TOP frame; each method dispatches by role so a
  // relay bridges to the app iframe while direct/app frames act locally.
  window[NS] = {
    __v: VERSION,
    studio: studioApi,
    // `mode`: 'direct' (top frame is the app) or 'relay' (top = Fabric shell,
    // drive the app iframe at `appOrigin`). Legacy no-arg call → 'direct'.
    enable: function (mode, appOrigin) { try { hostEnable(mode, appOrigin); } catch (e) {} },
    disable: function () { try { hostDisable(); } catch (e) {} },
    peek: function () { try { return frameRole === 'relay' ? relayPeek() : localPeek(); } catch (e) { return null; } },
    drain: function () { try { return frameRole === 'relay' ? relayDrain() : localDrain(); } catch (e) { return null; } },
    drainAi: function () { try { return frameRole === 'relay' ? relayDrainAi() : localDrainAi(); } catch (e) { return null; } },
    drainAiEdit: function () { try { return frameRole === 'relay' ? relayDrainAiEdit() : localDrainAiEdit(); } catch (e) { return null; } },
    // Apply a restyle patch to the element tagged `id` (whitelisted inline CSS +
    // optional Graphein spec patch), recorded as revertable change-set entries.
    applyRestyle: function (id, patch) {
      try {
        if (studio || studioRelay) return; // old asynchronous results never bypass the Studio journal
        if (frameRole === 'relay') postToApp({ ns: MSG, cmd: 'applyRestyle', id: id, patch: patch });
        else applyRestyle(id, patch);
      } catch (e) {}
    },
    // Inject AI-generated HTML into placeholder `id` (empty html = generation
    // failed → restore the describe state).
    applyGenerated: function (id, html) {
      try {
        if (studio || studioRelay) return;
        if (frameRole === 'relay') postToApp({ ns: MSG, cmd: 'applyGenerated', id: id, html: html });
        else applyGenerated(id, html);
      } catch (e) {}
    },
    // Supply the model list for the placeholder AI picker (host resolves it);
    // `[{id,name,fast}]`. Defaults the selection to the first fast model.
    setModels: function (list, preferred) {
      try {
        if (studioRelay) {
          localSetModels(list, preferred);
          studioRelay.models = list; studioRelay.preferred = preferred;
          studioRelaySend({ cmd: 'models', sessionId: studioRelay.sessionId, documentId: studioRelay.snapshot && studioRelay.snapshot.documentId, list: list, preferred: preferred });
          return;
        }
        if (frameRole === 'relay') {
          relayModels = Array.isArray(list) ? list : null;
          relayPreferred = preferred || null;
          postToApp({ ns: MSG, cmd: 'setModels', list: relayModels, preferred: relayPreferred });
        } else {
          localSetModels(list, preferred);
        }
      } catch (e) {}
    },
    // Push Fabricator's theme (accent/surfaces/text/border + UI scale) so the
    // tools match the host app. Re-sent by the renderer after a preview reload.
    setTheme: function (theme) {
      try {
        if (studioRelay) {
          localSetTheme(theme);
          studioRelay.theme = theme;
          studioRelaySend({ cmd: 'theme', sessionId: studioRelay.sessionId, documentId: studioRelay.snapshot && studioRelay.snapshot.documentId, theme: theme });
          return;
        }
        if (frameRole === 'relay') {
          relayTheme = theme || null;
          postToApp({ ns: MSG, cmd: 'setTheme', theme: relayTheme });
        } else {
          localSetTheme(theme);
        }
      } catch (e) {
        if (studio) { studio.lastError = 'Unable to update Studio theme: ' + (e.message || e); studioPublish(); }
        else if (studioRelay) { studioRelay.error = 'Unable to update Studio theme: ' + (e.message || e); if (studioRelay.snapshot) studioRelay.snapshot.error = studioRelay.error; }
      }
    },
    // Pure chart-type conversion helpers (no DOM / no mutation), exposed for unit tests.
    __convert: { chartTypes: CHART_TYPES, groups: TYPE_GROUPS, shapeOf: shapeOf, canConvert: canConvert, convertSpec: convertSpec },
    // Transient debug-view controls (non-recorded), exposed for unit tests.
    __debug: {
      enter: function (el) { try { enterDebugView(el); } catch (e) {} },
      exit: function () { try { exitDebugView(); } catch (e) {} },
      active: function () { return !!state.debugView; },
      changeCount: function () { return state.changes.length; }
    }
  };

  // Every frame listens; non-top frames also announce themselves so the relay
  // (the top frame, once enabled) can find and drive the app iframe.
  try { window.addEventListener('message', onMessage, false); } catch (e) {}
  scheduleHellos();
  window.addEventListener('message', studioMessage, false);
  if (!isTop) [0, 250, 750, 1500, 3000, 6000].forEach(function (delay) { studioHelloTimers.push(setTimeout(function () { studioHello(); }, delay)); });
})();
