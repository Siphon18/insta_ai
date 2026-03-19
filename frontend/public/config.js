// Frontend runtime config for API routing.
// Set API_BASE_URL to your backend origin when frontend and backend are on different domains.
window.APP_CONFIG = window.APP_CONFIG || {
  API_BASE_URL: 'https://insta-ai-backend.onrender.com'
};

(function setupApiBaseProxy() {
  var queryBase = '';
  try {
    var params = new URLSearchParams(window.location.search);
    queryBase = params.get('api_base') || '';
  } catch (_) {}

  var configured = String(window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL || '').trim();
  var saved = '';
  try { saved = String(localStorage.getItem('api_base_url') || '').trim(); } catch (_) {}
  var raw = queryBase || configured || saved || '';

  var normalized = raw.replace(/\/+$/, '');
  if (normalized) {
    try { localStorage.setItem('api_base_url', normalized); } catch (_) {}
  }
  window.__API_BASE_URL__ = normalized;

  var prefixes = ['/api/', '/chat', '/generate-persona', '/get-voices', '/audio-proxy', '/healthz', '/readyz'];
  function shouldRewrite(url) {
    if (typeof url !== 'string') return false;
    if (!url.startsWith('/')) return false;
    if (/^https?:\/\//i.test(url)) return false;
    return prefixes.some(function (p) { return url === p || url.startsWith(p); });
  }

  var nativeFetch = window.fetch && window.fetch.bind(window);
  if (!nativeFetch || !normalized) return;

  window.fetch = function patchedFetch(input, init) {
    if (typeof input === 'string') {
      if (!shouldRewrite(input)) return nativeFetch(input, init);
      return nativeFetch(normalized + input, init);
    }

    var reqUrl = input && input.url ? String(input.url) : '';
    if (!shouldRewrite(reqUrl)) return nativeFetch(input, init);
    var rewritten = new Request(normalized + reqUrl, input);
    return nativeFetch(rewritten, init);
  };
})();
