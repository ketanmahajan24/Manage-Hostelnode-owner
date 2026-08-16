/* ============================================================
   HOSTEL-VIEW.JS  —  HostelNode · Hostel Detail Page
============================================================ */

"use strict";

/* ── Globals ── */
let wishlisted = false;

/* ============================================================
   NAVBAR — scroll effect + progress nav reveal
============================================================ */
(function initNav() {
  const nav      = document.getElementById('hnNav');
  const pnav     = document.getElementById('progressNav');
  const gallery  = document.getElementById('gallerySection');

  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY;

    // Navbar shadow on scroll
    if (nav) nav.classList.toggle('scrolled', scrollY > 10);

    // Progress nav appears after gallery
    if (pnav && gallery) {
      const galleryBottom = gallery.getBoundingClientRect().bottom;
      pnav.classList.toggle('visible', galleryBottom < 64);
    }

    // Scroll-spy: highlight active progress nav link
    updateProgressNav();
  }, { passive: true });
})();

function updateProgressNav() {
  const sections = ['overview', 'rooms', 'amenities', 'policies', 'location', 'reviews'];
  const navH     = 64 + 44 + 20;
  let active     = null;

  sections.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.getBoundingClientRect().top <= navH + 10) {
      active = id;
    }
  });

  document.querySelectorAll('.pnav-link').forEach(link => {
    const href = link.getAttribute('href');
    link.classList.toggle('active', href === '#' + active);
  });
}

/* ============================================================
   GALLERY — swap main image
   NOTE: lbIndex is declared in the inline lightbox <script>
   at the bottom of the EJS page (single source of truth).
   This function still updates it so the lightbox opens at
   the right photo if launched right after a thumbnail swap.
============================================================ */
function swapMain(thumbEl, index) {
  const main = document.getElementById('mainImage');
  if (!main || !thumbEl) return;

  // Animate out → swap → animate in
  main.style.opacity    = '0';
  main.style.transform  = 'scale(0.97)';
  main.style.transition = 'opacity 0.18s ease, transform 0.18s ease';

  setTimeout(() => {
    main.src             = thumbEl.querySelector('img').src;
    main.style.opacity   = '1';
    main.style.transform = 'scale(1)';
    if (typeof lbIndex !== 'undefined') lbIndex = index;
  }, 180);
}

/* ============================================================
   LIGHTBOX
   ⚠️ REMOVED — openLightbox(), closeLightbox(), lbNav(), and the
   keyboard-nav listener used to be duplicated here AND in the
   inline <script> at the bottom of the EJS page. Having `let
   lbIndex` declared in two separate <script> tags threw:
     Uncaught SyntaxError: Identifier 'lbIndex' has already been declared
   which silently killed the working inline lightbox script,
   leaving this broken version (missing the "/listing-images/"
   path prefix on lbImg.src) in control — that's why every
   lightbox image 404'd.
   The inline script in the EJS template is now the only place
   these functions live. Do not re-add them here.
============================================================ */

/* ============================================================
   AUTO SLIDER (gallery side thumbs → main)
============================================================ */
(function initAutoSlider() {
  let current = 0;
  setInterval(() => {
    const lb = document.getElementById('lightbox');
    if (lb && lb.classList.contains('open')) return; // pause during lightbox

    const thumbs = document.querySelectorAll('.gallery-thumb:not(.last-thumb) img');
    if (!thumbs.length) return;

    const main = document.getElementById('mainImage');
    if (!main) return;

    current = (current + 1) % (thumbs.length + 1);
    // ✅ FIX: prefix with /listing-images/ — HOSTEL_DATA.images[0] is
    // just a bare filename, not a usable src path on its own.
    const src = current === 0
      ? '/listing-images/' + HOSTEL_DATA.images[0]
      : thumbs[current - 1].src;

    main.style.transition = 'opacity 0.3s ease';
    main.style.opacity    = '0';
    setTimeout(() => { main.src = src; main.style.opacity = '1'; }, 300);
  }, 4000);
})();

/* ============================================================
   READ MORE
============================================================ */
function toggleReadMore() {
  const text = document.getElementById('aboutText');
  const btn  = document.getElementById('readMoreBtn');
  if (!text || !btn) return;

  const expanded = text.classList.toggle('expanded');
  btn.classList.toggle('open', expanded);
  btn.innerHTML = expanded
    ? 'Show less <i class="fa-solid fa-chevron-up"></i>'
    : 'Read more <i class="fa-solid fa-chevron-down"></i>';
}

