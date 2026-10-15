/* One slim navigation bar at the top of every page: site links on the left,
   account controls on the right. Admin links show only for admins (the database
   still enforces access; this only hides links). */
(function () {
  "use strict";
  // Email links (password reset, confirmation) may land on another page; hand them to the portal.
  if (/[#&](type=(recovery|signup|invite|magiclink|email_change)|error_code=)/.test(location.hash) &&
      !/portal\.html$/.test(location.pathname)) {
    location.replace("portal.html" + location.hash);
    return;
  }
  const H = window.Hive, el = H.el;
  if (!window.supabase) return;
  const sb = H.client();
  const page = (location.pathname.split("/").pop() || "index.html").replace(/^$/, "index.html");

  const nav = el("nav", { class: "topnav", "aria-label": "Site" });
  const left = el("div", { class: "topnav__links" });
  const right = el("div", { class: "topnav__acct" });
  nav.append(left, right);
  document.body.prepend(nav);

  function link(href, text) {
    const a = el("a", { class: "topnav__link", href: href, text: text });
    if (page === href) a.setAttribute("aria-current", "page");
    return a;
  }
  function drawLinks(signedIn, isAdmin) {
    H.clear(left);
    left.append(el("a", { class: "topnav__brand", href: "index.html", text: "HIVE" }), link("index.html", "Archive"));
    if (signedIn) left.append(link("portal.html", "My entries"));
    if (isAdmin) left.append(link("admin.html", "Admin"), link("activity.html", "Activity"));
  }
  drawLinks(false, false);

  let seq = 0;
  async function render(session) {
    const mine = ++seq;
    if (!session) {
      drawLinks(false, false);
      H.clear(right);
      right.append(
        el("a", { class: "topnav__btn", href: "portal.html", text: "Sign in" }),
        el("a", { class: "topnav__btn topnav__btn--primary", href: "portal.html#signup", text: "Create account" }));
      return;
    }
    const r = await sb.from("profiles").select("full_name,role").eq("id", session.user.id).maybeSingle();
    if (mine !== seq) return; // a newer auth event already re-rendered
    const p = r.data;
    drawLinks(!!p, !!(p && p.role === "admin"));
    H.clear(right);
    right.append(el("a", { class: "topnav__who", href: "portal.html", title: "Your account",
      text: (p && p.full_name) || session.user.email }));
    if (!p) right.append(el("a", { class: "topnav__btn topnav__btn--primary", href: "portal.html", text: "Finish sign-up" }));
    right.append(el("button", { class: "topnav__btn", type: "button", text: "Sign out",
      onclick: async function () { await sb.auth.signOut(); } }));
  }

  sb.auth.onAuthStateChange(function (event, s) {
    if (event === "TOKEN_REFRESHED") return;
    setTimeout(function () { render(s); }, 0);
  });
})();
