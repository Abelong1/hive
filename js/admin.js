/* ACES admin panel. Access is enforced by the database (is_admin() in row-level
   security and in the create_invite function); this page only hides controls for non-admins. */
(function () {
  "use strict";

  const H = window.Hive, el = H.el;
  const sb = H.client();
  const $ = function (id) { return document.getElementById(id); };
  const say = H.makeMessenger($("msg"));
  let session = null, isAdmin = false, started = false;

  function showTab(name) {
    ["review", "published", "codes", "advisers", "corrections"].forEach(function (t) {
      $("pane-" + t).hidden = t !== name;
      $("tab-" + t).setAttribute("aria-selected", String(t === name));
    });
    say("");
    if (name === "review") loadReview();
    if (name === "published") loadPublished();
    if (name === "codes") loadCodes();
    if (name === "advisers") loadAdvisers();
    if (name === "corrections") loadCorrections();
  }
  ["review", "published", "codes", "advisers", "corrections"].forEach(function (t) {
    $("tab-" + t).addEventListener("click", function () { showTab(t); });
  });

  sb.auth.onAuthStateChange(function (event, s) {
    setTimeout(async function () {
      session = s;
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
      if (!s) { $("view-admin").hidden = true; $("view-denied").hidden = false; isAdmin = false; started = false; return; }
      const r = await sb.from("profiles").select("role").eq("id", s.user.id).maybeSingle();
      isAdmin = !!(r.data && r.data.role === "admin");
      $("view-denied").hidden = isAdmin;
      $("view-admin").hidden = !isAdmin;
      if (!isAdmin) { $("denied-text").textContent = "This account is not an ACES admin."; return; }
      if (!started) { started = true; showTab("review"); countCorrections(); }
    }, 0);
  });

  function safeImg(url, alt, cls) {
    return /^https:\/\//i.test(url || "") ? el("img", { src: url, alt: alt, class: cls, loading: "lazy", referrerpolicy: "no-referrer", width: "96" }) : null;
  }

  function field(label, value) {
    return value ? [el("dt", { text: label }), el("dd", { text: value })] : [];
  }

  // ---------- review queue ----------
  async function loadReview() {
    const box = $("review-list");
    H.clear(box);
    const r = await sb.from("theses")
      .select("*,researchers(name,photo_url,position)").eq("status", "pending").order("updated_at", { ascending: true });
    if (r.error) { say("Could not load the queue.", "error"); return; }
    if (!r.data.length) { box.append(el("p", { class: "muted", text: "Nothing waiting. All caught up." })); return; }
    r.data.forEach(function (t) {
      const people = (t.researchers || []).slice().sort(function (a, b) { return a.position - b.position; });
      const dl = el("dl", {}, [].concat(
        field("Adviser", t.adviser), field("Verdict", t.verdict || ""), field("Abstract", t.abstract), field("Conclusion", t.conclusion),
        field("Recommendations", t.recommendations), field("Tags", t.tags.join(", ")),
        field("Technologies", t.technologies.join(", ")), field("References", t.refs.join("\n")),
        field("Researchers", people.map(function (p) { return p.name + (p.photo_url ? " (photo)" : ""); }).join("\n")),
        field("Consent", (t.consent_given ? "Consent given " + H.fmtDate(t.consent_at) : "No consent recorded") +
          (t.groupmates_informed ? "; groupmates informed" : "; groupmates NOT confirmed"))
      ));
      const photos = el("div", {}, [safeImg(t.device_photo_url, t.device_photo_caption || "Device photo", ""), safeImg(t.defense_photo_url, t.defense_photo_caption || "Defense photo", ""), safeImg(t.adviser_photo_url, t.adviser || "Adviser", "")]
        .concat(people.map(function (p) { return safeImg(p.photo_url, p.name, ""); })));
      const approve = el("button", { class: "btn btn--primary btn--small", type: "button", text: "Approve and publish",
        onclick: function () { setStatus(t.id, "approved", "Published."); } });
      const reject = el("button", { class: "btn btn--small btn--danger", type: "button", text: "Do not approve",
        onclick: function () { setStatus(t.id, "rejected", "Marked as not approved. The researcher can edit and resubmit."); } });
      box.append(el("details", { class: "entry review" }, [
        el("summary", { text: t.title + " · S.Y. " + t.school_year }),
        dl, photos, el("div", { class: "actions" }, [approve, reject])
      ]));
    });
  }

  async function setStatus(id, status, okMsg) {
    const r = await sb.from("theses").update({ status: status }).eq("id", id);
    if (r.error) { say("Could not update that entry.", "error"); return; }
    say(okMsg, "ok");
    showTabKeepMsg();
  }
  function showTabKeepMsg() {
    const m = $("msg").textContent, k = $("msg").className;
    if (!$("pane-review").hidden) loadReview();
    if (!$("pane-published").hidden) loadPublished();
    $("msg").textContent = m; $("msg").className = k;
  }

  // ---------- published ----------
  async function loadPublished() {
    const list = $("published-list");
    H.clear(list);
    const r = await sb.from("theses").select("id,title,school_year,is_sample,updated_at").eq("status", "approved").order("year_sort", { ascending: false });
    if (r.error) { say("Could not load published entries.", "error"); return; }
    if (!r.data.length) list.append(el("li", { class: "muted", text: "No published entries." }));
    r.data.forEach(function (t) {
      list.append(el("li", { class: "entry" }, [
        el("div", {}, [el("div", { class: "entry__title", text: t.title }),
          el("div", { class: "entry__meta", text: "S.Y. " + t.school_year + (t.is_sample ? " · sample data" : "") })]),
        el("div", { class: "actions" }, [
        el("a", { class: "btn btn--small", href: "portal.html?edit=" + encodeURIComponent(t.id), text: "Edit" }),
        el("button", { class: "btn btn--small btn--danger", type: "button", text: "Take down",
          onclick: function () { if (confirm("Hide this entry from the public archive?")) setStatus(t.id, "rejected", "Entry taken down."); } })
        ])
      ]));
    });
  }
  $("btn-del-samples").addEventListener("click", async function () {
    if (!confirm("Permanently delete all sample entries?")) return;
    const r = await sb.from("theses").delete().eq("is_sample", true);
    if (r.error) { say("Could not delete sample entries.", "error"); return; }
    say("Sample entries deleted.", "ok");
    loadPublished();
  });

  // ---------- invite codes ----------
  $("form-code").addEventListener("submit", async function (e) {
    e.preventDefault();
    const r = await sb.rpc("create_invite", { p_note: $("code-note").value.trim() || null });
    if (r.error) { say("Could not create a code.", "error"); return; }
    $("code-note").value = "";
    const msg = $("msg");
    say("", "");
    msg.className = "msg msg--ok";
    msg.append("New code (copy it now and send it privately): ", el("span", { class: "code", text: r.data }));
    loadCodes(true);
  });

  async function loadCodes(keepMsg) {
    const list = $("code-list");
    H.clear(list);
    const r = await sb.from("invite_codes").select("code,note,created_at,expires_at,used_at,revoked").order("created_at", { ascending: false }).limit(100);
    if (r.error) { say("Could not load codes.", "error"); return; }
    if (!r.data.length) list.append(el("li", { class: "muted", text: "No codes yet." }));
    r.data.forEach(function (c) {
      const state = c.revoked ? "revoked" : c.used_at ? "used" : new Date(c.expires_at) < new Date() ? "expired" : "active";
      const kids = [
        el("div", {}, [
          el("div", {}, [el("span", { class: "code", text: c.code }), " ", el("span", { class: "badge badge--" + state, text: state })]),
          el("div", { class: "entry__meta", text: (c.note || "No note") + " · created " + H.fmtDate(c.created_at) })
        ])
      ];
      if (state === "active") kids.push(el("button", { class: "btn btn--small btn--danger", type: "button", text: "Revoke", onclick: async function () {
        const u = await sb.from("invite_codes").update({ revoked: true }).eq("code", c.code);
        if (u.error) say("Could not revoke the code.", "error"); else loadCodes();
      } }));
      list.append(el("li", { class: "entry" }, kids));
    });
  }

  // ---------- adviser photos ----------
  async function uploadPhoto(file) {
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
    if (!ext) throw new Error("Use a JPG, PNG or WebP image.");
    if (file.size > 2 * 1024 * 1024) throw new Error("That image is larger than 2 MB.");
    const path = session.user.id + "/advisers/" + crypto.randomUUID() + "." + ext;
    const r = await sb.storage.from("photos").upload(path, file, { contentType: file.type, upsert: false });
    if (r.error) throw new Error("Upload failed. Please try again.");
    return sb.storage.from("photos").getPublicUrl(path).data.publicUrl;
  }

  async function loadAdvisers() {
    const list = $("adviser-list");
    H.clear(list);
    const [a, b] = await Promise.all([
      sb.from("theses").select("adviser"),
      sb.from("advisers").select("name_key,name,photo_url")
    ]);
    if (a.error || b.error) { say("Could not load advisers.", "error"); return; }
    const map = new Map();
    b.data.forEach(function (r) { map.set(r.name_key, { key: r.name_key, name: r.name, photo: r.photo_url, count: 0 }); });
    a.data.forEach(function (t) {
      const name = String(t.adviser || "").trim();
      if (name.length < 2) return;
      const key = name.toLowerCase();
      const p = map.get(key) || { key: key, name: name, photo: "", count: 0 };
      p.count++;
      map.set(key, p);
    });
    const people = Array.from(map.values()).sort(function (x, y) { return x.name.localeCompare(y.name); });
    if (!people.length) { list.append(el("li", { class: "muted", text: "No advisers yet." })); return; }
    people.forEach(function (p) {
      const file = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp", "aria-label": "Photo for " + p.name });
      file.addEventListener("change", async function () {
        if (!file.files[0]) return;
        say("Uploading…");
        try {
          const url = await uploadPhoto(file.files[0]);
          await savePhoto(p, url, "Photo saved for " + p.name + ".");
        } catch (err) { say(err.message, "error"); }
      });
      const kids = [
        safeImg(p.photo, p.name, "") || el("div", { class: "muted", text: "No photo" }),
        el("div", {}, [el("div", { class: "entry__title", text: p.name }),
          el("div", { class: "entry__meta", text: p.count + (p.count === 1 ? " entry" : " entries") }), file])
      ];
      if (p.photo) kids.push(el("button", { class: "btn btn--small btn--danger", type: "button", text: "Remove photo",
        onclick: function () { if (confirm("Remove " + p.name + "'s photo?")) savePhoto(p, "", "Photo removed."); } }));
      list.append(el("li", { class: "entry" }, kids));
    });
  }

  async function savePhoto(p, url, okMsg) {
    const r = await sb.from("advisers").upsert({ name_key: p.key, name: p.name, photo_url: url, updated_at: new Date().toISOString() });
    if (r.error) { say("Could not save the photo.", "error"); return; }
    say(okMsg, "ok");
    const m = $("msg").textContent, k = $("msg").className;
    await loadAdvisers();
    $("msg").textContent = m; $("msg").className = k;
  }
  // ---------- correction requests ----------
  const FIELD_LABELS = { title: "Title", researchers: "Researcher name(s)", school_year: "School year", adviser: "Adviser",
    verdict: "Verdict", abstract: "Abstract", conclusion: "Conclusion", recommendations: "Recommendations", tags: "Tags",
    technologies: "Technologies", references: "References", photos: "Photo", other: "Something else" };
  const REASON_LABELS = { typo: "Typo or misspelling", wrong_info: "Information is wrong", missing_info: "Something is missing",
    outdated: "Outdated", wrong_photo: "Wrong or mislabeled photo", privacy: "Privacy concern", other: "Other" };

  async function countCorrections() {
    const r = await sb.from("correction_requests").select("id", { count: "exact", head: true }).eq("status", "open");
    $("corr-count").textContent = r.count ? String(r.count) : "";
  }

  $("corr-filter").addEventListener("change", function () { loadCorrections(); });

  async function loadCorrections() {
    const box = $("corr-list");
    H.clear(box);
    let q = sb.from("correction_requests").select("*,theses(title,school_year)").order("created_at", { ascending: false }).limit(200);
    const f = $("corr-filter").value;
    if (f !== "all") q = q.eq("status", f);
    const r = await q;
    if (r.error) { say("Could not load correction requests.", "error"); return; }
    countCorrections();
    if (!r.data.length) { box.append(el("p", { class: "muted", text: f === "open" ? "No open requests." : "Nothing here." })); return; }
    r.data.forEach(function (c) {
      const t = c.theses || {};
      const dl = el("dl", {}, [].concat(
        field("Entry", (t.title || "(deleted entry)") + (t.school_year ? " · S.Y. " + t.school_year : "")),
        field("What is wrong", FIELD_LABELS[c.field] || c.field),
        field("Reason", REASON_LABELS[c.reason] || c.reason),
        field("Currently shows", c.current_value), field("Should be", c.suggested_value),
        field("Why", c.details),
        field("From", c.requester_name + " (" + c.relation + ")" + (c.requester_email ? " · " + c.requester_email : "")),
        field("Sent", H.fmtDate(c.created_at)),
        field("Status", c.status + (c.resolved_at ? " · " + H.fmtDate(c.resolved_at) : "")),
        field("Admin note", c.admin_note)
      ));
      const kids = [dl];
      if (c.status === "open") {
        const note = el("input", { type: "text", maxlength: "1000", placeholder: "Note (optional), e.g. what was changed", "aria-label": "Admin note" });
        kids.push(note, el("div", { class: "actions" }, [
          el("a", { class: "btn btn--small", href: "portal.html?edit=" + encodeURIComponent(c.thesis_id), target: "_blank", rel: "noopener", text: "Edit entry" }),
          el("button", { class: "btn btn--primary btn--small", type: "button", text: "Mark resolved",
            onclick: function () { closeCorrection(c.id, "resolved", note.value, "Marked resolved."); } }),
          el("button", { class: "btn btn--small btn--danger", type: "button", text: "Dismiss",
            onclick: function () { closeCorrection(c.id, "dismissed", note.value, "Request dismissed."); } })
        ]));
      } else {
        kids.push(el("div", { class: "actions" }, [el("button", { class: "btn btn--small", type: "button", text: "Reopen",
          onclick: function () { closeCorrection(c.id, "open", c.admin_note || "", "Reopened."); } })]));
      }
      box.append(el("details", { class: "entry review", open: c.status === "open" }, [
        el("summary", { text: (FIELD_LABELS[c.field] || c.field) + " — " + (t.title || "(deleted entry)") }), el("div", {}, kids)
      ]));
    });
  }

  async function closeCorrection(id, status, note, okMsg) {
    const open = status === "open";
    const r = await sb.from("correction_requests").update({
      status: status, admin_note: note.trim() || null,
      resolved_at: open ? null : new Date().toISOString(), resolved_by: open ? null : session.user.id
    }).eq("id", id);
    if (r.error) { say("Could not update the request.", "error"); return; }
    await loadCorrections();
    say(okMsg, "ok");
  }
})();
