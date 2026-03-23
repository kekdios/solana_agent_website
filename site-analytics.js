/**
 * Records one pageview per full page load (same-origin API).
 * Privacy: sends pathname + referrer only; IP is derived server-side.
 *
 * Uses fetch first — sendBeacon POST + JSON is unreliable through some proxies;
 * beacon is only a fallback if fetch fails.
 */
(function () {
  try {
    var p = location.pathname || "/";
    if (p.indexOf("..") !== -1) return;
    var payload = JSON.stringify({
      path: p,
      referrer: (document.referrer || "").slice(0, 1024),
    });
    var url = "/api/analytics/pageview";
    function sendBeaconFallback() {
      try {
        if (navigator.sendBeacon) {
          var blob = new Blob([payload], { type: "application/json" });
          navigator.sendBeacon(url, blob);
        }
      } catch (_) {}
    }
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(function (r) {
        if (!r.ok) sendBeaconFallback();
      })
      .catch(function () {
        sendBeaconFallback();
      });
  } catch (_) {}
})();
