// The test site's own player: casts the page's episode when you press play while a Cast session
// is connected — and, like many real players, does not continue to the next episode by itself.
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.querySelector('.vjs-big-play-button');
  btn.addEventListener('click', () => {
    const v = document.querySelector('video');
    const F = window.__fake;
    if (F && F.siteSession) F.siteSession.siteLoad(new URL(v.getAttribute('src'), location.href).href, document.title, +v.dataset.duration || 3);
  });
});