/* ============================================================
   WISHLIST
============================================================ */
function toggleWishlist() {
  wishlisted = !wishlisted;

  // Sidebar wish btn
  const wishBtn   = document.getElementById('wishBtn');
  const navWish   = document.getElementById('navWishBtn');

  if (wishBtn) {
    wishBtn.classList.toggle('saved', wishlisted);
    wishBtn.querySelector('i').className = wishlisted ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
  }
  if (navWish) {
    navWish.classList.toggle('saved', wishlisted);
    navWish.querySelector('i').className = wishlisted ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
  }

  showToast(wishlisted ? '❤️ Saved to wishlist' : 'Removed from wishlist');
}

/* ============================================================
   SHARE
============================================================ */
function shareHostel() {
  const url = window.location.href;

  if (navigator.share) {
    navigator.share({
      title: HOSTEL_DATA.name,
      text:  'Check out this hostel on HostelNode!',
      url:   url
    }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => {
      showToast('🔗 Link copied to clipboard!');
    }).catch(() => {
      showToast('🔗 Copy this link: ' + url);
    });
  }
}

/* ============================================================
   CONTACT ACTIONS
============================================================ */
function callHostel() {
  const phone = HOSTEL_DATA.phone;
  if (phone) {
    window.location.href = 'tel:' + phone.replace(/\s+/g, '');
  }
}

function whatsappHostel() {
  const phone   = HOSTEL_DATA.whatsapp.replace(/[^0-9]/g, '');
  const message = encodeURIComponent(
    'Hi! I found your hostel "' + HOSTEL_DATA.name + '" on HostelNode. I am interested in a room. Can you please share details?'
  );
  window.open('https://wa.me/' + phone + '?text=' + message, '_blank');
}

/* ============================================================
   BOOKING MODAL
============================================================ */
function openBooking(roomType, price) {
  const modal    = document.getElementById('bookingModal');
  const roomInfo = document.getElementById('modalRoomInfo');

  if (roomInfo) {
    roomInfo.innerHTML =
      '<i class="fa-solid fa-bed" style="color:var(--green)"></i> ' +
      '<strong>' + roomType + '</strong> · ₹' +
      Number(price).toLocaleString('en-IN') + '/month';
  }

  if (modal) {
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
}

function closeBooking() {
  const modal = document.getElementById('bookingModal');
  if (modal) {
    modal.classList.remove('open');
    document.body.style.overflow = '';
  }
}

// Close modal on overlay click
document.getElementById('bookingModal')?.addEventListener('click', function(e) {
  if (e.target === this) closeBooking();
});

function submitBooking(e) {
  e.preventDefault();
  const btn = e.target.querySelector('.modal-submit');
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';
  btn.disabled  = true;

  // Simulate API call — replace with real fetch('/api/inquire', {...})
  setTimeout(() => {
    closeBooking();
    showToast('✅ Inquiry sent! Owner will contact you soon.');
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Inquiry';
    btn.disabled  = false;
    e.target.reset();
  }, 1400);
}

/* ============================================================
   SCROLL TO ROOMS
============================================================ */
function scrollToRooms() {
  const rooms = document.getElementById('rooms');
  if (rooms) {
    const navH = 64 + 44 + 12;
    const top  = rooms.getBoundingClientRect().top + window.scrollY - navH;
    window.scrollTo({ top, behavior: 'smooth' });
  }
}

/* ============================================================
   LOAD MORE REVIEWS
============================================================ */
function loadMoreReviews() {
  const btn = document.querySelector('.btn-all-reviews');
  if (btn) {
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading…';
    setTimeout(() => {
      btn.innerHTML = '<i class="fa-solid fa-comments"></i> View all reviews';
      // In production: fetch more reviews via AJAX and append
      showToast('All reviews loaded!');
    }, 900);
  }
}

/* ============================================================
   SCROLL TO TOP
============================================================ */
(function initScrollTop() {
  const btn = document.querySelector('.scroll-top');
  if (!btn) return;
  window.addEventListener('scroll', () => {
    btn.classList.toggle('show', window.scrollY > 400);
  }, { passive: true });
  btn?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
})();

/* ============================================================
   TOAST NOTIFICATION
============================================================ */
function showToast(message) {
  const toast    = document.getElementById('toastMsg');
  const textEl   = document.getElementById('toastText');
  if (!toast || !textEl) return;

  textEl.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

/* ============================================================
   INTERSECTION OBSERVER — animate-in elements
============================================================ */
(function initObserver() {
  if (!('IntersectionObserver' in window)) {
    // Fallback: show all immediately
    document.querySelectorAll('.animate-in').forEach(el => {
      el.style.opacity   = '1';
      el.style.transform = 'none';
    });
    return;
  }

  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.animationPlayState = 'running';
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.animate-in').forEach(el => {
    el.style.animationPlayState = 'paused';
    obs.observe(el);
  });
})();

/* ============================================================
   KEYBOARD: ESC to close modals
============================================================ */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('bookingModal');
  if (modal?.classList.contains('open')) closeBooking();
});