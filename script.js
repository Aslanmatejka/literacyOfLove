/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- Mobile Navigation Drawer ---------- */
const hamburger = $('.hamburger');
const navMenu = $('.nav-menu');
let navBackdrop = null;
let scrollY = 0;

function openMenu() {
    if (!hamburger || !navMenu) return;
    scrollY = window.scrollY;
    hamburger.classList.add('active');
    navMenu.classList.add('active');
    document.body.classList.add('menu-open');
    hamburger.setAttribute('aria-expanded', 'true');
    document.body.style.top = `-${scrollY}px`;
    const closeBtn = navMenu.querySelector('.nav-menu__close');
    if (closeBtn) setTimeout(() => closeBtn.focus(), 100);
}

function closeMenu() {
    if (!hamburger || !navMenu) return;
    hamburger.classList.remove('active');
    navMenu.classList.remove('active');
    document.body.classList.remove('menu-open');
    hamburger.setAttribute('aria-expanded', 'false');
    document.body.style.top = '';
    window.scrollTo(0, scrollY);
}

function toggleMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!navMenu) return;
    navMenu.classList.contains('active') ? closeMenu() : openMenu();
}

if (hamburger && navMenu) {
    const navContainer = $('.nav-container');
    const MOBILE_BP = window.matchMedia('(max-width: 900px)');

    navMenu.setAttribute('id', 'primary-menu');
    hamburger.setAttribute('aria-controls', 'primary-menu');

    /* Portal drawer to body on mobile only (escapes navbar blur stacking) */
    function placeNavMenu(isMobile) {
        if (isMobile) {
            if (navMenu.parentElement !== document.body) {
                document.body.appendChild(navMenu);
            }
        } else {
            closeMenu();
            if (navContainer && navMenu.parentElement !== navContainer) {
                if (hamburger && hamburger.parentElement === navContainer) {
                    navContainer.insertBefore(navMenu, hamburger);
                } else {
                    navContainer.appendChild(navMenu);
                }
            }
        }
    }
    placeNavMenu(MOBILE_BP.matches);
    MOBILE_BP.addEventListener('change', (e) => placeNavMenu(e.matches));

    /* Drawer header with close button */
    if (!navMenu.querySelector('.nav-menu__head')) {
        const head = document.createElement('li');
        head.className = 'nav-menu__head';
        head.innerHTML = `
            <span class="nav-menu__brand">Literacy of Love</span>
            <button class="nav-menu__close" type="button" aria-label="Close menu">
                <i class="fas fa-times" aria-hidden="true"></i>
            </button>
        `;
        navMenu.insertBefore(head, navMenu.firstChild);
        head.querySelector('.nav-menu__close').addEventListener('click', (e) => {
            e.preventDefault();
            closeMenu();
        });
    }

    /* Backdrop overlay */
    navBackdrop = document.querySelector('.nav-backdrop');
    if (!navBackdrop) {
        navBackdrop = document.createElement('div');
        navBackdrop.className = 'nav-backdrop';
        navBackdrop.setAttribute('aria-hidden', 'true');
        document.body.appendChild(navBackdrop);
    }
    navBackdrop.addEventListener('click', closeMenu);

    hamburger.addEventListener('click', toggleMenu);
}

/* Close drawer when a nav link is tapped */
document.addEventListener('click', (e) => {
    const link = e.target.closest('.nav-menu .nav-link');
    if (link) closeMenu();
});

/* ---------- Active nav link based on current page ---------- */
(function highlightActiveNav() {
    const path = window.location.pathname.split('/').pop().replace('.html', '') || 'index';
    const pageKey = path === 'index' ? 'home' : path;
    $$('.nav-link').forEach(link => {
        if (link.dataset.page === pageKey) {
            link.classList.add('is-active');
            link.setAttribute('aria-current', 'page');
        }
    });
})();

/* ---------- Navbar scroll effect ---------- */
const navbar = $('.navbar');
window.addEventListener('scroll', () => {
    if (!navbar) return;
    navbar.classList.toggle('scrolled', window.scrollY > 30);
}, { passive: true });
if (navbar) navbar.classList.toggle('scrolled', window.scrollY > 30);

/* ---------- Smooth scrolling for in-page anchors ---------- */
$$('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        if (href === '#' || href.length < 2) return;
        const target = document.querySelector(href);
        if (!target) return;
        e.preventDefault();
        const headerHeight = navbar ? navbar.offsetHeight : 0;
        window.scrollTo({
            top: target.offsetTop - headerHeight - 8,
            behavior: 'smooth'
        });
    });
});

