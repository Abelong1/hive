/* Shared helpers for the portal and admin pages. No innerHTML anywhere: all text
   goes through textContent, so user-supplied content can never become markup. */
(function () {
  "use strict";

  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        const v = props[k];
        if (v === false || v == null) return;
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), v);
        else if (v === true) n.setAttribute(k, "");
        else n.setAttribute(k, v);
      });
    }
    (kids || []).forEach(function (c) { if (c != null) n.append(c); });
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function client() {
    const c = window.HIVE_CONFIG;
    return window.supabase.createClient(c.url, c.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }); }
    catch (e) { return ""; }
  }

  function makeMessenger(node) {
    return function (text, kind) {
      node.textContent = text || "";
      node.className = "msg" + (text ? " msg--" + (kind || "info") : "");
    };
  }

  const SCHOOL_YEARS = (function () {
    const out = [];
    const start = new Date().getFullYear();
    for (let y = start; y >= 2015; y--) out.push((y) + "-" + (y + 1));
    return out;
  })();

  window.Hive = { el: el, clear: clear, client: client, fmtDate: fmtDate, makeMessenger: makeMessenger, SCHOOL_YEARS: SCHOOL_YEARS };
})();
