(function (global) {
  var STORAGE_KEY = 'bj_attendance_api_url';
  var DEFAULT_API = 'http://localhost:3000/api';

  function normalizeUrl(url) {
    url = (url || '').trim().replace(/\/+$/, '');
    if (url.indexOf('/dev') !== -1) url = url.replace('/dev', '/exec');
    return url;
  }

  function getApiBase() {
    var q = new URLSearchParams(window.location.search).get('api');
    if (q) {
      localStorage.setItem(STORAGE_KEY, normalizeUrl(q));
      return normalizeUrl(q);
    }
    var saved = normalizeUrl(localStorage.getItem(STORAGE_KEY) || '');
    if (saved) return saved;
    if (window.location.protocol.startsWith('http') && window.location.port === '3000') {
      return DEFAULT_API;
    }
    return DEFAULT_API;
  }

  function isLocalBackend(url) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api/i.test(url);
  }

  function apiUrl(path, params) {
    var base = getApiBase();
    var qs = new URLSearchParams(params || {});
    if (isLocalBackend(base)) {
      var localPath = path || '';
      if (!localPath.startsWith('/')) localPath = '/' + localPath;
      var full = base.replace(/\/$/, '') + localPath;
      var query = qs.toString();
      return query ? full + '?' + query : full;
    }
    qs.set('callback', 'PLACEHOLDER');
    Object.keys(params || {}).forEach(function (k) { qs.set(k, params[k]); });
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + qs.toString().replace('callback=PLACEHOLDER', 'callback=');
  }

  function jsonp(url, params) {
    return new Promise(function (resolve, reject) {
      var base = getApiBase();
      var cb = 'bjcb' + Date.now() + Math.random().toString(16).slice(2);
      var script = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('Request timeout')); }, 15000);

      function cleanup() {
        clearTimeout(timer);
        delete global[cb];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      global[cb] = function (data) { cleanup(); resolve(data); };
      script.onerror = function () { cleanup(); reject(new Error('Could not reach backend.')); };

      if (isLocalBackend(base)) {
        var qs = new URLSearchParams(Object.assign({}, params, { callback: cb, _t: Date.now() }));
        script.src = base.replace(/\/$/, '') + '/ping?' + qs.toString();
      } else {
        var legacy = new URLSearchParams(Object.assign({}, params, { callback: cb, _t: Date.now() }));
        script.src = base + (base.indexOf('?') >= 0 ? '&' : '?') + legacy.toString();
      }
      document.head.appendChild(script);
    });
  }

  function shouldUseJsonp() {
    return window.location.protocol === 'file:' || !window.fetch;
  }

  function request(method, path, params, body) {
    var base = getApiBase();
    if (isLocalBackend(base) && !shouldUseJsonp()) {
      var url = base.replace(/\/$/, '') + path;
      if (params && method === 'GET') {
        var q = new URLSearchParams(params).toString();
        if (q) url += '?' + q;
      }
      return fetch(url, {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || res.statusText);
          return data;
        });
      });
    }

    if (isLocalBackend(base)) {
      var actionMap = {
        '/ping': 'ping',
        '/today': 'today',
        '/allowance': 'allowance',
        '/employees': 'employees'
      };
      if (method === 'POST' && path === '/scan') {
        return jsonp(base, { action: 'scan', id: body && body.id });
      }
      return jsonp(base, Object.assign({}, params, { action: actionMap[path] || params.action }));
    }

    return jsonp(base, params);
  }

  function runBackend(action, args) {
    if (action === 'pingBackend') {
      return isLocalBackend(getApiBase())
        ? request('GET', '/ping')
        : jsonp(getApiBase(), { action: 'ping' });
    }
    if (action === 'scanEmployee') {
      var id = args[0];
      return isLocalBackend(getApiBase())
        ? request('POST', '/scan', null, { id: id })
        : jsonp(getApiBase(), { action: 'scan', id: id });
    }
    if (action === 'getTodayLogs') {
      return isLocalBackend(getApiBase())
        ? request('GET', '/today')
        : jsonp(getApiBase(), { action: 'today' });
    }
    if (action === 'getAllowance') {
      return isLocalBackend(getApiBase())
        ? request('GET', '/allowance')
        : jsonp(getApiBase(), { action: 'allowance' });
    }
    return Promise.reject(new Error('Unknown action'));
  }

  global.BjApi = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_API: DEFAULT_API,
    normalizeUrl: normalizeUrl,
    getApiBase: getApiBase,
    isLocalBackend: isLocalBackend,
    runBackend: runBackend,
    request: request,
    jsonp: jsonp
  };
})(window);
