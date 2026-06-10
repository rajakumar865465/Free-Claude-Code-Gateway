/* ============================================================
   Free Claude Code Gateway — main.js
   Vanilla ES2020+, no dependencies
   ============================================================ */

'use strict';

/* ============================================================
   1. THEME SYSTEM
   ============================================================ */

const THEME_KEY = 'theme';
const html = document.documentElement;
const themeToggle = document.getElementById('theme-toggle');

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(theme) {
  html.setAttribute('data-theme', theme);
  if (themeToggle) {
    themeToggle.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
    );
  }
}


function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = saved || getSystemTheme();
  applyTheme(theme);
}

function toggleTheme() {
  const current = html.getAttribute('data-theme') || getSystemTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
}

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  if (!localStorage.getItem(THEME_KEY)) {
    applyTheme(e.matches ? 'light' : 'dark');
  }
});

initTheme();

/* ============================================================
   2. HERO CANVAS — animated neural network
   ============================================================ */

(function initCanvas() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let W, H, nodes, animId;
  const NODE_COUNT = 55;
  const MAX_DIST = 160;

  function resize() {
    W = canvas.width = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }

  function makeNode() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 1.8 + 0.8,
      pulse: Math.random() * Math.PI * 2,
    };
  }

  function init() {
    resize();
    nodes = Array.from({ length: NODE_COUNT }, makeNode);
  }

  function getAccentColor() {
    const theme = html.getAttribute('data-theme') || getSystemTheme();
    return theme === 'light' ? '2,132,199' : '0,212,255';
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const accent = getAccentColor();
    const t = performance.now() / 1000;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      a.x += a.vx;
      a.y += a.vy;
      if (a.x < -20) a.x = W + 20;
      if (a.x > W + 20) a.x = -20;
      if (a.y < -20) a.y = H + 20;
      if (a.y > H + 20) a.y = -20;
      a.pulse += 0.012;

      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAX_DIST) {
          const alpha = (1 - dist / MAX_DIST) * 0.35;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(${accent},${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }

      const pulse = (Math.sin(a.pulse) + 1) / 2;
      const radius = a.r + pulse * 1.2;
      const alpha = 0.4 + pulse * 0.5;

      ctx.beginPath();
      ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${accent},${alpha})`;
      ctx.fill();
    }

    animId = requestAnimationFrame(draw);
  }

  function start() {
    if (animId) cancelAnimationFrame(animId);
    init();
    draw();
  }

  start();

  const ro = new ResizeObserver(() => {
    resize();
  });
  ro.observe(canvas);

  // Pause when hero is not visible to save CPU
  const heroSection = document.getElementById('hero');
  if (heroSection && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        if (!animId) draw();
      } else {
        cancelAnimationFrame(animId);
        animId = null;
      }
    }, { threshold: 0 }).observe(heroSection);
  }
})();

/* ============================================================
   3. SCROLL REVEAL
   ============================================================ */

function initScrollReveal() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );

  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

initScrollReveal();

/* ============================================================
   4. STICKY NAV — IntersectionObserver on #hero
   ============================================================ */

const mainNav = document.querySelector('header');
const heroSection = document.getElementById('hero');

if (mainNav && heroSection) {
  const heroObserver = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) {
        mainNav.classList.add('nav--scrolled');
      } else {
        mainNav.classList.remove('nav--scrolled');
      }
    },
    { threshold: 0, rootMargin: `-${getComputedStyle(html).getPropertyValue('--nav-height').trim() || '64px'} 0px 0px 0px` }
  );
  heroObserver.observe(heroSection);
}

/* ============================================================
   5. SMOOTH SCROLL with nav offset
   ============================================================ */

const NAV_HEIGHT = 64;

document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener('click', (e) => {
    const targetId = anchor.getAttribute('href');
    if (!targetId || targetId === '#') return;
    const target = document.querySelector(targetId);
    if (!target) return;
    e.preventDefault();
    const top = target.getBoundingClientRect().top + window.scrollY - NAV_HEIGHT;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

/* ============================================================
   6. HAMBURGER / MOBILE MENU
   ============================================================ */

const hamburger = document.getElementById('hamburger');
const mobileMenu = document.getElementById('mobile-menu');

function closeMobileMenu() {
  if (!mobileMenu || !hamburger) return;
  mobileMenu.classList.remove('open');
  hamburger.setAttribute('aria-expanded', 'false');
  hamburger.setAttribute('aria-label', 'Open menu');
}

function openMobileMenu() {
  if (!mobileMenu || !hamburger) return;
  mobileMenu.classList.add('open');
  hamburger.setAttribute('aria-expanded', 'true');
  hamburger.setAttribute('aria-label', 'Close menu');
}

if (hamburger && mobileMenu) {
  hamburger.addEventListener('click', () => {
    const isOpen = mobileMenu.classList.contains('open');
    if (isOpen) { closeMobileMenu(); } else { openMobileMenu(); }
  });

  mobileMenu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', closeMobileMenu);
  });

  document.addEventListener('click', (e) => {
    if (
      mobileMenu.classList.contains('open') &&
      !mobileMenu.contains(e.target) &&
      !hamburger.contains(e.target)
    ) {
      closeMobileMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mobileMenu.classList.contains('open')) {
      closeMobileMenu();
      hamburger.focus();
    }
  });
}

/* ============================================================
   7. COPY TO CLIPBOARD
   ============================================================ */

const copyFeedback = document.getElementById('copy-feedback');

function announceToScreenReader(message) {
  if (!copyFeedback) return;
  copyFeedback.textContent = '';
  void copyFeedback.offsetHeight;
  copyFeedback.textContent = message;
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(textarea); }
}

function getCodeFromButton(btn) {
  if (btn.dataset.code) return btn.dataset.code;
  const wrapper = btn.closest('.code-block-wrapper');
  if (wrapper) {
    const codeEl = wrapper.querySelector('pre code');
    if (codeEl) return codeEl.innerText;
    const preEl = wrapper.querySelector('pre');
    if (preEl) return preEl.innerText;
  }
  return '';
}

function initCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = getCodeFromButton(btn);
      if (!text) return;
      try {
        await copyToClipboard(text);
        btn.classList.add('copied');
        const originalTitle = btn.getAttribute('aria-label');
        btn.setAttribute('aria-label', 'Copied!');
        announceToScreenReader('Copied to clipboard');
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.setAttribute('aria-label', originalTitle || 'Copy to clipboard');
        }, 1500);
      } catch {
        btn.setAttribute('aria-label', 'Copy failed');
        setTimeout(() => { btn.setAttribute('aria-label', 'Copy to clipboard'); }, 1500);
      }
    });
  });
}

initCopyButtons();

/* ============================================================
   8. TAB SWITCHING
   ============================================================ */

function initTabs() {
  document.querySelectorAll('.tabs').forEach((tabsContainer) => {
    const buttons = tabsContainer.querySelectorAll('.tab-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetTab = btn.dataset.tab;
        if (!targetTab) return;
        buttons.forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
        const section = tabsContainer.closest('section') || tabsContainer.parentElement;
        const allPanels = section ? section.querySelectorAll('.tab-panel') : [];
        allPanels.forEach((panel) => { panel.classList.add('hidden'); });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        const panel = document.getElementById(`tab-${targetTab}`);
        if (panel) panel.classList.remove('hidden');
      });

      btn.addEventListener('keydown', (e) => {
        const btnArr = Array.from(buttons);
        const idx = btnArr.indexOf(btn);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          btnArr[(idx + 1) % btnArr.length].focus();
          btnArr[(idx + 1) % btnArr.length].click();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          btnArr[(idx - 1 + btnArr.length) % btnArr.length].focus();
          btnArr[(idx - 1 + btnArr.length) % btnArr.length].click();
        }
      });
    });
  });
}

initTabs();

/* ============================================================
   9. GITHUB STARS
   ============================================================ */

async function fetchGitHubStars() {
  const starCountEl = document.getElementById('star-count');
  const heroStarEl = document.getElementById('hero-star-count');
  if (!starCountEl && !heroStarEl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const res = await fetch(
      'https://api.github.com/repos/rajakumar865465/Free-Claude-Code-Gateway',
      { signal: controller.signal, headers: { Accept: 'application/vnd.github.v3+json' } }
    );
    clearTimeout(timeout);
    if (!res.ok) return;
    const data = await res.json();
    const count = data.stargazers_count;
    if (typeof count !== 'number') return;
    const formatted = count >= 1000 ? `★ ${(count / 1000).toFixed(1)}k` : `★ ${count}`;
    if (starCountEl) starCountEl.textContent = formatted;
    if (heroStarEl) heroStarEl.textContent = `${formatted} stars on GitHub`;
  } catch {
    clearTimeout(timeout);
  }
}

fetchGitHubStars();

/* ============================================================
   10. ACTIVE NAV LINK HIGHLIGHTING
   ============================================================ */

function initActiveNavHighlight() {
  const sections = document.querySelectorAll('main section[id]');
  const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');
  if (!sections.length || !navLinks.length) return;

  const linkMap = new Map();
  navLinks.forEach((link) => { linkMap.set(link.getAttribute('href').slice(1), link); });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          navLinks.forEach((l) => l.classList.remove('active'));
          const link = linkMap.get(entry.target.id);
          if (link) link.classList.add('active');
        }
      });
    },
    { rootMargin: `-${NAV_HEIGHT}px 0px -50% 0px`, threshold: 0 }
  );

  sections.forEach((section) => observer.observe(section));
}

initActiveNavHighlight();

