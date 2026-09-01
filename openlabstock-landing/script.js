const header = document.querySelector('[data-header]');
const menu = document.querySelector('[data-menu]');
const menuButton = document.querySelector('[data-menu-button]');
const lightbox = document.querySelector('[data-lightbox]');
const lightboxOpen = document.querySelector('[data-lightbox-open]');
const lightboxClose = document.querySelector('[data-lightbox-close]');
const presentationStart = document.querySelector('[data-presentation-start]');
const presentationExit = document.querySelector('[data-presentation-exit]');
const slidePrevious = document.querySelector('[data-slide-prev]');
const slideNext = document.querySelector('[data-slide-next]');
const slideCount = document.querySelector('[data-slide-count]');
const slides = [...document.querySelectorAll('[data-slide]')];
const root = document.documentElement;
let activeSlideIndex = 0;
let wheelLocked = false;

function fullscreenElement() {
  return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
}

function setMenu(open) {
  menu?.classList.toggle('open', open);
  menuButton?.setAttribute('aria-expanded', String(open));
  menuButton?.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
  menuButton?.setAttribute('title', open ? '关闭导航' : '打开导航');
  document.body.classList.toggle('menu-open', open);
}

menuButton?.addEventListener('click', () => {
  setMenu(menuButton.getAttribute('aria-expanded') !== 'true');
});

menu?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => setMenu(false));
});

window.addEventListener('resize', () => {
  if (window.innerWidth > 860) setMenu(false);
  if (window.innerWidth <= 860 && root.classList.contains('presentation-mode')) stopPresentation();
});

function syncHeader() {
  header?.classList.toggle('scrolled', window.scrollY > 16);
}

syncHeader();
window.addEventListener('scroll', syncHeader, { passive: true });

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    });
  },
  { threshold: 0.12 },
);

document.querySelectorAll('.reveal').forEach((element) => revealObserver.observe(element));

lightboxOpen?.addEventListener('click', () => lightbox?.showModal());
lightboxClose?.addEventListener('click', () => lightbox?.close());

lightbox?.addEventListener('click', (event) => {
  if (event.target === lightbox) lightbox.close();
});

function nearestSlideIndex() {
  const viewportCenter = window.innerHeight / 2;
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;

  slides.forEach((slide, index) => {
    const rect = slide.getBoundingClientRect();
    const nextDistance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
    if (nextDistance < distance) {
      nearest = index;
      distance = nextDistance;
    }
  });

  return nearest;
}

function updatePresentationControls(index) {
  activeSlideIndex = Math.max(0, Math.min(index, slides.length - 1));
  const title = slides[activeSlideIndex]?.dataset.slideTitle ?? '';
  if (slideCount) {
    slideCount.textContent = `${String(activeSlideIndex + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')} · ${title}`;
  }
  if (slidePrevious) slidePrevious.disabled = activeSlideIndex === 0;
  if (slideNext) slideNext.disabled = activeSlideIndex === slides.length - 1;
}

function goToSlide(index, behavior = 'smooth') {
  const nextIndex = Math.max(0, Math.min(index, slides.length - 1));
  slides[nextIndex]?.scrollIntoView({ behavior, block: 'start' });
  updatePresentationControls(nextIndex);
}

async function startPresentation() {
  if (window.innerWidth <= 860 || slides.length === 0) return;
  setMenu(false);
  const initialIndex = nearestSlideIndex();
  root.classList.add('presentation-mode');
  updatePresentationControls(initialIndex);

  try {
    const requestFullscreen = root.requestFullscreen ?? root.webkitRequestFullscreen;
    if (typeof requestFullscreen === 'function' && !fullscreenElement()) await requestFullscreen.call(root);
  } catch {
    // Presentation paging still works when a browser blocks fullscreen.
  }

  requestAnimationFrame(() => goToSlide(initialIndex, 'auto'));
}

async function stopPresentation(exitFullscreen = true) {
  const currentIndex = nearestSlideIndex();
  root.classList.remove('presentation-mode');
  if (exitFullscreen && fullscreenElement()) {
    try {
      const exit = document.exitFullscreen ?? document.webkitExitFullscreen;
      if (typeof exit === 'function') await exit.call(document);
    } catch {}
  }
  requestAnimationFrame(() => slides[currentIndex]?.scrollIntoView({ block: 'start' }));
}

presentationStart?.addEventListener('click', startPresentation);
presentationExit?.addEventListener('click', () => stopPresentation());
slidePrevious?.addEventListener('click', () => goToSlide(activeSlideIndex - 1));
slideNext?.addEventListener('click', () => goToSlide(activeSlideIndex + 1));

const slideObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) updatePresentationControls(slides.indexOf(entry.target));
    });
  },
  { threshold: 0.58 },
);

slides.forEach((slide) => slideObserver.observe(slide));
updatePresentationControls(0);

function syncFullscreenExit() {
  if (!fullscreenElement() && root.classList.contains('presentation-mode')) stopPresentation(false);
}

document.addEventListener('fullscreenchange', syncFullscreenExit);
document.addEventListener('webkitfullscreenchange', syncFullscreenExit);

window.addEventListener('keydown', (event) => {
  if (!root.classList.contains('presentation-mode') || lightbox?.open) return;
  const interactiveTarget = event.target instanceof Element && event.target.closest('button, a, input, textarea, select');
  if (interactiveTarget && event.key === ' ') return;

  const nextKeys = ['ArrowDown', 'ArrowRight', 'PageDown', ' '];
  const previousKeys = ['ArrowUp', 'ArrowLeft', 'PageUp'];
  if (nextKeys.includes(event.key)) {
    event.preventDefault();
    goToSlide(activeSlideIndex + 1);
  } else if (previousKeys.includes(event.key)) {
    event.preventDefault();
    goToSlide(activeSlideIndex - 1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    goToSlide(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    goToSlide(slides.length - 1);
  }
});

window.addEventListener('wheel', (event) => {
  if (!root.classList.contains('presentation-mode') || Math.abs(event.deltaY) < 12) return;
  event.preventDefault();
  if (wheelLocked) return;
  wheelLocked = true;
  goToSlide(activeSlideIndex + (event.deltaY > 0 ? 1 : -1));
  window.setTimeout(() => { wheelLocked = false; }, 520);
}, { passive: false });
