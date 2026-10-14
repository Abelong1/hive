/* Account bar in the page header: Sign in / Create account when signed out,
   name + My entries (+ Admin) + Sign out when signed in. Display only. */
(function () {
  "use strict";
  const H = window.Hive, el = H.el;
  const header = document.querySelector(".site-header");
  if (!header || !window.supabase) return;
  const sb = H.client();
  const bar = el("nav", { class: "acctbar", "aria-label": "Account" });
  header.append(bar);

  async function render(session) {
    H.clear(bar);
    if (!session) {
      bar.append(
        el("a", { class: "acctbar__btn", href: "portal.html", text: "Sign in" }),
        el("a", { class: "acctbar__btn acctbar__btn--primary", href: "portal.html#signup", text: "Create account" }));
      return;
    }
    const r = await sb.from("profiles").select("full_name,role").eq("id", session.user.id).maybeSingle();
    const p = r.data;
    bar.append(el("span", { class: "acctbar__who", text: (p && p.full_name) || session.user.email }));
    bar.append(el("a", { class: "acctbar__btn", href: "portal.html", text: p ? "My account" : "Finish sign-up" }));
    if (p && p.role === "admin") bar.append(el("a", { class: "acctbar__btn", href: "admin.html", text: "Admin" }));
    bar.append(el("button", { class: "acctbar__btn", type: "button", text: "Sign out",
      onclick: async function () { await sb.auth.signOut(); } }));
  }

  sb.auth.onAuthStateChange(function (event, s) {
    if (event === "TOKEN_REFRESHED") return;
    setTimeout(function () { render(s); }, 0);
  });
})();
