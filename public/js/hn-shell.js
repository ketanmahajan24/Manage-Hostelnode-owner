/* ============================================================
   public/js/hn-shell.js  —  Phase 1: behaviour for navbar-v2.ejs
   Submenus, active page highlight, property switcher, quick-add and
   profile menus, collapse-to-rail (remembered in localStorage), and
   the mobile drawer. No network calls. Defines no globals.
============================================================ */
(function () {
  "use strict";

  var shell = document.getElementById("hn2Shell");
  if (!shell) return;

  var root = document.documentElement;
  var path = window.location.pathname;

  function isRail() {
    return root.classList.contains("hn2-collapsed") && window.matchMedia("(min-width: 992px)").matches;
  }

  function setCollapsed(on) {
    root.classList.toggle("hn2-collapsed", on);
    try { localStorage.setItem("hn2-collapsed", on ? "1" : "0"); } catch (e) {}
    var btn = shell.querySelector("[data-hn2-collapse]");
    if (btn) {
      btn.setAttribute("aria-label", on ? "Expand sidebar" : "Collapse sidebar");
      btn.setAttribute("title", on ? "Expand sidebar" : "Collapse sidebar");
    }
  }

  var burger = shell.querySelector("[data-hn2-open-drawer]");
  function setDrawer(open) {
    root.classList.toggle("hn2-drawer", open);
    if (burger) burger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function openSub(btn, open) {
    var sub = document.getElementById(btn.getAttribute("data-hn2-sub"));
    if (!sub) return;
    sub.classList.toggle("is-open", open);
    btn.classList.toggle("is-open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /* ── Active page ── */
  shell.querySelectorAll("[data-hn2-match]").forEach(function (el) {
    var re, qre = null;
    try {
      re = new RegExp(el.getAttribute("data-hn2-match"));
      if (el.hasAttribute("data-hn2-query")) qre = new RegExp(el.getAttribute("data-hn2-query"));
    } catch (e) { return; }
    if (!re.test(path)) return;
    if (qre && !qre.test(window.location.search)) return;
    el.classList.add("is-active");
    el.setAttribute("aria-current", "page");
    var sub = el.closest(".hn2-sub");
    if (sub) {
      var parent = shell.querySelector('[data-hn2-sub="' + sub.id + '"]');
      if (parent) {
        parent.classList.add("is-active");
        openSub(parent, true);
      }
    }
  });

  /* ── Sub-menus ── */
  shell.querySelectorAll("[data-hn2-sub]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (isRail()) {           // rail has no room for sub-menus: expand first
        setCollapsed(false);
        openSub(btn, true);
        return;
      }
      openSub(btn, !btn.classList.contains("is-open"));
    });
  });

  /* ── Popovers: switcher, quick add, profile ── */
  var popovers = {
    switcher: document.getElementById("hn2Switcher"),
    quick:    document.getElementById("hn2Quick"),
    profile:  document.getElementById("hn2Profile")
  };

  function closeAll(except) {
    Object.keys(popovers).forEach(function (key) {
      var el = popovers[key];
      if (!el || key === except) return;
      el.classList.remove("is-open");
      var t = el.querySelector("[data-hn2-toggle]");
      if (t) t.setAttribute("aria-expanded", "false");
    });
  }

  shell.querySelectorAll("[data-hn2-toggle]").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var key = btn.getAttribute("data-hn2-toggle");
      var el = popovers[key];
      if (!el) return;
      if (key === "switcher" && isRail()) setCollapsed(false);
      var open = !el.classList.contains("is-open");
      closeAll(key);
      el.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && key === "switcher") {
        var search = el.querySelector("[data-hn2-switch-search]");
        if (search) search.focus();
      }
    });
  });

  document.addEventListener("click", function (e) {
    Object.keys(popovers).forEach(function (key) {
      var el = popovers[key];
      if (el && el.classList.contains("is-open") && !el.contains(e.target)) {
        el.classList.remove("is-open");
        var t = el.querySelector("[data-hn2-toggle]");
        if (t) t.setAttribute("aria-expanded", "false");
      }
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    // Return focus to whichever menu button was open.
    Object.keys(popovers).forEach(function (key) {
      var el = popovers[key];
      if (el && el.classList.contains("is-open")) {
        var t = el.querySelector("[data-hn2-toggle]");
        if (t) t.focus();
      }
    });
    closeAll(null);
    setDrawer(false);
  });

  /* ── Property switcher: come back to the same section after switching.
        Set on load so it also works for new-tab / middle clicks. ── */
  shell.querySelectorAll("[data-hn2-switch-opt]").forEach(function (a) {
    var href = a.getAttribute("href").split("?")[0];
    // Include the query so e.g. a "Convert enquiry" Add Tenant form survives
    // the switch; the server only honours known pages.
    a.setAttribute("href", href + "?next=" + encodeURIComponent(path + window.location.search));
  });

  var search = shell.querySelector("[data-hn2-switch-search]");
  if (search) {
    search.addEventListener("click", function (e) { e.stopPropagation(); });
    search.addEventListener("input", function () {
      var q = search.value.trim().toLowerCase();
      shell.querySelectorAll("[data-hn2-switch-opt]").forEach(function (a) {
        var hay = a.getAttribute("data-hn2-search") || "";
        a.style.display = !q || hay.indexOf(q) !== -1 ? "" : "none";
      });
    });
  }

  /* ── Collapse to rail ── */
  var collapseBtn = shell.querySelector("[data-hn2-collapse]");
  if (collapseBtn) {
    setCollapsed(root.classList.contains("hn2-collapsed")); // sync labels
    collapseBtn.addEventListener("click", function () {
      closeAll(null);
      setCollapsed(!root.classList.contains("hn2-collapsed"));
    });
  }

  /* ── Mobile drawer ── */
  if (burger) burger.addEventListener("click", function (e) {
    e.stopPropagation();
    setDrawer(true);
  });
  var overlay = shell.querySelector("[data-hn2-close-drawer]");
  if (overlay) overlay.addEventListener("click", function () {
    setDrawer(false);
    if (burger) burger.focus();
  });
})();
