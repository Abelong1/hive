/* HIVE archive page: reads approved entries from the database (see config.js). */
(function () {
  "use strict";

  // ---- state ---------------------------------------------------------------
  let activeTags = new Set();
  let currentYear = "all";
  let currentQuery = "";
  let lastFocused = null;
  let THESIS_DATA = [];
  const ADVISER_PHOTOS = {};

  // ---- DOM refs --------------------------------------------------------------
  const gridEl = document.getElementById("honeycomb");
  const searchInput = document.getElementById("search-input");
  const yearSelect = document.getElementById("year-select");
  const tagFiltersEl = document.getElementById("tag-filters");
  const resultCountEl = document.getElementById("result-count");
  const modalOverlay = document.getElementById("modal-overlay");
  const modalContent = document.getElementById("modal-content");

  // ---- boot -------------------------------------------------------------
  function init() {
    resultCountEl.textContent = "Loading archive…";
    loadData();

    searchInput.addEventListener("input", function (e) {
      currentQuery = e.target.value.trim().toLowerCase();
      render();
    });

    yearSelect.addEventListener("change", function (e) {
      currentYear = e.target.value;
      render();
    });

    document.getElementById("nav-theses").addEventListener("click", function () { showView("theses"); });
    document.getElementById("nav-people").addEventListener("click", function () { showView("people"); });

    modalOverlay.addEventListener("click", function (e) {
      if (e.target === modalOverlay) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
      if (e.key === "Tab" && !modalOverlay.hidden) {
        const f = modalOverlay.querySelectorAll("a[href], button:not([disabled])");
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (!modalOverlay.contains(document.activeElement) ||
            (e.shiftKey && document.activeElement === first)) {
          e.preventDefault(); (e.shiftKey ? last : first).focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    });

    // Re-run the honeycomb layout on resize (debounced), since the number
    // of hexes that fit per row depends on the available width.
    let resizeTimer = null;
    let lastWidth = window.innerWidth;
    window.addEventListener("resize", function () {
      if (window.innerWidth === lastWidth) return; // ignore mobile address-bar height changes
      lastWidth = window.innerWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { render(); renderPeople(); }, 120);
    });
  }

  // ---- data (public, approved entries only; enforced by database policies) ----
  async function loadData() {
    try {
      const cfg = window.HIVE_CONFIG;
      const cols = "id,title,school_year,year_sort,adviser,abstract,conclusion,recommendations," +
        "tags,technologies,refs,device_photo_url,device_photo_caption,researchers(name,photo_url,position)";
      const url = cfg.url + "/rest/v1/theses?select=" + encodeURIComponent(cols) +
        "&status=eq.approved&order=year_sort.desc,created_at.desc";
      const res = await fetch(url, { headers: { apikey: cfg.key } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const rows = await res.json();
      THESIS_DATA = rows.map(mapRow);
      try {
        const ar = await fetch(cfg.url + "/rest/v1/advisers?select=name_key,photo_url", { headers: { apikey: cfg.key } });
        if (ar.ok) (await ar.json()).forEach(function (a) { if (a.photo_url) ADVISER_PHOTOS[a.name_key] = a.photo_url; });
      } catch (e) { /* photos are optional */ }
      populateYearFilter();
      populateTagFilters();
      render();
      renderPeople();
    } catch (err) {
      resultCountEl.textContent = "Could not load the archive right now. Please refresh in a moment.";
      gridEl.innerHTML = "";
    }
  }

  function mapRow(t) {
    return {
      id: String(t.id).slice(0, 8).toUpperCase(),
      title: t.title,
      schoolYear: t.school_year,
      yearSort: t.year_sort,
      adviser: t.adviser,
      abstract: t.abstract,
      conclusion: t.conclusion || "",
      recommendations: t.recommendations || "",
      tags: t.tags || [],
      technologies: t.technologies || [],
      references: t.refs || [],
      devicePhoto: t.device_photo_url || "",
      devicePhotoCaption: t.device_photo_caption || "",
      researchers: (t.researchers || []).slice()
        .sort(function (a, b) { return a.position - b.position; })
        .map(function (r) { return { name: r.name, photo: r.photo_url || "" }; })
    };
  }

  // ---- filter controls -------------------------------------------------------
  function populateYearFilter() {
    const years = Array.from(new Set(THESIS_DATA.map(function (t) { return t.schoolYear; })))
      .sort()
      .reverse();
    years.forEach(function (y) {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = "S.Y. " + y;
      yearSelect.appendChild(opt);
    });
  }

  function populateTagFilters() {
    const tags = Array.from(new Set(THESIS_DATA.flatMap(function (t) { return t.tags; }))).sort();
    tags.forEach(function (tag) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tag-chip";
      btn.textContent = tag;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", function () {
        if (activeTags.has(tag)) {
          activeTags.delete(tag);
          btn.setAttribute("aria-pressed", "false");
        } else {
          activeTags.add(tag);
          btn.setAttribute("aria-pressed", "true");
        }
        render();
      });
      tagFiltersEl.appendChild(btn);
    });
  }

  // ---- filtering -------------------------------------------------------
  function getFilteredEntries() {
    return THESIS_DATA.slice().sort(function (a, b) { return b.yearSort - a.yearSort; }).filter(function (t) {
      if (currentYear !== "all" && t.schoolYear !== currentYear) return false;

      if (activeTags.size > 0) {
        const hasAllTags = Array.from(activeTags).every(function (tag) {
          return t.tags.indexOf(tag) !== -1;
        });
        if (!hasAllTags) return false;
      }

      if (currentQuery) {
        const haystack = (
          t.title + " " +
          t.abstract + " " +
          t.tags.join(" ") + " " +
          t.technologies.join(" ") + " " +
          t.adviser + " " +
          t.conclusion + " " +
          t.researchers.map(function (r) { return r.name; }).join(" ")
        ).toLowerCase();
        if (haystack.indexOf(currentQuery) === -1) return false;
      }

      return true;
    });
  }

  // ---- honeycomb layout -------------------------------------------------------
  //
  // Why this is done in JS rather than pure CSS flex-wrap: see the long
  // comment in style.css above ".honeycomb". Short version — we need to
  // know exactly which items land on which row so we can offset every
  // other row by half a hex-width and keep the pattern gapless as the
  // filtered list shrinks or grows. Flex-wrap alone can't tell us that.
  function buildHoneycombRows(entries, container, noStack) {
    const isStacked = !noStack && window.matchMedia("(max-width: 640px)").matches;
    container.classList.toggle("is-stacked", isStacked);

    if (isStacked) {
      return entries.map(function (entry) { return [entry]; });
    }

    const styles = getComputedStyle(container);
    const hexW = parseFloat(styles.getPropertyValue("--hex-w"));
    const gap = parseFloat(styles.getPropertyValue("--hex-gap"));
    const containerWidth = container.clientWidth || 900;

    // How many normal (non-offset) hexes fit side by side.
    let perRow = Math.max(1, Math.floor((containerWidth + gap) / (hexW + gap)));

    // Offset rows are shifted right by half a tile width, so they can fit
    // at most one fewer cell without overflowing the right edge.
    const perOffsetRow = Math.max(1, perRow - 1);

    const rows = [];
    let i = 0;
    let rowIndex = 0;
    while (i < entries.length) {
      const isOffsetRow = rowIndex % 2 === 1;
      const count = isOffsetRow ? perOffsetRow : perRow;
      rows.push(entries.slice(i, i + count));
      i += count;
      rowIndex++;
    }
    return rows;
  }

  // ---- rendering -------------------------------------------------------
  function render() {
    const entries = getFilteredEntries();

    resultCountEl.textContent = entries.length === 0
      ? "No entries match your search/filters."
      : entries.length + (entries.length === 1 ? " thesis" : " theses") + " found.";

    gridEl.innerHTML = "";

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML =
        '<div class="empty-state__hex" aria-hidden="true"></div>' +
        "<p>Nothing in the archive matches that search yet. Try a broader keyword, " +
        "or clear a filter above.</p>";
      gridEl.appendChild(empty);
      return;
    }

    const rows = buildHoneycombRows(entries, gridEl);

    rows.forEach(function (rowEntries, rowIndex) {
      const rowEl = document.createElement("div");
      rowEl.className = "hex-row" + (rowIndex % 2 === 1 ? " hex-row--offset" : "");

      rowEntries.forEach(function (entry) {
        rowEl.appendChild(buildHexCell(entry));
      });

      gridEl.appendChild(rowEl);
    });
  }

  function buildHexCell(entry) {
    const cell = document.createElement("div");
    cell.className = "hex-cell";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hex-cell__button";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-label", entry.title + ", school year " + entry.schoolYear);

    const yearSpan = document.createElement("span");
    yearSpan.className = "hex-cell__year";
    yearSpan.textContent = "S.Y. " + entry.schoolYear;

    const titleSpan = document.createElement("span");
    titleSpan.className = "hex-cell__title";
    titleSpan.textContent = entry.title;

    const tagSpan = document.createElement("span");
    tagSpan.className = "hex-cell__tag";
    tagSpan.textContent = entry.tags[0] || "";

    btn.appendChild(yearSpan);
    btn.appendChild(titleSpan);
    if (entry.tags[0]) btn.appendChild(tagSpan);

    btn.addEventListener("click", function () { openModal(entry); });

    cell.appendChild(btn);
    return cell;
  }


  // ---- people view -------------------------------------------------------
  function showView(name) {
    const people = name === "people";
    document.getElementById("people-view").hidden = !people;
    document.getElementById("toolbar").hidden = people;
    resultCountEl.hidden = people;
    document.querySelector("main.grid-section").hidden = people;
    document.getElementById("nav-theses").setAttribute("aria-pressed", String(!people));
    document.getElementById("nav-people").setAttribute("aria-pressed", String(people));
    if (people) renderPeople();
  }

  function collectPeople() {
    const advisers = new Map(), researchers = new Map();
    function add(map, name, photo) {
      name = String(name || "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      const p = map.get(key) || { name: name, photo: "", count: 0 };
      p.count++;
      if (!p.photo && photo) p.photo = photo;
      map.set(key, p);
    }
    THESIS_DATA.forEach(function (t) {
      add(advisers, t.adviser, ADVISER_PHOTOS[String(t.adviser || "").trim().toLowerCase()] || "");
      t.researchers.forEach(function (r) { add(researchers, r.name, r.photo); });
    });
    function sorted(map) {
      return Array.from(map.values()).sort(function (a, b) {
        return b.count - a.count || a.name.localeCompare(b.name);
      });
    }
    return { advisers: sorted(advisers), researchers: sorted(researchers) };
  }

  function renderPeople() {
    const view = document.getElementById("people-view");
    if (view.hidden) return;
    const data = collectPeople();
    fillPeopleGrid(document.getElementById("advisers-grid"), data.advisers);
    fillPeopleGrid(document.getElementById("researchers-grid"), data.researchers);
  }

  function fillPeopleGrid(container, people) {
    container.innerHTML = "";
    if (!people.length) {
      const p = document.createElement("p");
      p.className = "people__note";
      p.textContent = "No one listed yet.";
      container.appendChild(p);
      return;
    }
    buildHoneycombRows(people, container, true).forEach(function (rowPeople, i) {
      const row = document.createElement("div");
      row.className = "hex-row" + (i % 2 === 1 ? " hex-row--offset" : "");
      rowPeople.forEach(function (p) { row.appendChild(buildPersonCell(p)); });
      container.appendChild(row);
    });
  }

  function initials(name) {
    return name.replace(/^(engr|dr|prof|mr|ms|mrs)\.?\s+/i, "").split(/\s+/)
      .filter(Boolean).map(function (n) { return n[0]; }).join("").slice(0, 2).toUpperCase();
  }

  function buildPersonCell(p) {
    const cell = document.createElement("div");
    cell.className = "hex-cell";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hex-cell__button person";
    btn.setAttribute("aria-label", p.name + ", " + p.count + (p.count === 1 ? " thesis" : " theses"));

    const face = document.createElement("span");
    face.className = "person__face";
    const src = safeUrl(p.photo);
    if (src) {
      const img = document.createElement("img");
      img.src = src; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
      face.appendChild(img);
    } else {
      face.classList.add("person__face--initials");
      face.textContent = initials(p.name);
    }
    const cap = document.createElement("span");
    cap.className = "person__name";
    cap.textContent = p.name;
    const n = document.createElement("span");
    n.className = "person__count";
    n.textContent = p.count + (p.count === 1 ? " thesis" : " theses");
    cap.appendChild(n);

    btn.appendChild(face);
    btn.appendChild(cap);
    btn.addEventListener("click", function () {
      searchInput.value = p.name;
      currentQuery = p.name.toLowerCase();
      showView("theses");
      render();
      window.scrollTo({ top: 0 });
    });
    cell.appendChild(btn);
    return cell;
  }

  // ---- modal -------------------------------------------------------
  function openModal(entry) {
    lastFocused = document.activeElement;
    modalContent.innerHTML = buildModalHTML(entry);
    modalOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    const closeBtn = document.getElementById("modal-close-inner");
    if (closeBtn) closeBtn.focus();
  }

  function closeModal() {
    if (modalOverlay.hidden) return;
    modalOverlay.hidden = true;
    document.body.style.overflow = "";
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
    lastFocused = null;
  }

  // Escapes quotes too, so values are safe inside HTML attributes (alt, src).
  function escapeHTML(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Only https:// URLs or plain relative paths are allowed for images.
  function safeUrl(u) {
    u = String(u || "").trim();
    if (/^https:\/\/[^\s"'<>]+$/i.test(u)) return u;
    if (/^(?!.*:)[\w\-./]+$/.test(u) && u.indexOf("..") === -1) return u;
    return "";
  }

  function buildModalHTML(entry) {
    const devPhoto = safeUrl(entry.devicePhoto);
    const photoHTML = devPhoto
      ? '<img class="modal__photo" src="' + escapeHTML(devPhoto) + '" referrerpolicy="no-referrer" loading="lazy" alt="' +
        escapeHTML(entry.devicePhotoCaption || entry.title) + '">'
      : '<div class="modal__photo-placeholder">No prototype photo on file yet for this entry.</div>';

    const captionHTML = entry.devicePhotoCaption
      ? '<p class="modal__photo-caption">' + escapeHTML(entry.devicePhotoCaption) + "</p>"
      : "";

    const tagsHTML = entry.tags.map(function (t) { return "<span>" + escapeHTML(t) + "</span>"; }).join("");
    const authorsHTML = escapeHTML(entry.researchers.map(function (r) { return r.name; }).join(", "));
    const techHTML = entry.technologies.map(function (t) { return "<li>" + escapeHTML(t) + "</li>"; }).join("");
    const researchersHTML = entry.researchers.map(function (r) {
      const rPhoto = safeUrl(r.photo);
      const photoBit = rPhoto
        ? '<img class="researcher-card__photo" src="' + escapeHTML(rPhoto) + '" referrerpolicy="no-referrer" loading="lazy" alt="' + escapeHTML(r.name) + '">'
        : '<div class="researcher-card__photo researcher-card__photo--placeholder" aria-hidden="true">' +
          escapeHTML(r.name.split(" ").map(function (n) { return n[0]; }).join("").slice(0, 2)) +
          "</div>";
      return '<div class="researcher-card">' + photoBit +
        '<span class="researcher-card__name">' + escapeHTML(r.name) + "</span></div>";
    }).join("");
    const refsHTML = entry.references.map(function (r) { return "<li>" + escapeHTML(r) + "</li>"; }).join("");

    return (
      '<div class="modal__header">' +
        '<button type="button" class="modal__close" id="modal-close-inner" aria-label="Close">✕</button>' +
        '<p class="modal__eyebrow">S.Y. ' + escapeHTML(entry.schoolYear) + " · " + escapeHTML(entry.id) + "</p>" +
        '<h2 class="modal__title" id="modal-title">' + escapeHTML(entry.title) + "</h2>" +
        '<div class="modal__meta">' +
          "<span><strong>Author(s):</strong> " + authorsHTML + "</span>" +
          "<span><strong>Adviser:</strong> " + escapeHTML(entry.adviser) + "</span>" +
        "</div>" +
        '<div class="modal__tags">' + tagsHTML + "</div>" +
      "</div>" +
      '<div class="modal__body">' +
        photoHTML + captionHTML +
        '<div class="modal__section">' +
          "<h3>Abstract</h3><p>" + escapeHTML(entry.abstract) + "</p>" +
        "</div>" +
        '<div class="modal__section">' +
          "<h3>Researchers</h3><div class=\"researcher-list\">" + researchersHTML + "</div>" +
        "</div>" +
        '<div class="modal__section">' +
          "<h3>Technologies & Methodologies</h3><ul class=\"modal__chip-list\">" + techHTML + "</ul>" +
        "</div>" +
        '<div class="modal__section">' +
          "<h3>Conclusion</h3><p>" + escapeHTML(entry.conclusion) + "</p>" +
        "</div>" +
        '<div class="modal__section">' +
          "<h3>Recommendations for Future Researchers</h3><p>" + escapeHTML(entry.recommendations) + "</p>" +
        "</div>" +
        '<div class="modal__section">' +
          "<h3>References</h3><ol class=\"modal__refs\">" + refsHTML + "</ol>" +
        "</div>" +
        '<div class="modal__section">' +
          '<div class="access-box">' +
            "<strong>Want the full manuscript?</strong>" +
            "Full thesis documents are not published openly to protect participant data and " +
            "department records. To request a copy for academic reference, email ACES " +
            "at <a href=\"mailto:hiveaces@gmail.com\">hiveaces@gmail.com</a> " +
            "with the thesis ID (" + escapeHTML(entry.id) + "), your name, and your reason for the request." +
          "</div>" +
        "</div>" +
      "</div>"
    );
  }

  // Re-attach the close handler each time the modal body is rebuilt,
  // since the header (and its close button) is regenerated per entry.
  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "modal-close-inner") closeModal();
  });

  document.addEventListener("DOMContentLoaded", init);
})();

