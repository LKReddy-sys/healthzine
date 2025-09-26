let loading = false;
let nextCursor = null;
let currentLang = localStorage.getItem('lang') || 'en';

window.loadFeed = function(lang = currentLang) {
  if (loading) return;
  loading = true;
  currentLang = lang;

  let url = `/api/posts?limit=8`;
  if (nextCursor) url += `&cursor=${nextCursor}`;
  if (currentLang) url += `&lang=${currentLang}`;

  fetch(url)
    .then(res => res.json())
    .then(data => {
      data.items.forEach(post => {
        const tmpl = document.getElementById('postTemplate');
        const node = tmpl.content.cloneNode(true);

        const article = node.querySelector('article');
        article.id = `post-${post.id}`;

        const img = node.querySelector('.post-image');
        img.src = post.imageUrl;
        img.alt = post.imageAlt || '';

        // 🔗 wrap image with link if linkUrl exists
        if (post.linkUrl) {
          const link = document.createElement('a');
          link.href = post.linkUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          img.parentNode.insertBefore(link, img);
          link.appendChild(img);
        }

        if (post.headline) {
          node.querySelector('.headline').textContent = post.headline;
        } else {
          node.querySelector('.headline').remove();
        }

        if (post.strap) {
          node.querySelector('.strap').textContent = post.strap;
        } else {
          node.querySelector('.strap').remove();
        }

        // attach share handlers
        node.querySelectorAll('.share-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const type = btn.getAttribute('data-share');
            const url = post.shareUrl;
            if (navigator.share && type === 'copy') {
              navigator.share({ url });
            } else if (type === 'copy') {
              navigator.clipboard.writeText(url);
              alert('Link copied!');
            } else {
              let shareUrl = '';
              if (type === 'x') shareUrl = `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}`;
              if (type === 'facebook') shareUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
              if (type === 'whatsapp') shareUrl = `https://wa.me/?text=${encodeURIComponent(url)}`;
              if (type === 'linkedin') shareUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
              if (type === 'instagram') shareUrl = url;
              if (shareUrl) window.open(shareUrl, '_blank');
            }
          });
        });

        document.getElementById('feed').appendChild(node);
      });

      nextCursor = data.nextCursor;
      loading = false;
    })
    .catch(() => { loading = false; });
};

// Infinite scroll
const sentinel = document.getElementById('sentinel');
if (sentinel) {
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && !loading && nextCursor !== null) {
      window.loadFeed(currentLang);
    }
  });
  observer.observe(sentinel);
}

// initial load + FAB setup
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('feed').innerHTML = '';
  nextCursor = null;
  window.loadFeed(currentLang);

  // ✅ Subscription FAB redirect based on currentLang
  const fab = document.getElementById('fab-subscribe');
  if (fab) {
    fab.addEventListener('click', () => {
      const langUrls = {
        en: 'https://www.happiesthealth.com/subscription',
        hi: 'https://www.happiesthealth.com/hi/magazine-subscription',
        te: 'https://www.happiesthealth.com/te/magazine-subscription',
        ml: 'https://www.happiesthealth.com/ml/magazine-subscription',
        ta: 'https://www.happiesthealth.com/ta/magazine-subscription',
        kn: 'https://www.happiesthealth.com/kn/magazine-subscription',
        bn: 'https://www.happiesthealth.com/bn/magazine-subscription',
        gu: 'https://www.happiesthealth.com/gu/magazine-subscription',
        mr: 'https://www.happiesthealth.com/mr/magazine-subscription',
      };
      const target = langUrls[currentLang] || langUrls['en'];
      window.open(target, '_blank');
    });
  }
});
