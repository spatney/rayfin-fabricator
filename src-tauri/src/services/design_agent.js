/*
 * Rayfin preview "design mode" controller (v4).
 *
 * Injected at document-start into EVERY frame of the preview webview (see
 * `preview.rs` `DESIGN_AGENT_JS` / `initialization_script_for_all_frames`). Stays
 * dormant until `preview_design_set` calls `enable(...)`. A Figma-like,
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
 */
(function () {
  var NS = '__rayfinDesign';
  var VERSION = 4;
  if (window[NS] && window[NS].__v === VERSION) return;

  var HOST_ID = '__rayfin_design_host';

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
    aiModel: 'auto' // selected model id; 'auto' → let the engine pick (default)
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
  var elHover, elLabel, elSel, elSels, elBadges, elHandles, elInsert, elToolbar, elInspector, elDraw, elPins, elLegend, elCommentEditor, elStyle;
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
    '.marker{position:fixed;pointer-events:none;z-index:2147483645;min-width:18px;height:18px;line-height:18px;text-align:center;background:' + AMBER + ';color:' + ON_AMBER + ';font-size:var(--fs-small);font-weight:800;border-radius:9px;padding:0 4px;box-shadow:0 1px 4px rgba(0,0,0,.5)}',
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
    '.insp input[type=text],.insp input[type=number],.insp select,.insp textarea{background:' + PANEL_BG2 + ';color:' + TXT + ';border:1px solid ' + BORDER + ';border-radius:6px;padding:5px 7px;font-size:var(--fs-base);width:124px;max-width:58%}',
    '.insp textarea{width:100%;max-width:100%;min-height:74px;resize:none;margin-top:6px;line-height:1.45}',
    '.insp input[type=number]{width:64px}',
    '.insp input[type=range]{width:104px;accent-color:' + TEAL + '}',
    '.insp input[type=color]{width:34px;height:24px;background:' + PANEL_BG2 + ';border:1px solid ' + BORDER + ';border-radius:5px;padding:2px}',
    '.insp .mini{color:' + TXT_DIM + ';font-size:var(--fs-small);font-weight:600;padding:4px 8px;border-radius:6px;background:' + PANEL_BG2 + '}',
    '.insp .mini:hover{color:' + TXT + '}',
    '.insp .mini.danger:hover{background:#5b1a1a;color:#fff}',
    '.insp-actions{display:flex;gap:6px;padding:7px 11px;border-top:1px solid ' + BORDER + '}',
    '.insp-multi{margin:2px 0 9px;padding:7px 10px;border-radius:8px;background:' + TEAL + '1f;border:1px solid ' + TEAL + '3d;color:' + TEAL_HI + ';font-size:var(--fs-small);font-weight:600}',
    // AI generate card
    '.ai-card{margin:2px 0 6px;padding:12px 13px 13px;border:1px solid ' + TEAL + '3d;border-radius:12px;background:linear-gradient(155deg,' + TEAL + '1f,transparent 72%)}',
    '.ai-card h5{margin:0 0 9px;color:' + TEAL_HI + ';font-size:var(--fs-small);font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
    '.ai-box{border:1px solid ' + BORDER + ';border-radius:10px;background:' + PANEL_BG + 'cc;overflow:hidden;transition:border-color .15s}',
    '.ai-box:focus-within{border-color:' + TEAL + '}',
    '.ai-box textarea{width:100%;max-width:100%;background:transparent;border:0;border-radius:0;margin:0;min-height:82px;resize:none;padding:10px 11px;font-size:var(--fs-base);line-height:1.5;color:' + TXT + '}',
    '.ai-box textarea:focus{outline:none}',
    '.ai-foot{display:flex;align-items:center;gap:6px;padding:6px;border-top:1px solid ' + BORDER + '}',
    '.ai-foot .ai-model{flex:1 1 auto;width:auto;min-width:0;max-width:none;background:' + PANEL_BG2 + ';color:' + TXT + ';border:1px solid ' + BORDER + ';border-radius:7px;padding:0 7px;font-size:var(--fs-small);height:28px}',
    '.ai-btn{flex:none;font-size:var(--fs-base);font-weight:700;color:' + ON_ACCENT + ';background:' + TEAL + ';border-radius:7px;padding:0 13px;height:28px;display:inline-flex;align-items:center;white-space:nowrap}',
    '.ai-btn:hover{background:' + TEAL_HI + '}',
    '.ai-btn.busy{opacity:.7;pointer-events:none}',
    '.ai-note{margin-top:9px;font-size:var(--fs-micro);color:' + TXT_DIM + ';line-height:1.45}',
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
    ].join('\n');
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
    [elDraw, elPins, elGuides, elMorph, elHover, elLabel, elSels, elSel, elBadges, elInsert, elHandles, elToolbar, elInspector, elChanges]
      .forEach(function (n) { root.appendChild(n); });

    makeDraggable(elToolbar, false);
    makeDraggable(elInspector, false);
    makeDraggable(elChanges, true);
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
    // hover (Select only, no active selection drag)
    if (state.tool === 'select' && state.hoverEl && state.hoverEl !== state.selected && !state.move && !state.resizing) {
      place(elHover, state.hoverEl);
      var hr = state.hoverEl.getBoundingClientRect();
      elLabel.style.display = 'block';
      elLabel.textContent = state.hoverEl.tagName.toLowerCase() + ' · ' + Math.round(hr.width) + '×' + Math.round(hr.height);
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
      if (sel.length === 1) { positionHandles(); positionBadges(); }
      else { elHandles.style.display = 'none'; elBadges.style.display = 'none'; }
    } else {
      elSel.style.display = 'none'; elSels.style.display = 'none';
      elHandles.style.display = 'none'; elBadges.style.display = 'none';
    }
    // comment pins track their anchor elements
    positionPins();
    positionMorphs();
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
    if (!state.selected || (state.selection && state.selection.length > 1)) { hideHandles(); return; }
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

  // ---- smart guides (snap resized edges to sibling/parent edges + centers) --
  function collectSnapLines(el) {
    var xs = [], ys = [];
    function add(rect) { if (!rect) return; xs.push(rect.left, rect.right, (rect.left + rect.right) / 2); ys.push(rect.top, rect.bottom, (rect.top + rect.bottom) / 2); }
    var p = el.parentElement;
    if (p) add(p.getBoundingClientRect());
    var sibs = p ? p.children : [];
    for (var i = 0; i < sibs.length; i++) { if (sibs[i] !== el && !isOurs(sibs[i])) add(sibs[i].getBoundingClientRect()); }
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

  // ---- move (drop-indicator, applied on release) ---------------------------
  // The dragged element gets a subtle "lifted" look and stays put while a glowing
  // drop bar tracks where it will land; the reparent + record happen on release
  // (Esc cancels). Live reflow felt jumpy, so the layout only changes once.
  function beginPendingMove(e, el, downTarget) {
    state.move = {
      el: el, downTarget: downTarget, startX: e.clientX, startY: e.clientY, active: false,
      origParent: el.parentNode, origNext: el.nextElementSibling, origOpacity: el.style.opacity,
      origShadow: el.style.boxShadow, origTransition: el.style.transition, drop: null
    };
    window.addEventListener('pointermove', onMoveMove, true);
    window.addEventListener('pointerup', onMoveUp, true);
  }
  function endMoveVisuals(g) {
    g.el.style.opacity = g.origOpacity || '';
    g.el.style.boxShadow = g.origShadow || '';
    g.el.style.transition = g.origTransition || '';
    g.el.style.pointerEvents = '';
    if (elInsert) elInsert.style.display = 'none';
    showHint('');
  }
  function onMoveMove(e) {
    var g = state.move; if (!g || !state.enabled) return;
    if (e.buttons === 0) { onMoveUp(); return; }
    if (!g.active) {
      if (Math.abs(e.clientX - g.startX) < 4 && Math.abs(e.clientY - g.startY) < 4) return;
      g.active = true;
      g.el.style.transition = 'box-shadow .15s ease, opacity .15s ease';
      g.el.style.opacity = '0.55';
      g.el.style.boxShadow = '0 8px 24px -6px rgba(0,0,0,.3), 0 0 0 1px ' + TEAL + '99';
      showHint('Drag to a new spot — release to drop · Esc to cancel');
    }
    g.el.style.pointerEvents = 'none';
    var under = document.elementFromPoint(e.clientX, e.clientY);
    g.el.style.pointerEvents = '';
    if (!under || isOurs(under) || under === g.el || g.el.contains(under)) { elInsert.style.display = 'none'; g.drop = null; return; }
    var r = under.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
    g.drop = { ref: under, before: before };
    elInsert.style.display = 'block'; elInsert.style.height = '3px';
    elInsert.style.left = r.left + 'px'; elInsert.style.width = r.width + 'px';
    elInsert.style.top = (before ? r.top - 1 : r.bottom - 1) + 'px';
  }
  function cancelMove() {
    var g = state.move; if (!g) return;
    window.removeEventListener('pointermove', onMoveMove, true);
    window.removeEventListener('pointerup', onMoveUp, true);
    if (g.active) endMoveVisuals(g);
    state.move = null;
  }
  function onMoveUp() {
    var g = state.move; if (!g) return;
    window.removeEventListener('pointermove', onMoveMove, true);
    window.removeEventListener('pointerup', onMoveUp, true);
    if (g.active) endMoveVisuals(g);
    state.move = null;
    if (g.active && g.drop && g.drop.ref && g.drop.ref.parentNode) {
      var ref = g.drop.ref, parent = ref.parentNode, movedEl = g.el, origParent = g.origParent, origNext = g.origNext;
      if (g.drop.before) parent.insertBefore(movedEl, ref); else parent.insertBefore(movedEl, ref.nextSibling);
      if (isPlaceholder(movedEl)) { reposition(); return; } // insert entry captures its live position
      record({
        kind: 'move', property: 'position', selector: cssPath(movedEl), label: describe(movedEl), el: movedEl,
        from: 'original position', to: (g.drop.before ? 'before ' : 'after ') + describe(ref),
        target: { parentSelector: cssPath(parent), refSelector: cssPath(ref), position: g.drop.before ? 'before' : 'after' },
        revert: function () { if (origNext && origNext.parentNode === origParent) origParent.insertBefore(movedEl, origNext); else if (origParent) origParent.appendChild(movedEl); },
        reapply: function () { if (ref.parentNode) { if (g.drop.before) ref.parentNode.insertBefore(movedEl, ref); else ref.parentNode.insertBefore(movedEl, ref.nextSibling); } }
      });
      reposition();
    } else if (!g.active && g.downTarget && g.downTarget !== state.selected && !isOurs(g.downTarget) && g.downTarget.isConnected) {
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
        kind: 'move', property: 'nudge', selector: cssPath(el), label: describe(el), el: el,
        from: 'original position', to: 'nudged (' + cx + ', ' + cy + ')px',
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

  // Neutralize design-only visuals before the "Send to chat" screenshot so the
  // agent reads the real result, not our chrome: hide the changes panel, guides
  // and morph overlays, and make inserted placeholders' dashed "drop-zone" border
  // + tint transparent (kept in the layout so the numbered markers stay aligned;
  // the generated content is left visible). The numbered markers stay — they're
  // intentional and referenced by the instruction. Restored on drain.
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
    stripCaptureAffordances(); // remove design-only chrome from the capture
    drawMarkers(); // (after stripping, so numbered badges anchor to final positions)
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
    if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSelect(el); return; } // add/remove from multi-selection
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
  function rebuildStyle() {
    if (!state.enabled || !elStyle) return;
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
    rafId = requestAnimationFrame(loop);
    showHint('Design mode — Select · Insert · Comment · Draw'); setTimeout(hideHint, 2800);
  }

  function disable() {
    if (!state.enabled) return;
    state.enabled = false;
    if (state.editingText) commitText();
    if (state.panelDragUp) { try { state.panelDragUp(); } catch (e) {} state.panelDragUp = null; }
    if (state.resizing) { window.removeEventListener('pointermove', onResizeMove, true); window.removeEventListener('pointerup', onResizeUp, true); state.resizing = null; }
    if (state.move) { window.removeEventListener('pointermove', onMoveMove, true); window.removeEventListener('pointerup', onMoveUp, true); if (state.move.active) { if (state.move.origNext && state.move.origNext.parentNode === state.move.origParent) state.move.origParent.insertBefore(state.move.el, state.move.origNext); else if (state.move.origParent) state.move.origParent.appendChild(state.move.el); unliftMove(state.move); } state.move = null; }
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
    // Clean up: clear change-set (entries hold the undo closures), markup, and
    // markers; restore chrome (host typically disables next).
    state.changes = []; state.redo = []; clearMarkers(); clearPins(); clearDrawings();
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

  // ---- public API ----------------------------------------------------------
  // Host calls always land in the TOP frame; each method dispatches by role so a
  // relay bridges to the app iframe while direct/app frames act locally.
  window[NS] = {
    __v: VERSION,
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
        if (frameRole === 'relay') postToApp({ ns: MSG, cmd: 'applyRestyle', id: id, patch: patch });
        else applyRestyle(id, patch);
      } catch (e) {}
    },
    // Inject AI-generated HTML into placeholder `id` (empty html = generation
    // failed → restore the describe state).
    applyGenerated: function (id, html) {
      try {
        if (frameRole === 'relay') postToApp({ ns: MSG, cmd: 'applyGenerated', id: id, html: html });
        else applyGenerated(id, html);
      } catch (e) {}
    },
    // Supply the model list for the placeholder AI picker (host resolves it);
    // `[{id,name,fast}]`. Defaults the selection to the first fast model.
    setModels: function (list, preferred) {
      try {
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
        if (frameRole === 'relay') {
          relayTheme = theme || null;
          postToApp({ ns: MSG, cmd: 'setTheme', theme: relayTheme });
        } else {
          localSetTheme(theme);
        }
      } catch (e) {}
    }
  };

  // Every frame listens; non-top frames also announce themselves so the relay
  // (the top frame, once enabled) can find and drive the app iframe.
  try { window.addEventListener('message', onMessage, false); } catch (e) {}
  scheduleHellos();
})();
