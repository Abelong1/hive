/* ACES activity logs. Reading is limited to admins by the database (RLS on activity_log
   and is_admin() checks inside the admin_* functions); this page only renders. */
(function () {
  "use strict";

  const H = window.Hive, el = H.el;
  const sb = H.client();
  const $ = function (id) { return document.getElementById(id); };
  const say = H.makeMessenger($("msg"));
  const PAGE = 100;

  const TABS = [
    { id: "overview", label: "Overview" },
    { id: "edits", label: "Edit log", cats: ["edit", "adviser"] },
    { id: "status", label: "Status log", cats: ["status"] },
    { id: "signins", label: "Sign-ins" },
    { id: "codes", label: "Invite codes", cats: ["code"] },
    { id: "consent", label: "Consent", cats: ["consent"] }
  ];
  const FIELD_NAMES = {
    title: "Title", school_year: "School year", adviser: "Adviser", abstract: "Abstract", conclusion: "Conclusion",
    recommendations: "Recommendations", tags: "Tags", technologies: "Technologies", refs: "References",
    device_photo_url: "Device photo", device_photo_caption: "Photo caption", researchers: "Researchers",
    status: "Status", photo_url: "Photo", consent_given: "Consent", groupmates_informed: "Groupmates informed",
    note: "Note", expires_at: "Expires", notice_version: "Notice version"
  };

  let current = "overview", rows = [], offset = 0, started = false;

  // ---------- tabs ----------
  TABS.forEach(function (t) {
    $("tabs").append(el("button", { type: "button", class: "tab", role: "tab", id: "tab-" + t.id,
      "aria-selected": "false", text: t.label, onclick: function () { showTab(t.id); } }));
  });

  function showTab(id) {
    current = id;
    TABS.forEach(function (t) { $("tab-" + t.id).setAttribute("aria-selected", String(t.id === id)); });
    $("pane-overview").hidden = id !== "overview";
    $("pane-log").hidden = id === "overview";
    say("");
    if (id === "overview") loadOverview(); else reloadLog();
  }

  sb.auth.onAuthStateChange(function (event, s) {
    setTimeout(async function () {
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
      if (!s) { $("view-main").hidden = true; $("view-denied").hidden = false; started = false; return; }
      const r = await sb.from("profiles").select("role").eq("id", s.user.id).maybeSingle();
      const isAdmin = !!(r.data && r.data.role === "admin");
      $("view-denied").hidden = isAdmin;
      $("view-main").hidden = !isAdmin;
      if (!isAdmin) { $("denied-text").textContent = "This account is not an ACES admin."; return; }
      if (!started) { started = true; showTab("overview"); }
    }, 0);
  });

  // ---------- helpers ----------
  function fmt(v) {
    if (v == null || v === "") return "—";
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === "object") return v.map(function (r) { return r.name + (r.photo_url ? " (photo)" : ""); }).join("\n");
      return v.join(", ") || "—";
    }
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }
  function who(r) { return r.actor_email || (r.category === "auth" ? "visitor" : "system"); }
  function entryName(r) { return r.thesis_title || r.target || "—"; }
  function badgeClass(action) {
    if (/approved|redeemed|consent given|consent recorded|photo set|created/.test(action)) return "approved";
    if (/rejected|taken down|revoked|deleted|withdrawn|failed|removed|expired/.test(action)) return "rejected";
    if (/submitted|edited|researchers/.test(action)) return "pending";
    return "draft";
  }
  function line(r) {
    return el("div", {}, [
      el("div", {}, [el("span", { class: "badge badge--" + badgeClass(r.action), text: r.action }), " ",
        el("span", { class: "entry__title", text: entryName(r) })]),
      el("div", { class: "entry__meta", text: H.fmtDate(r.at) + " · " + who(r) +
        (r.details && r.details.restored_from ? " · restore of #" + r.details.restored_from : "") })
    ]);
  }
  function sanitize(s) { return s.replace(/[,()*%\\]/g, " ").trim(); }

  // ---------- overview ----------
  async function loadOverview() {
    const stats = $("stats"), alerts = $("alert-list"), recent = $("recent-list");
    [stats, alerts, recent].forEach(H.clear);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const count = function (q) { return q.then(function (r) { return r.error ? "?" : r.count; }); };
    const res = await Promise.all([
      count(sb.from("theses").select("id", { count: "exact", head: true }).eq("status", "pending")),
      count(sb.from("theses").select("id", { count: "exact", head: true }).eq("status", "approved")),
      count(sb.from("invite_codes").select("code", { count: "exact", head: true }).eq("revoked", false).is("used_at", null).gt("expires_at", new Date().toISOString())),
      count(sb.from("profiles").select("id", { count: "exact", head: true }).eq("role", "researcher")),
      count(sb.from("activity_log").select("id", { count: "exact", head: true }).gte("at", dayStart.toISOString())),
      sb.rpc("admin_alerts"),
      sb.from("activity_log").select("*").order("at", { ascending: false }).limit(10)
    ]);
    [["Pending review", res[0]], ["Published", res[1]], ["Active codes", res[2]], ["Researchers", res[3]], ["Events today", res[4]]]
      .forEach(function (s) { stats.append(el("div", { class: "stat" }, [el("div", { class: "stat__n", text: String(s[1]) }), el("div", { class: "stat__l", text: s[0] })])); });

    const al = res[5];
    if (al.error) alerts.append(el("li", { class: "muted", text: "Could not load alerts." }));
    else if (!al.data.length) alerts.append(el("li", { class: "muted", text: "No alerts. Nothing unusual in the last 24 hours." }));
    else al.data.forEach(function (a) {
      alerts.append(el("li", { class: "entry entry--alert" }, [el("div", {}, [
        el("div", { class: "entry__title", text: a.kind + ": " + (a.who || "unknown") }),
        el("div", { class: "entry__meta", text: a.n + " times between " + H.fmtDate(a.first_at) + " and " + H.fmtDate(a.last_at) })
      ])]));
    });

    const rc = res[6];
    if (rc.error) { recent.append(el("li", { class: "muted", text: "Could not load activity." })); return; }
    if (!rc.data.length) recent.append(el("li", { class: "muted", text: "No activity recorded yet." }));
    rc.data.forEach(function (r) { recent.append(el("li", { class: "entry" }, [line(r)])); });
  }

  // ---------- log tabs ----------
  $("filters").addEventListener("submit", function (e) { e.preventDefault(); reloadLog(); });
  $("btn-more").addEventListener("click", function () { loadLog(false); });

  function reloadLog() { rows = []; offset = 0; H.clear($("log-list")); loadLog(true); }

  function range() {
    const f = $("f-from").value, t = $("f-to").value;
    return {
      from: f ? new Date(f + "T00:00:00").toISOString() : null,
      to: t ? new Date(t + "T23:59:59.999").toISOString() : null,
      user: sanitize($("f-user").value.toLowerCase()),
      entry: sanitize($("f-entry").value)
    };
  }

  async function loadLog(first) {
    $("btn-more").hidden = true;
    $("log-note").textContent = "";
    if (current === "signins") return loadSignins();
    const tab = TABS.find(function (t) { return t.id === current; });
    const f = range();
    let q = sb.from("activity_log").select("*").in("category", tab.cats).order("at", { ascending: false }).range(offset, offset + PAGE - 1);
    if (f.from) q = q.gte("at", f.from);
    if (f.to) q = q.lte("at", f.to);
    if (f.user) q = q.ilike("actor_email", "%" + f.user + "%");
    if (f.entry) q = q.or("thesis_title.ilike.%" + f.entry + "%,target.ilike.%" + f.entry + "%");
    const r = await q;
    if (r.error) { say("Could not load the log.", "error"); return; }
    let data = r.data;
    offset += data.length;
    if (current === "codes" && first) data = (await expiredCodes(f)).concat(data).sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    rows = rows.concat(data);
    render(data);
    $("btn-more").hidden = r.data.length < PAGE;
    if (!rows.length) $("log-list").append(el("li", { class: "muted", text: "Nothing here." }));
  }

  // Expiry isn't an event anyone performs, so it is derived from the codes table.
  async function expiredCodes(f) {
    let q = sb.from("invite_codes").select("code,note,expires_at").eq("revoked", false).is("used_at", null)
      .lt("expires_at", f.to || new Date().toISOString()).order("expires_at", { ascending: false }).limit(PAGE);
    if (f.from) q = q.gte("expires_at", f.from);
    if (f.entry) q = q.or("code.ilike.%" + f.entry + "%,note.ilike.%" + f.entry + "%");
    if (f.user) return [];
    const r = await q;
    if (r.error) return [];
    return r.data.map(function (c) {
      return { id: "x-" + c.code, at: c.expires_at, category: "code", action: "expired", target: c.code,
        actor_email: null, changed: [], before: null, after: { note: c.note }, details: {} };
    });
  }

  function render(data) {
    const list = $("log-list");
    data.forEach(function (r) {
      const body = [];
      const keys = r.changed && r.changed.length ? r.changed : Object.keys(Object.assign({}, r.before || {}, r.after || {}));
      if (r.action === "researchers") {
        body.push(diffTable([["Researchers", fmt(r.before), fmt(r.after)]]));
      } else if (keys.length) {
        body.push(diffTable(keys.map(function (k) {
          return [FIELD_NAMES[k] || k, fmt(r.before && r.before[k]), fmt(r.after && r.after[k])];
        })));
      }
      if (r.category === "edit" && r.before && (r.action === "edited" || r.action === "researchers")) {
        body.push(el("div", { class: "actions" }, [el("button", { class: "btn btn--small", type: "button",
          text: "Restore previous version", onclick: function () { restore(r); } })]));
      }
      list.append(body.length
        ? el("li", { class: "entry entry--log" }, [el("details", {}, [el("summary", {}, [line(r)])].concat(body))])
        : el("li", { class: "entry" }, [line(r)]));
    });
  }

  function diffTable(rowsData) {
    return el("table", { class: "diff" }, [
      el("thead", {}, [el("tr", {}, [el("th", { text: "Field" }), el("th", { text: "Before" }), el("th", { text: "After" })])]),
      el("tbody", {}, rowsData.map(function (d) {
        return el("tr", {}, [el("th", { text: d[0] }), el("td", { class: "diff__old", text: d[1] }), el("td", { class: "diff__new", text: d[2] })]);
      }))
    ]);
  }

  async function restore(r) {
    if (!confirm("Restore \"" + entryName(r) + "\" to how it was before this change? The restore is logged too.")) return;
    const res = await sb.rpc("admin_restore", { p_log_id: r.id });
    if (res.error) { say("Could not restore: " + (res.error.message || "error"), "error"); return; }
    say("Restored. If the entry was published, it stays published.", "ok");
    const m = $("msg").textContent, k = $("msg").className;
    reloadLog();
    $("msg").textContent = m; $("msg").className = k;
  }

  // ---------- sign-ins ----------
  const AUTH_LABELS = {
    login: "signed in", logout: "signed out", user_signedup: "signed up", user_recovery_requested: "password reset requested",
    user_updated_password: "password changed", user_confirmation_requested: "confirmation email sent",
    user_repeated_signup: "repeated sign-up", user_deleted: "account deleted", user_modified: "account updated",
    token_revoked: "session ended"
  };

  async function loadSignins() {
    const list = $("log-list");
    const f = range();
    const [ev, ac] = await Promise.all([
      sb.rpc("admin_auth_events", { p_since: f.from || new Date(Date.now() - 30 * 864e5).toISOString(), p_limit: 2000 }),
      sb.rpc("admin_accounts")
    ]);
    if (ev.error || ac.error) { say("Could not load sign-ins.", "error"); return; }
    const events = ev.data.filter(function (e) {
      return (!f.to || e.at <= f.to) && (!f.user || String(e.email || "").toLowerCase().indexOf(f.user) >= 0);
    }).map(function (e) {
      return { id: "a", at: e.at, category: "auth", action: AUTH_LABELS[e.action] || e.action,
        target: e.email || "unknown", actor_email: e.email, ip: e.ip, details: {} };
    });
    rows = events;
    const fromAudit = ev.data.some(function (e) { return e.user_id || e.ip; });
    $("log-note").textContent = fromAudit ? "" :
      "Successful sign-ins, sign-ups and password resets appear here once Supabase writes its auth audit log to the database " +
      "(Dashboard → Authentication → Audit Logs → turn OFF \"Disable writing auth audit logs to project database\"). " +
      "Failed portal sign-ins are recorded already. The account list below always shows each user's last sign-in.";

    list.append(el("li", {}, [el("h3", { text: "Events" })]));
    if (!events.length) list.append(el("li", { class: "muted", text: "No sign-in events for this period." }));
    events.forEach(function (e) {
      list.append(el("li", { class: "entry" }, [el("div", {}, [
        el("div", {}, [el("span", { class: "badge badge--" + badgeClass(e.action), text: e.action }), " ", el("span", { class: "entry__title", text: e.target })]),
        el("div", { class: "entry__meta", text: H.fmtDate(e.at) + (e.ip ? " · IP " + e.ip : "") })
      ])]));
    });

    list.append(el("li", {}, [el("h3", { text: "Accounts" })]));
    ac.data.filter(function (a) { return !f.user || String(a.email).toLowerCase().indexOf(f.user) >= 0; }).forEach(function (a) {
      list.append(el("li", { class: "entry" }, [el("div", {}, [
        el("div", {}, [el("span", { class: "entry__title", text: (a.full_name || a.email) }), " ",
          el("span", { class: "badge badge--" + (a.role === "admin" ? "approved" : a.role === "researcher" ? "used" : "pending"), text: a.role })]),
        el("div", { class: "entry__meta", text: a.email + " · joined " + H.fmtDate(a.created_at) +
          (a.confirmed_at ? "" : " · email not confirmed") +
          " · last sign-in " + (a.last_sign_in_at ? H.fmtDate(a.last_sign_in_at) : "never") +
          (a.recovery_sent_at ? " · last reset request " + H.fmtDate(a.recovery_sent_at) : "") })
      ])]));
    });
  }

  // ---------- CSV ----------
  $("btn-csv").addEventListener("click", function () {
    if (!rows.length) { say("Nothing to export.", "info"); return; }
    const q = function (v) { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const safe = function (v) { const s = v == null ? "" : String(v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }; // block spreadsheet formulas
    const head = ["time", "category", "action", "user", "entry", "fields", "before", "after", "ip"];
    const lines = [head.join(",")].concat(rows.map(function (r) {
      return [r.at, r.category, r.action, who(r), entryName(r), (r.changed || []).join(" "),
        r.before ? JSON.stringify(r.before) : "", r.after ? JSON.stringify(r.after) : "", r.ip || ""]
        .map(function (v) { return q(safe(v)); }).join(",");
    }));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "hive-" + current + "-" + new Date().toISOString().slice(0, 10) + ".csv" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
})();
