/* ═══════════════════════════════════════
   SIGNUP NUDGE — 10s activity trigger
   Shows once per session (sessionStorage)
═══════════════════════════════════════ */
(function () {
  // Only run for guests — EJS injects this
  const isLoggedIn = <%= student ? 'true' : 'false' %>;
  if (isLoggedIn) return;

  // Don't show on login/signup pages
  const skipPaths = ['/student/login', '/student/signup', '/owner'];
  if (skipPaths.some(p => window.location.pathname.startsWith(p))) return;

  // Already shown this session? Skip.
  if (sessionStorage.getItem('hn_nudge_shown')) return;

  let activityDetected = false;
  let nudgeTimer = null;

  function startNudgeTimer() {
    if (nudgeTimer) return; // already counting
    nudgeTimer = setTimeout(() => {
      if (activityDetected) openHnNudge();
    }, 10000); // 10 seconds
  }

  // Detect any user activity
  ['mousemove', 'scroll', 'click', 'touchstart', 'keydown'].forEach(evt => {
    window.addEventListener(evt, () => {
      activityDetected = true;
      startNudgeTimer(); // start counting from first activity
    }, { once: true });
  });

})();

function openHnNudge() {
  const overlay = document.getElementById('hnNudgeOverlay');
  if (!overlay) return;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  sessionStorage.setItem('hn_nudge_shown', 'true');
}

function closeHnNudge() {
  const overlay = document.getElementById('hnNudgeOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
}

function hnNudgeOutsideClick(e) {
  if (e.target.id === 'hnNudgeOverlay') closeHnNudge();
}

function hnNudgeSignup() {
  closeHnNudge();

  // Option B — open your existing auth modal inline
  // This reuses the exact same enqOverlay you already have
  enqRoomType  = '';
  enqRoomPrice = 0;
  document.getElementById('enqRoomName').textContent  = 'HostelNode';
  document.getElementById('enqRoomPrice').textContent = '';
  document.getElementById('enqHostelName').textContent = 'Sign up to explore all hostels';
  showEnqStep('auth');
  document.getElementById('enqOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}