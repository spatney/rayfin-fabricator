;(function () {
  'use strict'

  if (window.__fabricatorDiagnostics) return

  var MAX_CONSOLE_ENTRIES = 200
  var MAX_NETWORK_ENTRIES = 300
  var MAX_TEXT_LENGTH = 4000
  var sequence = 0
  var consoleEntries = []
  var networkEntries = []
  var alertEntries = []
  var sensitiveQueryNames =
    /^(access[-_]?token|account[-_]?key|api[-_]?key|authorization|code|client[-_]?secret|id[-_]?token|key|password|passwd|pwd|refresh[-_]?token|sas|secret|shared[-_]?access[-_]?signature|sig|signature|subscription[-_]?key|token)$/i

  function nextId(prefix) {
    sequence += 1
    return prefix + sequence
  }

  function clip(value, limit) {
    var text = String(value == null ? '' : value)
    return text.length > limit ? text.slice(0, limit) + '...' : text
  }

  function safeUrl(value) {
    try {
      var url = new URL(String(value), window.location.href)
      var params = []
      url.searchParams.forEach(function (_value, key) {
        params.push(
          encodeURIComponent(key) + '=' + (sensitiveQueryNames.test(key) ? '<redacted>' : '<value>')
        )
      })
      return url.origin + url.pathname + (params.length ? '?' + params.join('&') : '')
    } catch (_error) {
      return clip(value, 1000)
    }
  }

  function serialize(value) {
    if (typeof value === 'string') return clip(value, 2000)
    if (value instanceof Error) return clip(value.stack || value.message || String(value), 2000)
    try {
      return clip(JSON.stringify(value), 2000)
    } catch (_error) {
      return clip(String(value), 2000)
    }
  }

  function pushBounded(entries, entry, limit) {
    entries.push(entry)
    if (entries.length > limit) entries.splice(0, entries.length - limit)
  }

  function pushConsole(level, args, kind) {
    var entry = {
      id: nextId('c'),
      kind: kind || 'console',
      level: level,
      text: Array.prototype.map.call(args, serialize).join(' '),
      timestamp: Date.now(),
      url: safeUrl(window.location.href)
    }
    pushBounded(consoleEntries, entry, MAX_CONSOLE_ENTRIES)
    if (level === 'error') {
      pushBounded(
        alertEntries,
        {
          id: entry.id,
          kind: 'console',
          message: entry.text,
          url: entry.url,
          status: null
        },
        100
      )
    }
  }

  function pushNetwork(entry) {
    entry.id = nextId('n')
    entry.url = safeUrl(entry.url)
    entry.timestamp = Date.now()
    pushBounded(networkEntries, entry, MAX_NETWORK_ENTRIES)
    if (isActionableNetworkFailure(entry)) {
      pushBounded(
        alertEntries,
        {
          id: entry.id,
          kind: 'network',
          message:
            entry.method +
            ' ' +
            entry.url +
            ' failed' +
            (entry.status != null ? ' with HTTP ' + entry.status : '') +
            (entry.failureReason ? ': ' + entry.failureReason : ''),
          url: entry.url,
          status: entry.status
        },
        100
      )
    }

    function isActionableNetworkFailure(entry) {
      if (entry.type !== 'fetch' && entry.type !== 'xhr') return false
      var reason = String(entry.failureReason || '').toLowerCase()
      if (reason.indexOf('abort') >= 0 || reason.indexOf('cancel') >= 0) return false
      return entry.ok === false || (entry.status != null && entry.status >= 400)
    }
  }

  var levels = ['log', 'info', 'warn', 'error', 'debug']
  levels.forEach(function (level) {
    var original = console[level]
    console[level] = function () {
      try {
        pushConsole(level, arguments, 'console')
      } catch (_error) {}
      return original.apply(console, arguments)
    }
  })

  window.addEventListener('error', function (event) {
    pushConsole('error', [event.message || 'Uncaught error', event.error || ''], 'exception')
  })

  window.addEventListener('unhandledrejection', function (event) {
    pushConsole('error', ['Unhandled promise rejection:', event.reason], 'unhandledrejection')
  })

  if (typeof window.fetch === 'function') {
    var originalFetch = window.fetch
    window.fetch = function (input, init) {
      var method =
        (init && init.method) ||
        (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')
      var url =
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input && input.url
            ? input.url
            : String(input)
      var started = performance.now()
      return originalFetch.apply(this, arguments).then(
        function (response) {
          pushNetwork({
            type: 'fetch',
            method: String(method || 'GET').toUpperCase(),
            url: url,
            status: response.status,
            ok: response.ok,
            durationMs: Math.round(performance.now() - started),
            failureReason: response.ok ? null : response.statusText || 'HTTP ' + response.status
          })
          return response
        },
        function (error) {
          pushNetwork({
            type: 'fetch',
            method: String(method || 'GET').toUpperCase(),
            url: url,
            status: null,
            ok: false,
            durationMs: Math.round(performance.now() - started),
            failureReason: serialize(error)
          })
          throw error
        }
      )
    }
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    var originalOpen = XMLHttpRequest.prototype.open
    var originalSend = XMLHttpRequest.prototype.send

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__fabricatorRequest = {
        method: String(method || 'GET').toUpperCase(),
        url: String(url)
      }
      return originalOpen.apply(this, arguments)
    }

    XMLHttpRequest.prototype.send = function () {
      var xhr = this
      var request = xhr.__fabricatorRequest || { method: 'GET', url: window.location.href }
      var started = performance.now()
      var recorded = false
      var record = function (failureReason) {
        if (recorded) return
        recorded = true
        var status = Number(xhr.status) || null
        pushNetwork({
          type: 'xhr',
          method: request.method,
          url: request.url,
          status: status,
          ok: status != null && status >= 200 && status < 400 && !failureReason,
          durationMs: Math.round(performance.now() - started),
          failureReason:
            failureReason ||
            (status != null && status >= 400 ? xhr.statusText || 'HTTP ' + status : null)
        })
      }
      xhr.addEventListener('loadend', function () {
        record(null)
      })
      xhr.addEventListener('error', function () {
        record('Network error')
      })
      xhr.addEventListener('abort', function () {
        record('Request aborted')
      })
      xhr.addEventListener('timeout', function () {
        record('Request timed out')
      })
      return originalSend.apply(this, arguments)
    }
  }

  function recordResource(entry) {
    if (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') return
    pushNetwork({
      type: entry.initiatorType || 'resource',
      method: 'GET',
      url: entry.name,
      status: null,
      ok: true,
      durationMs: Math.round(entry.duration || 0),
      transferSize: Number(entry.transferSize) || 0,
      cache: entry.transferSize === 0 && entry.decodedBodySize > 0 ? 'cache' : null,
      failureReason: null
    })
  }

  try {
    performance.getEntriesByType('resource').forEach(recordResource)
    var resourceObserver = new PerformanceObserver(function (list) {
      list.getEntries().forEach(recordResource)
    })
    resourceObserver.observe({ type: 'resource', buffered: true })
  } catch (_error) {}

  function isVisible(element) {
    var rect = element.getBoundingClientRect()
    var style = window.getComputedStyle(element)
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    )
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
  }

  function selectorFor(element) {
    if (element.id) return '#' + cssEscape(element.id)
    var testId = element.getAttribute('data-testid')
    if (testId) return '[data-testid="' + String(testId).replace(/"/g, '\\"') + '"]'
    var path = []
    var current = element
    while (current && current.nodeType === 1 && path.length < 5) {
      var part = current.tagName.toLowerCase()
      var parent = current.parentElement
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === current.tagName
        })
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      }
      path.unshift(part)
      current = parent
      if (current === document.body) {
        path.unshift('body')
        break
      }
    }
    return path.join(' > ')
  }

  function safeVisibleText(element, limit) {
    if (
      element.closest &&
      element.closest(
        'input,textarea,select,script,style,noscript,[contenteditable="true"],[hidden],[aria-hidden="true"]'
      )
    ) {
      return ''
    }
    var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    var chunks = []
    var length = 0
    var node
    while ((node = walker.nextNode()) && length < limit) {
      var parent = node.parentElement
      if (
        !parent ||
        parent.closest(
          'input,textarea,select,script,style,noscript,[contenteditable="true"],[hidden],[aria-hidden="true"]'
        )
      ) {
        continue
      }
      var current = parent
      var visible = true
      while (current && current !== document.documentElement) {
        if (!isVisible(current)) {
          visible = false
          break
        }
        current = current.parentElement
      }
      if (!visible) continue
      var text = String(node.nodeValue || '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) continue
      chunks.push(text)
      length += text.length + 1
    }
    return clip(chunks.join(' '), limit)
  }

  function describeElement(element) {
    var rect = element.getBoundingClientRect()
    var href = element.getAttribute('href')
    var src = element.getAttribute('src')
    return {
      tag: element.tagName.toLowerCase(),
      selector: selectorFor(element),
      role: element.getAttribute('role') || null,
      text: safeVisibleText(element, 300),
      ariaLabel: element.getAttribute('aria-label') || null,
      name: element.getAttribute('name') || null,
      type: element.getAttribute('type') || null,
      placeholder: element.getAttribute('placeholder') || null,
      checked: typeof element.checked === 'boolean' ? element.checked : null,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      href: href ? safeUrl(href) : null,
      src: src ? safeUrl(src) : null,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    }
  }

  function snapshot(rootSelector) {
    var root = document.body
    if (rootSelector) {
      try {
        root = document.querySelector(rootSelector)
      } catch (error) {
        return { ok: false, error: 'Invalid selector: ' + serialize(error) }
      }
      if (!root) return { ok: false, error: 'No element matched selector ' + rootSelector }
    }

    var semanticSelector =
      'a[href],button,input,select,textarea,[contenteditable="true"],[role],h1,h2,h3,h4,nav,main,form,[data-testid]'
    var candidates = Array.prototype.slice.call(root.querySelectorAll(semanticSelector))
    if (root.matches && root.matches(semanticSelector)) candidates.unshift(root)
    var elements = []
    for (var index = 0; index < candidates.length && elements.length < 200; index += 1) {
      if (isVisible(candidates[index])) elements.push(describeElement(candidates[index]))
    }

    return {
      ok: true,
      page: {
        title: document.title,
        url: safeUrl(window.location.href),
        readyState: document.readyState,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        document: {
          width: Math.max(
            document.documentElement.scrollWidth,
            document.body ? document.body.scrollWidth : 0
          ),
          height: Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0
          )
        },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
      },
      rootSelector: rootSelector || 'body',
      bodyText: safeVisibleText(root, MAX_TEXT_LENGTH),
      elements: elements,
      truncated: candidates.length > elements.length
    }
  }

  function setNativeValue(element, value) {
    var prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    var descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
    if (descriptor && descriptor.set) descriptor.set.call(element, value)
    else element.value = value
  }

  function isWithinAllowedBase(value, allowedBase) {
    if (!value || !allowedBase) return true
    try {
      var target = new URL(value, window.location.href)
      var base = new URL(allowedBase)
      var basePath = base.pathname.replace(/\/+$/, '')
      return (
        target.protocol === base.protocol &&
        target.host === base.host &&
        (basePath === '' ||
          target.pathname === basePath ||
          target.pathname.indexOf(basePath + '/') === 0)
      )
    } catch (_error) {
      return false
    }
  }

  function navigationFor(element, action, value) {
    if (action === 'click') {
      var anchor = element.closest && element.closest('a[href]')
      if (anchor) {
        return { url: anchor.href, target: anchor.target }
      }
    }
    var submits =
      action === 'press' && String(value || 'Enter') === 'Enter'
        ? Boolean(element.form)
        : action === 'click' &&
          Boolean(element.form) &&
          (element instanceof HTMLButtonElement ||
            (element instanceof HTMLInputElement &&
              (element.type === 'submit' || element.type === 'image')))
    if (submits) {
      return {
        url: element.formAction || element.form.action || window.location.href,
        target: element.formTarget || element.form.target
      }
    }
    return null
  }

  function interact(options) {
    options = options || {}
    var action = String(options.action || '')
    if (action === 'reload') {
      window.location.reload()
      return { ok: true, action: action }
    }
    if (action === 'scroll') {
      var target = null
      if (options.selector) {
        try {
          target = document.querySelector(options.selector)
        } catch (error) {
          return { ok: false, error: 'Invalid selector: ' + serialize(error) }
        }
      }
      if (target) {
        target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' })
      } else {
        var raw = options.value
        var top =
          raw === 'top'
            ? 0
            : raw === 'bottom'
              ? document.documentElement.scrollHeight
              : window.scrollY + (Number(raw) || Math.round(window.innerHeight * 0.8))
        window.scrollTo({ top: top, behavior: 'auto' })
      }
      return {
        ok: true,
        action: action,
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) }
      }
    }

    if (!options.selector) return { ok: false, error: 'selector is required for action ' + action }
    var element
    try {
      element = document.querySelector(options.selector)
    } catch (error) {
      return { ok: false, error: 'Invalid selector: ' + serialize(error) }
    }
    if (!element) return { ok: false, error: 'No element matched selector ' + options.selector }

    var navigation = navigationFor(element, action, options.value)
    if (navigation && navigation.target && navigation.target !== '_self') {
      return { ok: false, error: 'Fabricator does not open new windows during agent interaction' }
    }
    if (navigation && !isWithinAllowedBase(navigation.url, options.allowedBase)) {
      return { ok: false, error: 'Interaction would navigate outside the deployed app' }
    }

    if (action === 'click') {
      element.click()
    } else if (action === 'focus') {
      element.focus()
    } else if (action === 'fill') {
      if (
        !(element instanceof HTMLInputElement) &&
        !(element instanceof HTMLTextAreaElement) &&
        !element.isContentEditable
      ) {
        return { ok: false, error: 'fill requires an input, textarea, or contenteditable element' }
      }
      if (
        element instanceof HTMLInputElement &&
        (element.type === 'password' || element.type === 'file')
      ) {
        return { ok: false, error: 'Fabricator does not fill password or file inputs' }
      }
      if (element.isContentEditable)
        element.textContent = String(options.value == null ? '' : options.value)
      else setNativeValue(element, String(options.value == null ? '' : options.value))
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (action === 'select') {
      if (!(element instanceof HTMLSelectElement))
        return { ok: false, error: 'select requires a select element' }
      element.value = String(options.value == null ? '' : options.value)
      element.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (action === 'check') {
      if (!(element instanceof HTMLInputElement))
        return { ok: false, error: 'check requires an input element' }
      element.checked = options.value !== false && options.value !== 'false'
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (action === 'press') {
      var key = String(options.value || 'Enter')
      element.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }))
      element.dispatchEvent(new KeyboardEvent('keyup', { key: key, bubbles: true }))
    } else {
      return { ok: false, error: 'Unsupported action ' + action }
    }

    return { ok: true, action: action, element: describeElement(element) }
  }

  function readConsole(options) {
    options = options || {}
    var level = options.level
    var entries = level
      ? consoleEntries.filter(function (entry) {
          return entry.level === level
        })
      : consoleEntries.slice()
    var limit = Math.max(1, Math.min(Number(options.limit) || 100, MAX_CONSOLE_ENTRIES))
    var result = entries.slice(-limit)
    if (options.clear) consoleEntries.splice(0, consoleEntries.length)
    return result
  }

  function readNetwork(options) {
    options = options || {}
    var entries = options.errorsOnly
      ? networkEntries.filter(function (entry) {
          return entry.ok === false || (entry.status != null && entry.status >= 400)
        })
      : networkEntries.slice()
    var limit = Math.max(1, Math.min(Number(options.limit) || 100, MAX_NETWORK_ENTRIES))
    var result = entries.slice(-limit)
    if (options.clear) networkEntries.splice(0, networkEntries.length)
    return result
  }

  function errors() {
    return alertEntries.slice()
  }

  var api = {
    readConsole: readConsole,
    readNetwork: readNetwork,
    errors: errors,
    drainErrors: function () {
      return alertEntries.splice(0, alertEntries.length)
    },
    snapshot: snapshot,
    interact: interact,
    clear: function () {
      consoleEntries.splice(0, consoleEntries.length)
      networkEntries.splice(0, networkEntries.length)
      alertEntries.splice(0, alertEntries.length)
    }
  }

  Object.defineProperty(window, '__fabricatorDiagnostics', {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false
  })

  window.__fabricatorConsole = {
    entries: consoleEntries,
    clear: function () {
      consoleEntries.splice(0, consoleEntries.length)
    }
  }
})()