/* ---------- Share button ---------- */
const shareBtn = $('.share-btn');
if (shareBtn) {
    shareBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const shareData = {
            title: 'Literacy of Love — Transforming Lives Through Education',
            text: 'Help us transform lives through education. Every ounce of love causes a ripple of change.',
            url: window.location.href
        };
        if (navigator.share) {
            navigator.share(shareData).catch(() => {});
        } else if (navigator.clipboard) {
            navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`)
                .then(() => showNotification('Link copied to clipboard'))
                .catch(() => showNotification('Could not copy link'));
        } else {
            const ta = document.createElement('textarea');
            ta.value = `${shareData.text} ${shareData.url}`;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); showNotification('Link copied to clipboard'); }
            catch { showNotification('Could not copy link'); }
            document.body.removeChild(ta);
        }
    });
}

/* ---------- Notifications (toast) ---------- */
function showNotification(message, type = 'info') {
    const n = document.createElement('div');
    n.className = `toast toast--${type}`;
    n.setAttribute('role', 'status');
    n.innerHTML = `<i class="fas fa-circle-check" aria-hidden="true"></i><span>${message}</span>`;
    document.body.appendChild(n);
    requestAnimationFrame(() => n.classList.add('toast--show'));
    setTimeout(() => {
        n.classList.remove('toast--show');
        setTimeout(() => n.remove(), 320);
    }, 3200);
}

/* Inject toast styles if not already present (defensive — also defined in CSS) */
(function ensureToastStyles() {
    if (document.getElementById('lol-toast-styles')) return;
    const css = `
        .toast{position:fixed;top:96px;right:20px;display:inline-flex;align-items:center;gap:.6rem;
            background:#0f1b2d;color:#fff;padding:.8rem 1.1rem;border-radius:14px;
            box-shadow:0 12px 32px rgba(15,27,45,.25);font-weight:500;font-size:.95rem;
            transform:translateX(140%);transition:transform .32s cubic-bezier(.2,.7,.2,1);z-index:10000;
            border:1px solid rgba(255,255,255,.08);max-width:calc(100vw - 40px);}
        .toast i{color:#f0c878}
        .toast--show{transform:translateX(0)}`;
    const style = document.createElement('style');
    style.id = 'lol-toast-styles';
    style.textContent = css;
    document.head.appendChild(style);
})();

/* ---------- Reveal on scroll ---------- */
document.addEventListener('DOMContentLoaded', () => {
    const revealTargets = $$(
        '.cta-item, .solution-item, .action-card, .mission-card, .vision-card, ' +
        '.leader-card, .goal-card, .need-item, .method-card, .level-card, ' +
        '.plan-card, .included-item, .step, .impact-card, .category-card, ' +
        '.tour-card, .story-image, .letter-container, .section-title, ' +
        '.section-head, .stat-block, .donate-card, .involvement-card, ' +
        '.partner-card, .stat, .thanks-card'
    );
    revealTargets.forEach(el => el.classList.add('reveal'));

    if (!('IntersectionObserver' in window)) {
        revealTargets.forEach(el => el.classList.add('in-view'));
        return;
    }
    const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('in-view');
                obs.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealTargets.forEach(el => observer.observe(el));
});

/* ---------- Animated counters ---------- */
function animateCounter(el, target, duration = 1600) {
    const start = performance.now();
    function frame(now) {
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = Math.round(target * eased).toString();
        if (t < 1) requestAnimationFrame(frame);
        else el.textContent = String(target);
    }
    requestAnimationFrame(frame);
}

document.addEventListener('DOMContentLoaded', () => {
    const statsStrip = $('.stats-strip');
    const counters = $$('[data-count-to]');
    if (!counters.length) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return; /* HTML already shows final numbers */

    let animated = false;
    function runCounters() {
        if (animated) return;
        animated = true;
        counters.forEach(el => {
            const target = parseInt(el.dataset.countTo, 10);
            if (Number.isNaN(target)) return;
            el.textContent = '0';
            animateCounter(el, target);
        });
    }

    if (!statsStrip || !('IntersectionObserver' in window)) return;

    const obs = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) {
            runCounters();
            obs.disconnect();
        }
    }, { threshold: 0.15, rootMargin: '0px 0px -20px 0px' });

    obs.observe(statsStrip);

    /* Stats visible on load (e.g. short screens) — animate immediately */
    requestAnimationFrame(() => {
        const rect = statsStrip.getBoundingClientRect();
        if (rect.top < window.innerHeight * 0.85) runCounters();
    });
});

/* ---------- Image loaded class (for fade in) ---------- */
document.addEventListener('DOMContentLoaded', () => {
    $$('img').forEach(img => {
        if (img.complete) img.classList.add('loaded');
        else img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    });
});

/* ---------- Accessibility: ESC closes mobile menu ---------- */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
});

/* ---------- FAQ accordion (contact page) ---------- */
$$('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
        const item = btn.parentElement;
        const answer = item.querySelector('.faq-answer');
        const isOpen = item.classList.toggle('open');
        if (answer) answer.style.maxHeight = isOpen ? answer.scrollHeight + 'px' : '0';
        const icon = btn.querySelector('i');
        if (icon) icon.style.transform = isOpen ? 'rotate(180deg)' : '';
    });
});

/* ---------- Sticky mobile donate CTA ---------- */
(function setupMobileCTA() {
    const path = window.location.pathname.split('/').pop().replace('.html', '') || 'index';
    const isDonatePage = path === 'donate';
    if (isDonatePage) {
        document.body.classList.add('is-donate-page');
        return;
    }
    document.body.classList.add('has-mobile-cta');

    const bar = document.createElement('div');
    bar.className = 'mobile-cta';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Quick donate');
    bar.innerHTML = `
        <div class="mobile-cta__inner">
            <div class="mobile-cta__text">
                Support a child today
                <small>100% goes directly to the cause</small>
            </div>
            <a href="donate.html" class="btn btn-primary">
                <i class="fas fa-heart" aria-hidden="true"></i>
                Donate
            </a>
        </div>
    `;
    document.body.appendChild(bar);

    /* Show after the user scrolls past the first viewport */
    const reveal = () => {
        const trigger = Math.max(window.innerHeight * 0.6, 320);
        bar.classList.toggle('is-visible', window.scrollY > trigger);
    };
    window.addEventListener('scroll', reveal, { passive: true });
    reveal();
})();

/* ---------- Page load ---------- */
window.addEventListener('load', () => {
    document.body.classList.add('loaded');
});
