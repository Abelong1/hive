/* Researcher portal: sign in, redeem invite code, create/edit own entries.
   Every rule that matters (who can edit what, what becomes public) is enforced by the
   database's row-level security; this file is only the user interface. */
(function () {
  "use strict";

  const H = window.Hive, el = H.el;
  const sb = H.client();
  const $ = function (id) { return document.getElementById(id); };
  const say = H.makeMessenger($("msg"));
  const NOTICE_VERSION = "v0-prototype";
  const VIEWS = ["view-auth", "view-recovery", "view-redeem", "view-dash", "view-form"];
  const STATUS_LABEL = { draft: "Draft", pending: "In review", approved: "Published", rejected: "Not approved" };

  let session = null, profile = null, editing = null, busy = false, recovering = false, currentView = "";

  function show(id) {
    currentView = id;
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
    window.scrollTo(0, 0);
  }

  // ---------- auth ----------
  function tab(which) {
    const isIn = which === "in";
    $("form-signin").hidden = !isIn;
    $("form-signup").hidden = isIn;
    $("tab-signin").setAttribute("aria-selected", String(isIn));
    $("tab-signup").setAttribute("aria-selected", String(!isIn));
    say("");
  }
  $("tab-signin").addEventListener("click", function () { tab("in"); });
  $("tab-signup").addEventListener("click", function () { tab("up"); });
  if (location.hash === "#signup") tab("up");

  $("form-signin").addEventListener("submit", async function (e) {
    e.preventDefault();
    say("Signing in…");
    const r = await sb.auth.signInWithPassword({ email: $("si-email").value.trim(), password: $("si-password").value });
    if (r.error) sb.rpc("report_failed_login", { p_email: $("si-email").value.trim() }).then(function () {}, function () {});
    if (r.error) say("Sign in failed. Check your email and password, and make sure you confirmed your email first.", "error");
    else say("");
  });

  $("form-signup").addEventListener("submit", async function (e) {
    e.preventDefault();
    const pw = $("su-password").value;
    if (pw.length < 10) { say("Use a password of at least 10 characters.", "error"); return; }
    say("Creating account…");
    const r = await sb.auth.signUp({
      email: $("su-email").value.trim(), password: pw,
      options: { emailRedirectTo: location.origin + location.pathname }
    });
    if (r.error) say("Could not create the account: " + r.error.message, "error");
    else say("Almost done. Open the confirmation link we emailed you, then sign in here.", "ok");
  });

  $("btn-forgot").addEventListener("click", async function () {
    const email = $("si-email").value.trim();
    if (!email) { say("Type your email above first.", "error"); return; }
    const r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (r.error && (r.error.status === 429 || /rate limit/i.test(r.error.message || ""))) {
      say("Too many emails were sent recently. Wait about an hour, then try again. Check your spam folder for an earlier link.", "error");
      return;
    }
    say("If that email has an account, a reset link is on its way. Use the newest email; older links stop working.", "ok");
  });

  $("form-recovery").addEventListener("submit", async function (e) {
    e.preventDefault();
    const pw = $("rc-password").value;
    if (pw.length < 10) { say("Use a password of at least 10 characters.", "error"); return; }
    const r = await sb.auth.updateUser({ password: pw });
    if (r.error) { say("Could not change the password: " + r.error.message, "error"); return; }
    recovering = false;
    say("Password updated.", "ok");
    route();
  });

  document.querySelectorAll("[data-signout]").forEach(function (b) {
    b.addEventListener("click", async function () { await sb.auth.signOut(); say(""); });
  });

  $("form-redeem").addEventListener("submit", async function (e) {
    e.preventDefault();
    say("Checking code…");
    const r = await sb.rpc("redeem_invite", { p_code: $("rd-code").value, p_full_name: $("rd-name").value });
    if (r.error) { say("That code is invalid, expired, or already used. Ask ACES for a new one.", "error"); return; }
    say("Welcome aboard.", "ok");
    route();
  });

  sb.auth.onAuthStateChange(function (event, s) {
    // Deferred: never call Supabase methods synchronously inside this callback.
    setTimeout(function () {
      const prev = session && session.user.id;
      session = s;
      if (event === "PASSWORD_RECOVERY") { recovering = true; show("view-recovery"); return; }
      if (recovering || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
      if (event === "SIGNED_IN" && s && prev === s.user.id && currentView !== "view-auth") return;
      route();
    }, 0);
  });

  async function route() {
    if (!session) { profile = null; show("view-auth"); return; }
    const r = await sb.from("profiles").select("full_name,role").eq("id", session.user.id).maybeSingle();
    if (r.error) { say("Could not load your account. Please refresh the page.", "error"); return; }
    profile = r.data;
    if (!profile) { show("view-redeem"); return; }
    await loadEntries();
    show("view-dash");
  }

  // ---------- account ----------
  function renderAccount() {
    const dl = $("acct-info"), u = session.user;
    H.clear(dl);
    [["Name", profile.full_name || "—"], ["Email", u.email],
     ["Role", profile.role === "admin" ? "ACES admin" : "Researcher"],
     ["Member since", H.fmtDate(u.created_at)],
     ["Email confirmed", u.email_confirmed_at ? H.fmtDate(u.email_confirmed_at) : "Not yet"],
     ["Last sign-in", u.last_sign_in_at ? H.fmtDate(u.last_sign_in_at) : "—"]
    ].forEach(function (d) { dl.append(el("dt", { text: d[0] }), el("dd", { text: d[1] })); });
    $("acct-name").value = profile.full_name || "";
  }
  $("form-name").addEventListener("submit", async function (e) {
    e.preventDefault();
    const r = await sb.rpc("update_my_name", { p_full_name: $("acct-name").value });
    if (r.error) { say("Could not save the name. Use at least 2 characters.", "error"); return; }
    profile.full_name = $("acct-name").value.trim();
    await loadEntries();
    say("Name updated.", "ok");
  });
  $("form-password").addEventListener("submit", async function (e) {
    e.preventDefault();
    const pw = $("acct-password").value;
    if (pw.length < 10) { say("Use a password of at least 10 characters.", "error"); return; }
    const r = await sb.auth.updateUser({ password: pw });
    if (r.error) { say("Could not change the password: " + r.error.message, "error"); return; }
    $("acct-password").value = "";
    say("Password updated.", "ok");
  });

  // ---------- dashboard ----------
  async function loadEntries() {
    const sub = $("dash-sub");
    H.clear(sub);
    sub.append("Signed in as " + (profile.full_name || session.user.email) + ". ");
    if (profile.role === "admin") sub.append(el("a", { href: "admin.html", text: "Open admin panel" }));
    renderAccount();

    const r = await sb.from("theses").select("id,title,school_year,status,updated_at")
      .eq("owner_id", session.user.id).order("updated_at", { ascending: false });
    const list = $("entries");
    H.clear(list);
    if (r.error) { say("Could not load your entries.", "error"); return; }
    $("entries-empty").hidden = r.data.length > 0;
    r.data.forEach(function (t) {
      list.append(el("li", { class: "entry" }, [
        el("div", {}, [
          el("div", { class: "entry__title", text: t.title }),
          el("div", { class: "entry__meta", text: "S.Y. " + t.school_year + " · updated " + H.fmtDate(t.updated_at) + " " }),
          el("span", { class: "badge badge--" + t.status, text: STATUS_LABEL[t.status] || t.status })
        ]),
        el("button", { class: "btn btn--small", type: "button", text: "Edit", onclick: function () { openForm(t.id); } })
      ]));
    });
  }
  $("btn-new").addEventListener("click", function () { openForm(null); });

  // ---------- entry form ----------
  const yearSel = $("f-year");
  H.SCHOOL_YEARS.forEach(function (y) { yearSel.append(el("option", { value: y, text: y })); });

  async function openForm(id) {
    say("");
    editing = { id: id, status: "draft", photo_url: "", researchers: [{ name: "", photo_url: "" }] };
    let t = null;
    if (id) {
      const a = await sb.from("theses").select("*").eq("id", id).single();
      const b = await sb.from("researchers").select("name,photo_url,position").eq("thesis_id", id).order("position");
      if (a.error || b.error) { say("Could not open that entry.", "error"); return; }
      t = a.data;
      editing.status = t.status;
      editing.photo_url = t.device_photo_url || "";
      editing.researchers = b.data.length ? b.data.map(function (r) { return { name: r.name, photo_url: r.photo_url || "" }; })
                                          : editing.researchers;
    }
    $("form-title").textContent = id ? "Edit entry" : "New entry";
    $("f-title").value = t ? t.title : "";
    yearSel.value = t ? t.school_year : H.SCHOOL_YEARS[1] || H.SCHOOL_YEARS[0];
    $("f-adviser").value = t ? t.adviser : "";
    $("f-abstract").value = t ? t.abstract : "";
    $("f-conclusion").value = t ? t.conclusion : "";
    $("f-recs").value = t ? t.recommendations : "";
    $("f-tags").value = t ? t.tags.join(", ") : "";
    $("f-tech").value = t ? t.technologies.join(", ") : "";
    $("f-refs").value = t ? t.refs.join("\n") : "";
    $("f-photo-cap").value = t ? t.device_photo_caption : "";
    $("f-photo").value = "";
    $("f-photo-status").textContent = editing.photo_url ? "A photo is attached. Choose a new file to replace it." : "";
    $("f-consent").checked = t ? t.consent_given : false;
    $("f-group").checked = t ? t.groupmates_informed : false;
    $("btn-delete").hidden = !id;

    const notice = $("form-notice");
    notice.hidden = true;
    if (editing.status === "approved") {
      notice.textContent = "This entry is published. Saving any change sends it back for review and hides it until ACES approves it again.";
      notice.hidden = false;
    } else if (editing.status === "rejected") {
      notice.textContent = "ACES did not approve this version. Update it and submit again, or contact ACES for details.";
      notice.hidden = false;
    } else if (editing.status === "pending") {
      notice.textContent = "This entry is waiting for review. Saving keeps it in the queue.";
      notice.hidden = false;
    }
    renderResearchers();
    show("view-form");
  }

  async function uploadPhoto(file) {
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
    if (!ext) throw new Error("Use a JPG, PNG or WebP image.");
    if (file.size > 2 * 1024 * 1024) throw new Error("That image is larger than 2 MB.");
    const path = session.user.id + "/" + crypto.randomUUID() + "." + ext;
    const r = await sb.storage.from("photos").upload(path, file, { contentType: file.type, upsert: false });
    if (r.error) throw new Error("Upload failed. Please try again.");
    return sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
  }

  $("f-photo").addEventListener("change", async function (e) {
    const f = e.target.files[0];
    if (!f) return;
    $("f-photo-status").textContent = "Uploading…";
    try {
      editing.photo_url = await uploadPhoto(f);
      $("f-photo-status").textContent = "Photo attached.";
    } catch (err) {
      e.target.value = "";
      $("f-photo-status").textContent = err.message;
    }
  });

  function renderResearchers() {
    const box = $("researchers");
    H.clear(box);
    editing.researchers.forEach(function (r, i) {
      const status = el("p", { class: "muted", text: r.photo_url ? "Photo attached." : "" });
      const file = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp", "aria-label": "Photo for researcher " + (i + 1) });
      file.addEventListener("change", async function () {
        if (!file.files[0]) return;
        status.textContent = "Uploading…";
        try { r.photo_url = await uploadPhoto(file.files[0]); status.textContent = "Photo attached."; }
        catch (err) { file.value = ""; status.textContent = err.message; }
      });
      const name = el("input", { type: "text", maxlength: "120", placeholder: "Full name", value: r.name, "aria-label": "Name of researcher " + (i + 1) });
      name.addEventListener("input", function () { r.name = name.value; });
      const rm = el("button", { class: "btn btn--small", type: "button", text: "Remove",
        onclick: function () { editing.researchers.splice(i, 1); if (!editing.researchers.length) editing.researchers.push({ name: "", photo_url: "" }); renderResearchers(); } });
      box.append(el("div", {}, [el("div", { class: "researcher-row" }, [name, file, rm]), status]));
    });
  }
  $("btn-add-researcher").addEventListener("click", function () {
    if (editing.researchers.length >= 8) return;
    editing.researchers.push({ name: "", photo_url: "" });
    renderResearchers();
  });

  function splitList(v, re) { return v.split(re).map(function (s) { return s.trim(); }).filter(Boolean); }

  function collect() {
    return {
      title: $("f-title").value.trim(), school_year: yearSel.value, adviser: $("f-adviser").value.trim(),
      abstract: $("f-abstract").value.trim(), conclusion: $("f-conclusion").value.trim(),
      recommendations: $("f-recs").value.trim(),
      tags: splitList($("f-tags").value, /,/), technologies: splitList($("f-tech").value, /,/),
      refs: splitList($("f-refs").value, /\n/), caption: $("f-photo-cap").value.trim(),
      consent: $("f-consent").checked, group: $("f-group").checked,
      names: editing.researchers.filter(function (r) { return r.name.trim(); })
    };
  }

  function validate(v, status) {
    if (v.title.length < 5) return "Please enter the thesis title.";
    if (v.tags.length > 10) return "Use at most 10 tags.";
    if (v.technologies.length > 20) return "Use at most 20 technologies.";
    if (v.refs.length > 30) return "Use at most 30 references.";
    if (status === "pending") {
      if (!v.adviser) return "Please enter the adviser's name.";
      if (v.abstract.length < 100) return "The abstract needs at least 100 characters before you can submit.";
      if (!v.names.length) return "List at least one researcher.";
      if (!v.consent || !v.group) return "Tick both consent boxes to submit for review. You can still save a draft without them.";
    }
    return "";
  }

  async function save(status) {
    if (busy) return;
    const v = collect();
    const bad = validate(v, status);
    if (bad) { say(bad, "error"); return; }
    busy = true;
    document.querySelectorAll("#form-entry button").forEach(function (b) { b.disabled = true; });
    say("Saving…");
    try {
      const row = {
        title: v.title, school_year: v.school_year, adviser: v.adviser, abstract: v.abstract,
        conclusion: v.conclusion, recommendations: v.recommendations, tags: v.tags,
        technologies: v.technologies, refs: v.refs, device_photo_url: editing.photo_url || "",
        device_photo_caption: v.caption, status: status,
        consent_given: v.consent, groupmates_informed: v.group
      };
      let id = editing.id;
      if (id) {
        const u = await sb.from("theses").update(row).eq("id", id);
        if (u.error) throw u.error;
      } else {
        row.owner_id = session.user.id;
        const i = await sb.from("theses").insert(row).select("id").single();
        if (i.error) throw i.error;
        id = i.data.id;
      }
      const d = await sb.from("researchers").delete().eq("thesis_id", id);
      if (d.error) throw d.error;
      if (v.names.length) {
        const ins = await sb.from("researchers").insert(v.names.map(function (r, i) {
          return { thesis_id: id, name: r.name.trim(), photo_url: r.photo_url || "", position: i };
        }));
        if (ins.error) throw ins.error;
      }
      if (status === "pending") {
        await sb.from("consent_log").insert({ thesis_id: id, user_id: session.user.id, notice_version: NOTICE_VERSION, groupmates_informed: true });
      }
      await loadEntries();
      show("view-dash");
      say(status === "pending" ? "Submitted. ACES will review it before it appears in the archive." : "Draft saved.", "ok");
    } catch (err) {
      say(err && err.code === "23514" ? "Some fields are not valid (check lengths and photo links)." : "Could not save. Please try again.", "error");
    } finally {
      busy = false;
      document.querySelectorAll("#form-entry button").forEach(function (b) { b.disabled = false; });
    }
  }

  $("form-entry").addEventListener("submit", function (e) {
    e.preventDefault();
    save(e.submitter && e.submitter.value === "pending" ? "pending" : "draft");
  });
  $("btn-cancel").addEventListener("click", function () { say(""); show("view-dash"); });
  $("btn-delete").addEventListener("click", async function () {
    if (!editing || !editing.id || !confirm("Delete this entry permanently?")) return;
    const r = await sb.from("theses").delete().eq("id", editing.id);
    if (r.error) { say("Could not delete the entry.", "error"); return; }
    await loadEntries();
    show("view-dash");
    say("Entry deleted.", "ok");
  });
})();
