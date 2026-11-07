/*
 * DeepSafe - section rule definitions
 * -----------------------------------
 * This file is the single source of truth for WHAT gets removed.
 * It is loaded by both the content script (to apply rules) and the
 * options page (to render the toggle list).
 *
 * HOW THE MODEL WORKS
 * -------------------
 * "Section gating" (Unhook / Antigram style):
 *   A section is a named surface on a site. When enabled, every CSS
 *   selector it lists is hidden with display:none.
 *
 *   Pros: instant, deterministic, no detection needed, no false
 *         positives inside a hidden surface.
 *   Cons: blunt (hides all of a surface, not just the deepfakes in it)
 *         and selectors rot when the site ships a redesign.
 *
 * "risk" field:
 *   'low'  -> hides an ad/promo/recommendation surface. Safe default ON.
 *   'high' -> hides a primary browsing surface (the whole feed).
 *             Default OFF because it can make the site feel broken.
 *
 * "urlPattern":
 *   Optional regex tested against location.href. Lets one site have
 *   path-specific sections (e.g. Instagram /explore only).
 */
globalThis.DEEPSAFE_SECTIONS = {
  youtube: {
    name: "YouTube",
    hostnames: ["youtube.com", "www.youtube.com", "m.youtube.com"],
    sections: [
      {
        id: "feed_ads",
        label: "In-feed and masthead ads",
        desc: "Ad slots injected into the home feed and page header.",
        risk: "low",
        default: true,
        selectors: [
          "ytd-ad-slot-renderer",
          "ytd-in-feed-ad-layout-renderer",
          "ytd-display-ad-renderer",
          "ytd-promoted-sparkles-web-renderer",
          "ytd-promoted-video-renderer",
          "ytd-banner-promo-renderer",
          "#masthead-ad",
          "#player-ads"
        ]
      },
      {
        id: "shorts",
        label: "Shorts shelves",
        desc: "The vertical short-video rows, a major deepfake scam surface.",
        risk: "low",
        default: true,
        selectors: [
          "ytd-reel-shelf-renderer",
          "ytd-rich-shelf-renderer[is-shorts]",
          "ytm-reel-shelf-renderer"
        ]
      },
      {
        id: "sidebar",
        label: "Recommendation sidebar",
        desc: "The 'Up next' column beside the video.",
        risk: "low",
        default: true,
        selectors: ["#secondary #related", "ytd-watch-next-secondary-results-renderer"]
      },
      {
        id: "comments",
        label: "Comments",
        desc: "Comment section and its reply threads.",
        risk: "low",
        default: false,
        selectors: ["#comments", "ytd-comments"]
      },
      {
        id: "home_feed",
        label: "Entire home feed",
        desc: "Removes the whole recommendation grid on the homepage.",
        risk: "high",
        default: false,
        selectors: ["ytd-browse[page-subtype='home'] #contents"]
      }
    ]
  },

  facebook: {
    name: "Facebook",
    hostnames: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    sections: [
      {
        id: "sponsored",
        label: "Sponsored and suggested posts",
        desc: "Paid placements and 'Suggested for you' units in the feed.",
        risk: "low",
        default: true,
        selectors: [
          "div[aria-label='Sponsored']",
          "div[aria-label='Suggested for you']",
          "div[data-pagelet='FeedUnit'][data-ad-preview]"
        ]
      },
      {
        id: "reels",
        label: "Reels",
        desc: "Reels shelves and entry points. Highest deepfake density on Facebook.",
        risk: "low",
        default: true,
        selectors: [
          "div[aria-label='Reels']",
          "div[aria-label='Reels and short videos']",
          "a[href*='/reel/']"
        ]
      },
      {
        id: "stories",
        label: "Stories bar",
        desc: "The story tray at the top of the feed.",
        risk: "low",
        default: false,
        selectors: ["div[aria-label='Stories']", "div[data-pagelet='Stories']"]
      },
      {
        id: "feed",
        label: "Entire news feed",
        desc: "Removes the main feed content area.",
        risk: "high",
        default: false,
        selectors: ["div[role='feed']"]
      }
    ]
  },

  instagram: {
    name: "Instagram",
    hostnames: ["instagram.com", "www.instagram.com"],
    sections: [
      {
        id: "explore",
        label: "Explore page",
        desc: "The discovery grid on /explore.",
        risk: "low",
        default: true,
        urlPattern: "^https://www\\.instagram\\.com/explore/?",
        selectors: ["main[role='main'] article", "main[role='main'] div[style*='grid']"]
      },
      {
        id: "reels_tab",
        label: "Reels viewer",
        desc: "The full-screen Reels surface.",
        risk: "low",
        default: true,
        urlPattern: "^https://www\\.instagram\\.com/reels/?",
        selectors: ["main[role='main']"]
      },
      {
        id: "suggested",
        label: "Suggested posts in feed",
        desc: "'Suggested for you' blocks mixed into the timeline.",
        risk: "low",
        default: true,
        selectors: [
          "div[aria-label='Suggested for you']"
        ]
      },
      {
        id: "stories",
        label: "Stories tray",
        desc: "The story bubbles above the feed.",
        risk: "low",
        default: false,
        selectors: ["div[aria-label='Stories']", "div[role='menu'] div[style*='story']"]
      }
    ]
  },

  tiktok: {
    name: "TikTok",
    hostnames: ["tiktok.com", "www.tiktok.com"],
    sections: [
      {
        id: "ads",
        label: "Paid and promoted videos",
        desc: "Ad cards and sponsored items in the For You feed.",
        risk: "low",
        default: true,
        selectors: [
          "div[data-e2e='ad-card']",
          "div[data-e2e='search-card-ad']",
          "div[class*='DivAdInfoWrapper']"
        ]
      },
      {
        id: "sidebar_suggested",
        label: "Suggested accounts",
        desc: "The 'Suggested accounts' rail on the side.",
        risk: "low",
        default: true,
        selectors: ["div[data-e2e='sidebar-suggested']", "aside div[class*='DivSideBar']"]
      }
    ]
  },

  x: {
    name: "X (Twitter)",
    hostnames: ["x.com", "twitter.com", "www.x.com", "www.twitter.com"],
    sections: [
      {
        id: "promoted",
        label: "Promoted posts",
        desc: "Paid posts and promoted trends.",
        risk: "low",
        default: true,
        selectors: [
          "div[data-testid='placementTracking']",
          "div[data-testid='placementTracking'] article"
        ]
      },
      {
        id: "trends",
        label: "Trends sidebar",
        desc: "The 'What's happening' rail.",
        risk: "low",
        default: true,
        selectors: ["div[aria-label='Timeline: Trending now']", "div[data-testid='sidebarColumn'] section"]
      }
    ]
  }
};
