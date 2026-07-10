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
  var RELAY_CHANNEL = 'fabricator-diagnostics-v1'
  var documentId =
    'document-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  var relaySequence = 0
  var frameSources = Object.create(null)
  var frameOrder = []
  var relayRequests = Object.create(null)
  var relayResults = Object.create(null)
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

  function matchesQuery(value, query) {
    if (!query) return true
    try {
      return JSON.stringify(value).toLowerCase().indexOf(String(query).toLowerCase()) >= 0
    } catch (_error) {
      return String(value).toLowerCase().indexOf(String(query).toLowerCase()) >= 0
    }
  }

  function snapshot(options) {
    options = typeof options === 'string' ? { selector: options } : options || {}
    var rootSelector = options.selector
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
    var limit = Math.max(1, Math.min(Number(options.limit) || 100, 200))
    var elements = []
    var totalMatches = 0
    for (var index = 0; index < candidates.length; index += 1) {
      if (!isVisible(candidates[index])) continue
      var described = describeElement(candidates[index])
      if (!matchesQuery(described, options.query)) continue
      totalMatches += 1
      if (elements.length < limit) elements.push(described)
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
      bodyText:
        options.includeBodyText === false ? undefined : safeVisibleText(root, MAX_TEXT_LENGTH),
      elements: elements,
      totalMatches: totalMatches,
      truncated: totalMatches > elements.length
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
      setTimeout(function () {
        window.location.reload()
      }, 0)
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
      // Let the relay post its result before a click tears down this document.
      setTimeout(function () {
        element.click()
      }, 0)
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
    var since = Number(options.since) || 0
    var entries = consoleEntries.filter(function (entry) {
      return (
        (!level || entry.level === level) &&
        (!since || entry.timestamp >= since) &&
        matchesQuery(entry, options.query)
      )
    })
    var limit = Math.max(1, Math.min(Number(options.limit) || 100, MAX_CONSOLE_ENTRIES))
    var result = entries.slice(-limit)
    if (options.clear) consoleEntries.splice(0, consoleEntries.length)
    return result
  }

  function readNetwork(options) {
    options = options || {}
    var since = Number(options.since) || 0
    var method = options.method ? String(options.method).toUpperCase() : ''
    var resourceType = options.resourceType ? String(options.resourceType).toLowerCase() : ''
    var urlIncludes = options.urlIncludes ? String(options.urlIncludes).toLowerCase() : ''
    var statusMin = options.statusMin == null ? null : Number(options.statusMin)
    var statusMax = options.statusMax == null ? null : Number(options.statusMax)
    var entries = networkEntries.filter(function (entry) {
      var failed = entry.ok === false || (entry.status != null && entry.status >= 400)
      return (
        (!options.errorsOnly || failed) &&
        (!since || entry.timestamp >= since) &&
        (!method || entry.method === method) &&
        (!resourceType || String(entry.type || '').toLowerCase() === resourceType) &&
        (!urlIncludes ||
          String(entry.url || '')
            .toLowerCase()
            .indexOf(urlIncludes) >= 0) &&
        (statusMin == null || (entry.status != null && entry.status >= statusMin)) &&
        (statusMax == null || (entry.status != null && entry.status <= statusMax)) &&
        matchesQuery(entry, options.query)
      )
    })
    var limit = Math.max(1, Math.min(Number(options.limit) || 100, MAX_NETWORK_ENTRIES))
    var result = entries.slice(-limit)
    if (options.clear) networkEntries.splice(0, networkEntries.length)
    return result
  }

  function errors() {
    return alertEntries.slice()
  }

  function frameInfo() {
    return {
      documentId: documentId,
      url: safeUrl(window.location.href),
      origin: window.location.origin,
      readyState: document.readyState,
      title: document.title
    }
  }

  function remoteValue(value, returnByValue) {
    var type = value === null ? 'object' : typeof value
    var result = { type: type }
    if (value === null) {
      result.subtype = 'null'
      result.value = null
      return result
    }
    if (type === 'number' && !Number.isFinite(value)) {
      result.unserializableValue = String(value)
      return result
    }
    if (type === 'bigint') {
      result.unserializableValue = String(value) + 'n'
      return result
    }
    if (type === 'undefined') return result
    if (type === 'function' || type === 'symbol') {
      result.description = clip(String(value), 2000)
      return result
    }
    if (returnByValue === false && (type === 'object' || type === 'function')) {
      result.description = clip(
        Object.prototype.toString.call(value) + ' (object handles require Windows CDP)',
        2000
      )
      return result
    }
    try {
      result.value = JSON.parse(JSON.stringify(value))
    } catch (error) {
      result.description = serialize(error)
    }
    return result
  }

  function evaluationFailure(error) {
    return {
      result: { type: 'undefined' },
      exceptionDetails: {
        text: error && error.message ? String(error.message) : 'JavaScript evaluation failed',
        exception: {
          type: 'object',
          subtype: 'error',
          className: (error && error.name) || 'Error',
          description: serialize(error)
        }
      },
      transport: 'fabricator-frame-relay'
    }
  }

  function evaluate(options) {
    options = options || {}
    var value
    try {
      value = (0, eval)(String(options.expression || ''))
    } catch (error) {
      return evaluationFailure(error)
    }
    if (options.awaitPromise !== false && value && typeof value.then === 'function') {
      return Promise.resolve(value).then(function (resolved) {
        return {
          result: remoteValue(resolved, options.returnByValue),
          transport: 'fabricator-frame-relay'
        }
      }, evaluationFailure)
    }
    return {
      result: remoteValue(value, options.returnByValue),
      transport: 'fabricator-frame-relay'
    }
  }

  function navigate(options) {
    options = options || {}
    var target
    try {
      target = new URL(String(options.target || ''), window.location.href)
    } catch (error) {
      return { ok: false, error: 'Invalid navigation target: ' + serialize(error) }
    }
    if (!isWithinAllowedBase(target.href, options.allowedBase)) {
      return { ok: false, error: 'Navigation would leave the deployed app' }
    }
    setTimeout(function () {
      window.location.assign(target.href)
    }, 0)
    return { ok: true, action: 'navigate', url: safeUrl(target.href) }
  }

  function invoke(operation, options) {
    if (operation === 'readConsole') return readConsole(options)
    if (operation === 'readNetwork') return readNetwork(options)
    if (operation === 'drainErrors') return alertEntries.splice(0, alertEntries.length)
    if (operation === 'snapshot') return snapshot(options)
    if (operation === 'interact') return interact(options)
    if (operation === 'evaluate') return evaluate(options)
    if (operation === 'navigate') return navigate(options)
    if (operation === 'frameInfo') return frameInfo()
    if (operation === 'clear') {
      consoleEntries.splice(0, consoleEntries.length)
      networkEntries.splice(0, networkEntries.length)
      alertEntries.splice(0, alertEntries.length)
      return { ok: true }
    }
    throw new Error('Unsupported diagnostics operation ' + operation)
  }

  function normalizeOrigin(value) {
    try {
      var parsed = new URL(String(value))
      return parsed.origin === String(value) && parsed.origin !== 'null' ? parsed.origin : null
    } catch (_error) {
      return null
    }
  }

  function rememberFrame(event, data) {
    var origin = normalizeOrigin(event.origin)
    if (!origin || !event.source) return
    if (!frameSources[origin]) frameOrder.push(origin)
    frameSources[origin] = {
      source: event.source,
      documentId: String(data.documentId || ''),
      url: String(data.url || ''),
      readyState: String(data.readyState || ''),
      title: String(data.title || ''),
      seenAt: Date.now()
    }
    while (frameOrder.length > 32) {
      var staleOrigin = frameOrder.shift()
      if (staleOrigin) delete frameSources[staleOrigin]
    }
  }

  function requestFrame(origin, operation, options) {
    if (window !== window.top) {
      return { ok: false, error: 'Frame requests must start in the top preview frame' }
    }
    origin = normalizeOrigin(origin)
    if (!origin) return { ok: false, error: 'Invalid embedded app origin' }
    var frame = frameSources[origin]
    if (!frame || !frame.source) {
      return { ok: false, error: 'The embedded Data App frame has not announced itself yet' }
    }
    Object.keys(relayRequests).forEach(function (requestId) {
      if (Date.now() - relayRequests[requestId].createdAt > 60000) {
        delete relayRequests[requestId]
      }
    })
    Object.keys(relayRequests)
      .slice(0, -100)
      .forEach(function (requestId) {
        delete relayRequests[requestId]
      })
    relaySequence += 1
    var id = 'relay-' + relaySequence + '-' + Date.now().toString(36)
    relayRequests[id] = {
      origin: origin,
      source: frame.source,
      createdAt: Date.now()
    }
    try {
      frame.source.postMessage(
        {
          channel: RELAY_CHANNEL,
          kind: 'request',
          id: id,
          operation: String(operation || ''),
          options: options || {},
          hostOrigin: window.location.origin,
          targetOrigin: origin
        },
        origin
      )
      return { ok: true, id: id }
    } catch (error) {
      delete relayRequests[id]
      return { ok: false, error: 'Could not reach the embedded Data App: ' + serialize(error) }
    }
  }

  function takeFrameResult(id) {
    id = String(id || '')
    var result = relayResults[id]
    if (!result) return null
    delete relayResults[id]
    return result
  }

  function frameStatus(origin) {
    origin = normalizeOrigin(origin)
    if (!origin || !frameSources[origin]) return null
    var frame = frameSources[origin]
    return {
      documentId: frame.documentId,
      url: frame.url,
      readyState: frame.readyState,
      title: frame.title,
      seenAt: frame.seenAt
    }
  }

  function postFrameHello() {
    if (window === window.top) return
    var info = frameInfo()
    try {
      window.top.postMessage(
        {
          channel: RELAY_CHANNEL,
          kind: 'hello',
          documentId: info.documentId,
          url: info.url,
          readyState: info.readyState,
          title: info.title
        },
        '*'
      )
    } catch (_error) {}
  }

  window.addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.channel !== RELAY_CHANNEL) return

    if (window === window.top) {
      if (data.kind === 'hello' && event.source !== window) {
        rememberFrame(event, data)
        return
      }
      if (data.kind !== 'result') return
      var pending = relayRequests[String(data.id || '')]
      if (!pending || pending.source !== event.source || pending.origin !== event.origin) {
        return
      }
      delete relayRequests[data.id]
      relayResults[data.id] = {
        ok: data.ok === true,
        result: data.result,
        error: data.error == null ? null : String(data.error)
      }
      Object.keys(relayResults)
        .slice(0, -100)
        .forEach(function (resultId) {
          delete relayResults[resultId]
        })
      return
    }

    if (
      data.kind !== 'request' ||
      event.source !== window.top ||
      event.origin !== data.hostOrigin ||
      window.location.origin !== data.targetOrigin
    ) {
      return
    }

    var replyOrigin = event.origin
    Promise.resolve()
      .then(function () {
        return invoke(data.operation, data.options)
      })
      .then(
        function (result) {
          window.top.postMessage(
            {
              channel: RELAY_CHANNEL,
              kind: 'result',
              id: data.id,
              ok: true,
              result: result
            },
            replyOrigin
          )
        },
        function (error) {
          window.top.postMessage(
            {
              channel: RELAY_CHANNEL,
              kind: 'result',
              id: data.id,
              ok: false,
              error: serialize(error)
            },
            replyOrigin
          )
        }
      )
  })

  if (window !== window.top) {
    window.addEventListener('DOMContentLoaded', postFrameHello)
    window.addEventListener('load', postFrameHello)
    ;[0, 50, 250, 1000, 3000].forEach(function (delay) {
      setTimeout(postFrameHello, delay)
    })
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
    evaluate: evaluate,
    invoke: invoke,
    requestFrame: requestFrame,
    takeFrameResult: takeFrameResult,
    frameStatus: frameStatus,
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
