# User-journey evidence — 2026-11-16 (12 journeys, Playwright, this build)

- base: http://127.0.0.1:7896 · plane: mock (合成數據 — no real merchant, no real reader)
- browser: headless Chromium · desktop pointer (fine) · locale zh-HK · timezone Asia/Hong_Kong
- purpose: behave like real (impatient / stray / happy) visitors against the mock build; observations are this run's facts, not production SLAs.

**Summary (machine-readable).**

```json
{
  "generated_at": "2026-11-16T14:08:36.950Z",
  "base_url": "http://127.0.0.1:7896",
  "plane": "mock (合成數據 — no real merchant, no real reader)",
  "journeys": [
    {
      "name": "impatient-close (3s — opens and bails)",
      "duration_ms": 6886,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/"
    },
    {
      "name": "focused-search (opens, searches 拉麵)",
      "duration_ms": 5514,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/search?q=%E6%8B%89%E9%BA%B5"
    },
    {
      "name": "stray-clicker (opens, taps three unrelated links)",
      "duration_ms": 4219,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/handbook"
    },
    {
      "name": "handbook-tour (opens the manual, jumps anchors)",
      "duration_ms": 5113,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/handbook#daily"
    },
    {
      "name": "chapter-reader (opens the mega hub, taps a chapter, goes back)",
      "duration_ms": 4115,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/hong-kong"
    },
    {
      "name": "locale-swapper (zh → en EN label read → toggle back to zh)",
      "duration_ms": 5923,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/"
    },
    {
      "name": "theme-toggle (flips dark, reads a token change, flips back)",
      "duration_ms": 4444,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/"
    },
    {
      "name": "wheel-scroller (scrolls down the page five bursts)",
      "duration_ms": 4108,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/"
    },
    {
      "name": "strip-bridge (hover chapter strip, wheel sideways)",
      "duration_ms": 1872,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/hong-kong"
    },
    {
      "name": "merchant-browser (opens first merchant card, scrolls, returns)",
      "duration_ms": 4490,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "about:blank"
    },
    {
      "name": "never-gets-comfort (cantankerous — types an empty query, hammers the CTA)",
      "duration_ms": 2514,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/"
    },
    {
      "name": "closed-but-curious (opens /world, scrolls to footer, never clicks a chip)",
      "duration_ms": 1878,
      "outcome": "completed",
      "console_errors": 0,
      "end_url": "/world"
    }
  ]
}
```

### 1. impatient-close (3s — opens and bails)
- duration: 6886 ms · outcome: **completed** · end_url: `/`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:


### 2. focused-search (opens, searches 拉麵)
- duration: 5514 ms · outcome: **completed** · end_url: `/search?q=%E6%8B%89%E9%BA%B5`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [4091ms] fill — 拉麵
  - [5474ms] submit — http://127.0.0.1:7896/search?q=%E6%8B%89%E9%BA%B5

### 3. stray-clicker (opens, taps three unrelated links)
- duration: 4219 ms · outcome: **completed** · end_url: `/handbook`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [3866ms] click — /hong-kong
  - [4022ms] click — /hk-type
  - [4186ms] click — /handbook

### 4. handbook-tour (opens the manual, jumps anchors)
- duration: 5113 ms · outcome: **completed** · end_url: `/handbook#daily`
- final scrollY: 3114 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [3304ms] anchor — #faq
  - [3861ms] anchor — #hkseries
  - [4489ms] anchor — #daily

### 5. chapter-reader (opens the mega hub, taps a chapter, goes back)
- duration: 4115 ms · outcome: **completed** · end_url: `/hong-kong`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [2461ms] open-chapter — http://127.0.0.1:7896/guides/hk-mong-kok-ging-fa-shu-mai-chronicle
  - [4028ms] back — http://127.0.0.1:7896/hong-kong

### 6. locale-swapper (zh → en EN label read → toggle back to zh)
- duration: 5923 ms · outcome: **completed** · end_url: `/`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [5066ms] toggle-en — ok
  - [5879ms] end-url — http://127.0.0.1:7896/

### 7. theme-toggle (flips dark, reads a token change, flips back)
- duration: 4444 ms · outcome: **completed** · end_url: `/`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [3742ms] theme-changed — ok

### 8. wheel-scroller (scrolls down the page five bursts)
- duration: 4108 ms · outcome: **completed** · end_url: `/`
- final scrollY: 2000 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:


### 9. strip-bridge (hover chapter strip, wheel sideways)
- duration: 1872 ms · outcome: **completed** · end_url: `/hong-kong`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [1828ms] bridge-expected-growth — true
  - [1828ms] scrollLeft-before — 20
  - [1828ms] scrollLeft-after — 356

### 10. merchant-browser (opens first merchant card, scrolls, returns)
- duration: 4490 ms · outcome: **completed** · end_url: `about:blank`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [4039ms] open-merchant — http://127.0.0.1:7896/

### 11. never-gets-comfort (cantankerous — types an empty query, hammers the CTA)
- duration: 2514 ms · outcome: **completed** · end_url: `/`
- final scrollY: 0 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:
  - [1908ms] empty-submit — http://127.0.0.1:7896/
  - [2435ms] goto-search-via-header — http://127.0.0.1:7896/

### 12. closed-but-curious (opens /world, scrolls to footer, never clicks a chip)
- duration: 1878 ms · outcome: **completed** · end_url: `/world`
- final scrollY: 2520 · h-scrollWidth: 1280 · viewport: 1280px
- console errors: none
- actions:


