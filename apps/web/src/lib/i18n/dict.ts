/**
 * Locale resolution + the copy dictionary.
 *
 * Localisation lives here, not in `@nexus/ui`: the UI package is forbidden from containing
 * literal copy (AGENT_CONTRACT §12), which is why every renderer takes a required `labels`
 * prop. A `Dict` therefore contains functions, so it is never a prop — server and client
 * components both receive a `locale: string` and call `getDict(locale)` on their own side.
 */

import type { StreamStage } from '../types';

export type Locale = 'zh-HK' | 'en';

export const LOCALES: readonly Locale[] = ['zh-HK', 'en'] as const;
export const DEFAULT_LOCALE: Locale = 'zh-HK';
export const LOCALE_COOKIE = 'nexus_locale';

export function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/** The browser sends `zh-HK`, `zh`, `zh-CN`… all CJK variants collapse to the one HK dictionary. */
export function normalizeLocale(value: string | null | undefined): Locale {
  if (!value) return DEFAULT_LOCALE;
  const lowered = value.toLowerCase();
  if (lowered.startsWith('en')) return 'en';
  if (lowered.startsWith('zh')) return 'zh-HK';
  return DEFAULT_LOCALE;
}

export interface RailsCopy {
  title: string;
  description: string;
}

export interface Dict {
  locale: Locale;
  htmlLang: string;
  brand: { name: string; tagline: string };
  nav: {
    search: string;
    guides: string;
    collections: string;
    account: string;
    merchantPortal: string;
    skipToContent: string;
  };
  home: {
    eyebrow: string;
    title: string;
    subtitle: string;
    /** The search field's accessible name — a question, not an example. */
    searchLabel: string;
    searchPlaceholder: string;
    submit: string;
    examplesLabel: string;
    rails: Record<
      'popular_near_you' | 'for_you' | 'trending' | 'recommended' | 'recently_viewed',
      RailsCopy
    >;
    stepsTitle: string;
    steps: Array<{ title: string; text: string }>;
    demoTitle: string;
    demoText: string;
    locationLabel: string;
    locationPrompt: string;
  };
  search: {
    title: (query: string) => string;
    subtitle: (count: number) => string;
    stages: Record<StreamStage, string>;
    found: (count: number) => string;
    groups: Record<'best_match' | 'best_value' | 'closest' | 'most_popular', RailsCopy>;
    followUpLabel: string;
    followUpPlaceholder: string;
    /** One-tap §34 refinements. Each string is also the utterance the cue matcher reads. */
    refineCheaper: string;
    refineCloser: string;
    newSearch: string;
    clearQuery: string;
    compareLabel: string;
    compareClear: string;
    /** Names the card a chip's remove control drops, so the control is addressable per card. */
    compareRemoveItem: (title: string) => string;
    compareTitle: (count: number) => string;
    emptyTitle: string;
    emptyText: string;
    emptyHint: string;
    errorTitle: string;
    errorText: string;
    retry: string;
    degraded: string;
    /** The stream succeeded but `done.degraded` is set: the answer, not the transport, is model-free. */
    answerDegraded: string;
    citations: (count: number) => string;
    meta: (latencyMs: number, provider: string) => string;
    runId: (id: string) => string;
  };
  merchant: {
    notFoundTitle: string;
    notFoundText: string;
    about: string;
    menu: string;
    reviews: string;
    hours: string;
    location: string;
    summaryTitle: string;
    themesLabel: string;
    evidenceLabel: (count: number) => string;
    reviewedBy: string;
    reserve: string;
    directions: string;
    call: string;
    weekday: string;
    today: string;
    openNow: string;
    closedNow: string;
    hoursFact: string;
    mtr: (station: string, minutes: number) => string;
    offeringsEmpty: string;
    reviewsEmpty: string;
    slots: string;
    slotsNote: string;
    verifiedVisit: string;
    verifiedPurchase: string;
    helpful: (count: number) => string;
    degradedTitle: string;
    cuisineLabel: string;
    attributesLabel: string;
  };
  offering: {
    notFoundTitle: string;
    notFoundText: string;
    merchant: string;
    highlights: string;
    back: string;
  };
  /**
   * Provenance copy. `attributes` is keyed by the wire attribute names from API_CONTRACT §2, so a
   * new attribute degrades to its raw key rather than disappearing from the panel.
   */
  facts: {
    title: string;
    note: string;
    empty: string;
    attributes: Record<string, string>;
  };
  /**
   * Programmatic SEO pages (§29/§30). Every number interpolated here is passed in from the
   * payload — the copy describes the data that is on the page, it never asserts anything about
   * the world that the page cannot show a source for.
   */
  seo: {
    /**
     * Display names for the URL grammar of §29 (`/hong-kong/restaurants/date-night`). The wire
     * carries slugs; the words a visitor reads are copy, so they live here — same split as
     * `facts.attributes` above, and the same fallback: an unknown slug renders its slug.
     */
    cities: Record<string, string>;
    categories: Record<string, string>;
    facets: Record<string, string>;
    cityHeading: (city: string) => string;
    cityIntro: (city: string, categories: number) => string;
    categoryHeading: (category: string, city: string) => string;
    categoryIntro: (category: string, city: string, listings: number) => string;
    facetHeading: (facet: string, category: string) => string;
    facetIntro: (facet: string, category: string, city: string, listings: number) => string;
    breadcrumbRoot: string;
    listingsLabel: string;
    openNowLabel: string;
    /** Takes the ceiling from the payload: the caption must be the number the count used (§19). */
    underBudgetLabel: (amount: number) => string;
    priceRangeLabel: string;
    districtsLabel: string;
    priceRange: (min: number, max: number) => string;
    updatedLabel: string;
    browseTitle: string;
    browseIntro: string;
    facetsTitle: string;
    listingsTitle: string;
    thinTitle: string;
    thinText: string;
    noIndexNote: string;
  };
  /** Guides and collections (§8 growth): AI-authored content is always labelled, reviewed or not. */
  growth: {
    guidesTitle: string;
    guidesIntro: string;
    collectionsTitle: string;
    collectionsIntro: string;
    curatedBy: (name: string) => string;
    aiDisclosureTitle: string;
    aiDisclosureText: string;
    reviewed: string;
    unreviewed: string;
    publishedOn: (date: string) => string;
    updatedOn: (date: string) => string;
  };
  /**
   * Operator consoles (§23 merchant workspace, §27 publish gate, §47 data ownership, §68 admin).
   * Appended as its own section: the consumer dictionary above stays untouched so the existing
   * routes cannot drift while the consoles are built.
   */
  console: {
    merchantTitle: string;
    merchantIntro: string;
    listingsTitle: string;
    listingsIntro: string;
    adminTitle: string;
    adminIntro: string;
    backToSite: string;
    demoBanner: string;
    signInRequiredTitle: string;
    signInRequiredText: string;
    businessPickerLabel: string;
    demoIdentityNote: (name: string) => string;
    notWiredTitle: string;
    notWiredText: string;
    sections: {
      overview: string;
      funnel: string;
      funnelNote: string;
      conversations: string;
      listings: string;
      queue: string;
      marketing: string;
    };
    funnel: {
      views: string;
      clicks: string;
      actions: string;
      reservations: string;
      orders: string;
      revenue: string;
      clickThrough: string;
      actionPerClick: string;
      derived: string;
      definition: (text: string) => string;
      zeroNote: string;
      statusLabel: string;
      planLabel: string;
      categoryLabel: string;
    };
    provenance: { source: string; computedAt: string; updated: string };
    freshness: { fresh: string; recent: string; stale: string; unknown: string };
    read: { failed: (source: string, code: string) => string };
    conversations: {
      empty: string;
      subjectFallback: string;
      modeLabel: string;
      statusLabel: string;
      lastActivity: string;
      handoffOpen: string;
      modes: Record<string, string>;
      statuses: Record<string, string>;
    };
    listings: {
      empty: string;
      editCta: string;
      editTitle: string;
      editIntro: string;
      dirtyBanner: string;
      fields: { name: string; tagline: string; description: string; phone: string; price_amount: string };
      hints: { price_amount: string };
      errors: { required: string; too_long: (max: number) => string; invalid: string };
      submit: string;
      reset: string;
      submitting: string;
      demoSubmittedTitle: string;
      demoSubmittedText: (endpoint: string) => string;
      liveSubmittedTitle: string;
      liveSubmitFailed: (code: string) => string;
      gateNote: string;
      signInBlockNote: string;
      rowsTitle: string;
    };
    paid: { title: string; text: string };
    admin: {
      summary: (pending: number, unreviewedAi: number) => string;
      kinds: { guide: string; coupon: string; listing_change: string };
      approve: string;
      reject: string;
      decidedApprove: string;
      decidedReject: string;
      demoDecisionTitle: string;
      demoDecisionText: (endpoint: string) => string;
      liveDecisionFailed: (code: string) => string;
      liveDecisionOk: string;
      submittedOn: (date: string) => string;
      actorLabel: string;
      gateIntro: string;
      emptyQueue: string;
      unreviewedAiNote: string;
    };
    /** §155: the console chrome only ever links to a URL it can answer. */
    nav: {
      merchant: string;
      admin: string;
      overview: string;
      listings: string;
      offerings: string;
      reservations: string;
      conversations: string;
      reviews: string;
      campaigns: string;
      imports: string;
      analytics: string;
      settings: string;
      moderation: string;
      merchants: string;
      users: string;
      orders: string;
      adminReservations: string;
      ai: string;
      search: string;
      system: string;
    };
    common: {
      empty: string;
      notStated: string;
      derived: string;
      readOnly: string;
      demoActionTitle: string;
      demoActionText: (endpoint: string) => string;
      liveActionOk: string;
      actionFailed: (code: string) => string;
      confirm: string;
      cancel: string;
      submit: string;
      submitting: string;
      reason: string;
      window: string;
      sectionUnavailable: string;
    };
    offerings: {
      title: string;
      intro: string;
      empty: string;
      createTitle: string;
      fields: { title: string; kind: string; description: string; price_amount: string; currency: string };
      kinds: Record<string, string>;
      errors: { required: string; too_long: (max: number) => string; invalid: string };
      create: string;
      created: string;
      notWired: string;
      columns: { title: string; kind: string; price: string; status: string; updated: string };
      createFailed: (code: string) => string;
    };
    reservations: {
      title: string;
      intro: string;
      empty: string;
      today: string;
      all: string;
      counts: { total: string; awaiting: string; seated: string; cancelled: string; covers: string };
      columns: { guest: string; party: string; slot: string; status: string; source: string; price: string; notes: string; contact: string };
      advance: string;
      advanceTo: (status: string) => string;
      demoTransition: string;
      notWired: string;
      statuses: Record<string, string>;
    };
    reviews: {
      title: string;
      intro: string;
      empty: string;
      noSummary: string;
      summaryTitle: string;
      themes: string;
      themeMentions: (count: number) => string;
      evidence: (count: number) => string;
      noEvidence: string;
      uncoveredThemes: (count: number) => string;
      distribution: string;
      ratingLabel: string;
      model: string;
      generatedAt: string;
      aiGenerated: string;
      humanReviewed: string;
      humanUnreviewed: string;
      unpublishedNote: string;
    };
    campaigns: {
      title: string;
      intro: string;
      empty: string;
      columns: { name: string; channel: string; status: string; audience: string; created: string };
      body: string;
      evidence: string;
      publish: string;
      publishing: string;
      gateBlocked: string;
      confirmTitle: string;
      confirmText: (name: string) => string;
      published: string;
      publishFailed: (code: string) => string;
      demoPublish: string;
      notWired: string;
      statuses: Record<string, string>;
    };
    imports: {
      title: string;
      intro: string;
      empty: string;
      jobStatus: string;
      source: string;
      documents: string;
      chunks: string;
      created: string;
      updated: string;
      proposalsTitle: string;
      lowConfidence: string;
      withoutEvidence: string;
      confidence: (value: string) => string;
      columns: { name: string; kind: string; price: string; category: string; confidence: string; evidence: string; span: string };
      confirmProposal: string;
      confirmed: string;
      confirmTitle: string;
      confirmText: (name: string) => string;
      demoConfirm: string;
      notWired: string;
      degraded: string;
      stages: Record<string, string>;
      statuses: Record<string, string>;
    };
    analytics: {
      title: string;
      intro: string;
      empty: string;
      window: (from: string, to: string) => string;
      metric: string;
      notProvided: string;
      providedNote: (fields: string) => string;
      definitions: string;
      source: string;
      note: string;
      eventSeries: string;
      ratesTitle: string;
      metrics: Record<string, string>;
      rates: { viewToClick: string; clickToLead: string; leadToReservation: string; leadToOrder: string; repeatShare: string };
    };
    settings: {
      title: string;
      intro: string;
      profileTitle: string;
      hoursTitle: string;
      hoursNote: string;
      verificationTitle: string;
      agentTitle: string;
      agentIntro: string;
      teamTitle: string;
      keysTitle: string;
      knowledgeTitle: string;
      knowledgeIntro: string;
      verification: { verified: string; pending: string; unverified: string; unknown: string; note: string; request: string; demoRequest: string; notWired: string };
      agent: {
        enabled: string;
        greeting: string;
        tone: string;
        threshold: string;
        languages: string;
        outsideHours: string;
        save: string;
        saving: string;
        saved: string;
        notConfigured: string;
        updatedBy: (who: string) => string;
        demoSave: string;
        notWired: string;
        errors: { required: string; too_long: (max: number) => string; invalid: string };
      };
      team: {
        empty: string;
        columns: { name: string; email: string; role: string; permissions: string; status: string; joined: string };
        invite: string;
        notWired: string;
      };
      keys: {
        empty: string;
        columns: { label: string; prefix: string; scopes: string; created: string; lastUsed: string; revoked: string };
        create: string;
        notWired: string;
        onceNote: string;
      };
      knowledge: {
        empty: string;
        columns: { kind: string; title: string; status: string; chunks: string; updated: string };
        indexed: string;
        awaiting: string;
        failed: string;
        documents: string;
        chunksTotal: string;
        reindex: string;
        notWired: string;
        statuses: Record<string, string>;
      };
    };
    adminConsole: {
      overviewTitle: string;
      overviewIntro: string;
      moderationTitle: string;
      moderationIntro: string;
      merchantsTitle: string;
      merchantsIntro: string;
      usersTitle: string;
      usersIntro: string;
      ordersTitle: string;
      ordersIntro: string;
      reservationsTitle: string;
      reservationsIntro: string;
      aiTitle: string;
      aiIntro: string;
      searchTitle: string;
      searchIntro: string;
      systemTitle: string;
      systemIntro: string;
      gate: { roleLabel: string; demoRole: string; forbidden: (role: string) => string; unverified: (code: string) => string; signIn: string };
      counters: {
        users: string;
        merchants: string;
        orders: string;
        reservations: string;
        suspended: string;
        openCases: string;
        resolvable: string;
        degraded: (count: number) => string;
        unavailable: string;
      };
      moderation: {
        caseLabel: string;
        subjectType: string;
        reason: string;
        policy: string;
        autoAction: string;
        created: string;
        resolvedAt: string;
        resolution: string;
        resolutionNote: string;
        subject: string;
        merchant: string;
        merchantStatus: string;
        excerpt: string;
        rating: string;
        language: string;
        subjectMissing: string;
        notResolvable: string;
        decision: string;
        decisions: Record<string, string>;
        displayStatus: { pending: string; approved: string; rejected: string };
        note: string;
        noteHint: string;
        resolve: string;
        resolving: string;
        confirmTitle: string;
        confirmText: (caseId: string) => string;
        resolved: string;
        resolveFailed: (code: string) => string;
        demoResolve: string;
        notWired: string;
        empty: string;
        filter: string;
        filterOpen: string;
        filterResolved: string;
        filterAll: string;
      };
      merchants: {
        empty: string;
        columns: { name: string; slug: string; status: string; category: string; plan: string; rating: string; reviews: string; created: string };
        suspend: string;
        suspendTitle: string;
        suspendIntro: string;
        suspendReason: string;
        suspendReasonHint: string;
        suspending: string;
        suspended: string;
        suspendFailed: (code: string) => string;
        demoSuspend: string;
        suspendNotWired: string;
        alreadySuspended: string;
        effect: string;
        listUnavailable: string;
      };
      users: {
        empty: string;
        columns: { name: string; email: string; locale: string; roles: string; created: string };
        listUnavailable: string;
        detailNote: string;
      };
      orders: {
        empty: string;
        columns: { id: string; status: string; total: string; items: string; merchant: string; created: string };
        listUnavailable: string;
      };
      reservations: {
        empty: string;
        columns: { id: string; status: string; party: string; startsAt: string; merchant: string; created: string };
        listUnavailable: string;
      };
      ai: {
        runsTitle: string;
        runsIntro: string;
        runsEmpty: string;
        degradedRate: (rate: string) => string;
        degradedDefinition: string;
        runColumns: { id: string; agent: string; model: string; status: string; degraded: string; latency: string; tokens: string; cost: string; started: string };
        costsTitle: string;
        costsIntro: string;
        costsEmpty: string;
        groupBy: { agent: string; model: string; day: string };
        costColumns: { key: string; runs: string; tokens: string; cost: string; share: string; latency: string };
        costUnavailable: string;
        noSpend: string;
        askTitle: string;
        askIntro: string;
        askPlaceholder: string;
        ask: string;
        asking: string;
        askAnswer: string;
        askEvidence: string;
        askDegraded: (reason: string) => string;
        askReadOnly: string;
        askFailed: (code: string) => string;
        askNotWired: string;
        askEmpty: string;
        askRefused: string;
      };
      search: {
        window: (days: string) => string;
        totalsTitle: string;
        totals: { searches: string; sessions: string; fulfilled: string; activeDays: string };
        fulfilmentShare: string;
        fulfilmentNote: string;
        dailyTitle: string;
        dailyColumns: { day: string; sessions: string; searches: string; fulfilled: string };
        dailyEmpty: string;
        eventsTitle: string;
        eventColumns: { name: string; events: string; sessions: string };
        eventsEmpty: string;
        noQualityScore: string;
      };
      system: {
        overall: Record<string, string>;
        dependenciesTitle: string;
        columns: { dependency: string; state: string; rawState: string; latency: string; detail: string };
        dependenciesEmpty: string;
        version: string;
        schemaVersion: string;
        profiles: string;
        notProbed: string;
        sourceNote: string;
      };
    };
  };
  states: { loading: string; error: string; empty: string };
  footer: {
    exploreTitle: string;
    demoTitle: string;
    demoText: string;
    methodTitle: string;
    methodText: string;
    trustTitle: string;
    trustText: string;
    rights: string;
  };
}

const zhHK: Dict = {
  locale: 'zh-HK',
  htmlLang: 'zh-HK',
  brand: { name: 'NEXUS', tagline: '用一句話，找到今天想去的地方' },
  nav: {
    search: '智能搜索',
    guides: '指南',
    collections: '精選',
    account: '我的',
    merchantPortal: '商戶中心',
    skipToContent: '跳到主要內容',
  },
  home: {
    eyebrow: '對話式本地發現',
    title: '想說就去。',
    subtitle: '講出你的條件——地區、預算、時間、口味——NEXUS 會理解需求、搜索真實商戶並解釋每個推薦。',
    searchLabel: '你想要什麼？',
    searchPlaceholder: '例如：幫我找沙田適合約會的餐廳，預算 500，安靜一點',
    submit: '開始搜索',
    examplesLabel: '試試這些',
    rails: {
      popular_near_you: { title: '你附近熱門', description: '按距離與口碑排序，僅顯示已有事實的資料' },
      for_you: { title: '為你推薦', description: '未登錄時按附近熱度排序；登錄後才使用你聲明的偏好' },
      trending: { title: '本週熱議', description: '按評價數量而非人為推薦' },
      recommended: { title: '高性價比', description: '以已驗證的均價排序' },
      recently_viewed: { title: '最近瀏覽', description: '來自你的瀏覽記錄' },
    },
    stepsTitle: '一次搜索做了什麼',
    steps: [
      { title: '理解需求', text: '把自然語言拆成類別、地點、預算、時間與偏好；不確定就問，不猜。' },
      { title: '混合搜索', text: '關鍵詞 + 語義向量 + 地理範圍，再按相關性、質量、距離與價格匹配排序。' },
      { title: '解釋與預訂', text: '每個結果標註數據來源與更新時間，你可以直接追問或預訂。' },
    ],
    demoTitle: '當前是示例數據',
    demoText: '站內商戶、商品與評價均為合成數據，用於演示產品流程；不代表任何真實商戶或營業狀況。',
    locationLabel: '位置',
    locationPrompt: '允許定位後可按距離排序；默認以中環為中心。',
  },
  search: {
    title: (query) => `「${query}」的結果`,
    subtitle: (count) => `${count} 個候選`,
    stages: {
      understanding: '理解需求…',
      searching: '搜索附近商戶…',
      comparing: '比較與排序…',
      summarizing: '生成說明…',
      done: '完成',
    },
    found: (count) => `找到 ${count} 個符合條件的選擇`,
    groups: {
      best_match: { title: '最匹配', description: '綜合相關度最高的結果' },
      best_value: { title: '預算內優選', description: '在已驗證價格內符合條件' },
      closest: { title: '最近', description: '按直線距離與步行時間' },
      most_popular: { title: '最熱門', description: '按評價數量與質量分' },
    },
    followUpLabel: '繼續追問',
    followUpPlaceholder: '例如：只看周六晚上 7 點後的',
    refineCheaper: '太貴了',
    refineCloser: '近一點',
    newSearch: '新搜索',
    clearQuery: '清除輸入',
    compareLabel: '加入對比',
    compareClear: '清除對比',
    compareRemoveItem: (title) => `從對比中移除 ${title}`,
    compareTitle: (count) => `對比 ${count} 個結果`,
    emptyTitle: '沒有符合條件的結果',
    emptyText: '放寬一個條件（預算、距離或時間）通常就會有結果。',
    emptyHint: '我們不會用不相關的結果填滿頁面。',
    errorTitle: 'AI 搜索暫不可用',
    errorText: '已改用確定性搜索返回結果；下方會標明降級原因。',
    retry: '重試',
    degraded: '流式搜索失敗，已降級為確定性搜索結果。',
    answerDegraded: '模型暫不可用：這段說明由規則生成，搜索結果本身仍來自實時檢索。',
    citations: (count) => `${count} 條來源事實`,
    meta: (latencyMs, provider) => `${latencyMs} 毫秒 · 模型：${provider}`,
    runId: (id) => `運行編號 ${id}`,
  },
  merchant: {
    notFoundTitle: '找不到該商戶',
    notFoundText: '連結可能過期，或該商戶尚未發佈資料。',
    about: '簡介',
    menu: '菜單與服務',
    reviews: '評價',
    hours: '營業時間',
    location: '位置與交通',
    summaryTitle: '評價摘要',
    themesLabel: '常被提到',
    evidenceLabel: (count) => `依據 ${count} 條評價`,
    reviewedBy: '摘要由模型生成，只引用列出評價中的原句。',
    reserve: '預訂',
    directions: '路線',
    call: '電話',
    weekday: '星期',
    today: '今天',
    openNow: '營業中',
    closedNow: '休息中',
    hoursFact: '營業時間由商戶自報',
    mtr: (station, minutes) => `${station}站步行約 ${minutes} 分鐘`,
    offeringsEmpty: '該商戶暫無已發佈的商品或服務。',
    reviewsEmpty: '暫無評價。',
    slots: '最近可訂時段',
    slotsNote: '位況由商戶數據同步，預訂需登錄後查看。',
    verifiedVisit: '已到店消費',
    verifiedPurchase: '已購買',
    helpful: (count) => `${count} 人覺得有用`,
    degradedTitle: '部分資料暫時無法讀取',
    cuisineLabel: '菜系',
    attributesLabel: '設施與特色',
  },
  offering: {
    notFoundTitle: '找不到該商品或服務',
    notFoundText: '它可能已下架；商戶主頁仍可查看其他項目。',
    merchant: '所屬商戶',
    highlights: '特點',
    back: '返回商戶',
  },
  facts: {
    title: '資料來源',
    note: '頁面上每個數字都指向一條帶來源、更新時間與置信度的事實。',
    empty: '暫無可展示的資料來源。',
    attributes: {
      price: '價格',
      rating: '評分',
      business_hours: '營業時間',
      opening_hours: '營業時間',
      distance: '距離',
      availability: '位況',
      cuisine: '菜系',
      price_band: '價位',
      menu: '菜單',
      review: '評價',
      location: '位置',
      address: '地址',
      phone: '電話',
      image: '圖片',
      category: '類別',
      reservation: '預訂',
      promotion: '優惠',
      capacity: '容納人數',
      atmosphere: '氛圍',
    },
  },
  seo: {
    cities: { 'hong-kong': '香港' },
    categories: {
      restaurants: '餐廳',
      cafes: '咖啡與烘焙',
      fitness: '健身',
      entertainment: '酒吧與娛樂',
      shopping: '購物',
    },
    facets: {
      cantonese: '粵菜',
      japanese: '日式',
      spicy: '辣味',
      vegetarian: '素食',
      dimsum: '點心',
      korean: '韓式',
      'date-night': '約會',
      family: '親子友善',
      quiet: '安靜',
      'sha-tin': '沙田',
      central: '中環',
      'mong-kok': '旺角',
      coffee: '咖啡',
      bakery: '麵包',
      early: '早開',
      gym: '健身室',
      'late-night': '深夜',
      recovery: '恢復',
      'rainy-day': '雨天好去處',
    },
    cityHeading: (city) => `${city}的真實商家與服務`,
    cityIntro: (city, categories) =>
      `以 ${categories} 個類別整理 ${city} 的收錄資料：營業狀態、價格與評分一併標明來源與時間，沒有來源的數字不會出現在這頁。`,
    categoryHeading: (category, city) => `${city}${category}`,
    categoryIntro: (category, city, listings) =>
      `${city}目前有 ${listings} 個${category}收錄。這一頁的統計全部出自這些商家本身：營業狀態、標明來源的價格與評分，以及它們所在的地區。`,
    facetHeading: (facet, category) => `${category}－${facet}`,
    facetIntro: (facet, category, city, listings) =>
      `${city}的${category}之中，有 ${listings} 個符合「${facet}」。這一頁只列有來源可查的商家，不會用無關的結果填滿版面。`,
    breadcrumbRoot: '全部類別',
    listingsLabel: '收錄商家',
    openNowLabel: '目前營業',
    underBudgetLabel: (amount) => `人均不超過 HKD ${amount}`,
    priceRangeLabel: '價格區間',
    districtsLabel: '分佈地區',
    priceRange: (min, max) => `HKD ${min} – ${max}`,
    updatedLabel: '資料更新時間',
    browseTitle: '按類別瀏覽',
    browseIntro: '每個類別旁邊的數字，直接來自該類別目前的收錄量。',
    facetsTitle: '這頁資料的輪廓',
    listingsTitle: '收錄清單',
    thinTitle: '這個組合的收錄還太少',
    thinText: '目前的資料不足以做出比較，所以這頁只提供已有內容，不會補充無關的商家。',
    noIndexNote: '這頁低於收錄品質門檻，已設定為不被搜尋引擎索引。',
  },
  growth: {
    guidesTitle: '城市指南',
    guidesIntro: '由模型起草、以平台收錄的資料編寫的指南；每篇都會標示是否已經過人工核對。',
    collectionsTitle: '精選合集',
    collectionsIntro: '依需求整理的商家組合，卡片上的每個數字都能追溯到來源。',
    curatedBy: (name) => `整理者：${name}`,
    aiDisclosureTitle: '本文由 AI 生成',
    aiDisclosureText: '文字由模型根據平台收錄的資料起草，可能與實況不符；前往前請以商家頁面上標明來源的資料為準。',
    reviewed: '已通過人工審核',
    unreviewed: '尚未經人工審核',
    publishedOn: (date) => `發佈於 ${date}`,
    updatedOn: (date) => `更新於 ${date}`,
  },
  console: {
    merchantTitle: '商戶經營概覽',
    merchantIntro: '流量、轉化與詢盤均來自平台文檔化接口；每個數字標明來源、計算時間與新鮮度，讀取失敗會直接顯示，不會用示例數據補位。',
    listingsTitle: '資料與商品管理',
    listingsIntro: '商戶擁有並控制自己的資料（§47）。這裡的修改在你點擊提交前只存在於本頁面。',
    adminTitle: '人工審核隊列',
    adminIntro: '所有對外發佈的內容（指南、優惠、資料變更）都要經過這裡的人工確認（§27）；模型只能生成草案。',
    backToSite: '返回站點',
    demoBanner: '當前為示例模式（NEXT_PUBLIC_DATA_MODE=mock）：頁面讀取的是合成夾具目錄，全部數字均為演示數據；真實數據需要登錄，而登錄頁尚未上線。',
    signInRequiredTitle: '需要登錄後查看',
    signInRequiredText: '控制台位於身份認證之後（§46/§48）。登錄頁尚未上線，因此實時模式下這裡不展示任何經營數據；本頁保持可渲染，方便評審界面與文案。',
    businessPickerLabel: '示例商戶',
    demoIdentityNote: (name) => `當前查看的是演示身份「${name}」（合成夾具，不代表任何真實商戶）。`,
    notWiredTitle: '尚未接入實時接口',
    notWiredText: '該操作需要平台接口與已認證的會話；兩者都還沒上線，所以這裡不假裝它成功了。',
    sections: {
      overview: '經營概況',
      funnel: '流量漏斗（v_merchant_funnel）',
      funnelNote: '漏斗行由平台按事件流計算；本頁只重述它給出的數字與定義。',
      conversations: '客戶詢盤（AI/人工會話）',
      listings: '我的資料與商品',
      queue: '待審內容',
      marketing: '營銷草案（未發佈）',
    },
    funnel: {
      views: '頁面瀏覽',
      clicks: '點擊',
      actions: '關鍵動作',
      reservations: '有效預訂',
      orders: '有效訂單',
      revenue: '收入',
      clickThrough: '瀏覽→點擊轉化率',
      actionPerClick: '點擊→動作轉化率',
      derived: '由漏斗行推導',
      definition: (text) => `口徑：${text}`,
      zeroNote: '沒有流量/成交是真實狀態（0），不是缺失數據。',
      statusLabel: '發佈狀態',
      planLabel: '套餐',
      categoryLabel: '類別',
    },
    provenance: { source: '來源', computedAt: '計算於', updated: '更新於' },
    freshness: { fresh: '實時', recent: '24 小時內', stale: '可能已過期', unknown: '時間未知' },
    read: { failed: (source, code) => `讀取失敗（${code}）：${source}。該區塊沒有用示例數據回填。` },
    conversations: {
      empty: '還沒有客戶詢盤——這是真實的「暫無」，不是加載失敗。',
      subjectFallback: '（無標題會話）',
      modeLabel: '應答模式',
      statusLabel: '狀態',
      lastActivity: '最近活動',
      handoffOpen: '需要人工介入',
      modes: { ai: 'AI 應答', hybrid: 'AI+人工', human: '人工應答' },
      statuses: { open: '進行中', handoff: '已轉人工', closed: '已結束', archived: '已歸檔' },
    },
    listings: {
      empty: '這個演示商戶還沒有已發佈的商品或服務。',
      editCta: '編輯資料',
      editTitle: '編輯我的資料',
      editIntro: '這些字段就是你的商戶資料（§47）：提交前修改只保留在這個瀏覽器裡；提交後進入人工審核隊列（§27），不會自動上線。',
      dirtyBanner: '你有未提交的修改——在你點擊提交前，它們只屬於你，不會發給任何接口。',
      fields: { name: '商戶名稱', tagline: '一句話簡介', description: '簡介', phone: '電話', price_amount: '人均價格（HKD）' },
      hints: { price_amount: '數字，最多兩位小數；留空表示不展示價格。' },
      errors: { required: '此項不能為空', too_long: (max) => `不能超過 ${max} 個字符`, invalid: '格式不正確' },
      submit: '提交修改',
      reset: '撤銷未提交的修改',
      submitting: '提交中…',
      demoSubmittedTitle: '演示動作：未發送任何請求',
      demoSubmittedText: (endpoint) => `示例模式沒有登錄會話，也沒有可寫的演示庫，因此這次「提交」只停留在頁面上；真實的寫入接口是 ${endpoint}（需商戶令牌與 CSRF，§1）。`,
      liveSubmittedTitle: '已提交，等待人工審核',
      liveSubmitFailed: (code) => `提交失敗（${code}）：平台沒有接受這次修改，下方內容仍是你未提交的原樣。`,
      gateNote: '通過審核後才會生效：發佈永遠需要一個明確的人工動作（§27）。',
      signInBlockNote: '實時模式下需要先登錄才能提交；登錄頁尚未上線。',
      rowsTitle: '當前已發佈的商品/服務',
    },
    paid: {
      title: '付費推廣與自然數據分離',
      text: '廣告位與促銷獨立於上面的漏斗數字排序與統計（§66/§67）；本頁不會把付費曝光合併進自然指標。',
    },
    admin: {
      summary: (pending, unreviewedAi) => `${pending} 項待審，其中 ${unreviewedAi} 項為尚未人工核對的 AI 內容。`,
      kinds: { guide: '指南草案', coupon: '優惠券草案', listing_change: '資料變更' },
      approve: '通過並發佈',
      reject: '駁回',
      decidedApprove: '（本地標記：擬通過）',
      decidedReject: '（本地標記：擬駁回）',
      demoDecisionTitle: '演示決定：未發送到任何實時接口',
      demoDecisionText: (endpoint) => `示例模式下這個按鈕不寫入任何系統；真實流程是 ${endpoint}，且需要平台管理員會話（§9）。`,
      liveDecisionFailed: (code) => `審核動作失敗（${code}），隊列狀態未變。`,
      liveDecisionOk: '決定已提交給平台。',
      submittedOn: (date) => `提交於 ${date}`,
      actorLabel: '提出者',
      gateIntro: '這裡是 §27 發佈門的人工側：AI 生成的內容永遠先停在 draft，只有人的動作能讓它發佈。',
      emptyQueue: '隊列為空——平台目前沒有待審內容。',
      unreviewedAiNote: '該內容仍未經過人工核對；模型可能出錯，請對照證據後再決定。',
    },
    nav: {
      merchant: '商戶中心',
      admin: '管理端',
      overview: '概覽',
      listings: '資料',
      offerings: '商品與服務',
      reservations: '預訂',
      conversations: '客戶會話',
      reviews: '評價',
      campaigns: '營銷',
      imports: '導入',
      analytics: '數據',
      settings: '設置',
      moderation: '審核隊列',
      merchants: '商戶',
      users: '用戶',
      orders: '訂單',
      adminReservations: '預訂',
      ai: 'AI 觀測',
      search: '搜索分析',
      system: '系統健康',
    },
    common: {
      empty: '這裡暫時沒有可顯示的內容。',
      notStated: '未說明',
      derived: '由上方數據推導',
      readOnly: '只讀',
      demoActionTitle: '演示動作：未發送任何請求',
      demoActionText: (endpoint) => `示例模式下這個按鈕不寫入任何系統；真實流程是 ${endpoint}，且需要已認證的會話（§1）。`,
      liveActionOk: '平台已接受這次操作。',
      actionFailed: (code) => `操作失敗（${code}）：平台沒有接受這次請求，下方狀態未改變。`,
      confirm: '確認執行',
      cancel: '取消',
      submit: '提交',
      submitting: '提交中…',
      reason: '理由',
      window: '時間範圍',
      sectionUnavailable: '該區塊的數據源尚未由平台提供，因此這裡不顯示任何數字。',
    },
    offerings: {
      title: '商品與服務',
      intro: '你的商品與服務清單。列表讀取自平台的公開菜單投影（§4），因為 §5 只文檔化了寫入接口；每一項的價格與狀態都以平台返回的為準。',
      empty: '還沒有已發佈的商品或服務。',
      createTitle: '新增一項',
      fields: { title: '名稱', kind: '類型', description: '說明', price_amount: '價格（HKD）', currency: '幣種' },
      kinds: { product: '商品', service: '服務', experience: '體驗' },
      errors: { required: '此項不能為空', too_long: (max) => `不能超過 ${max} 個字符`, invalid: '格式不正確' },
      create: '提交新增',
      created: '平台已接受新增，進入審核流程。',
      notWired: '示例模式下不會寫入；真實寫入接口為 POST /api/v1/merchant/offerings（§5）。',
      columns: { title: '名稱', kind: '類型', price: '價格', status: '狀態', updated: '更新時間' },
      createFailed: (code) => `新增失敗（${code}）。`,
    },
    reservations: {
      title: '預訂',
      intro: '來自平台預訂收件箱的訂位記錄。狀態流轉由平台的狀態機約束（§6）：已取消或未到店的預訂沒有後繼狀態，那是一筆新預訂，不是可以「復原」的舊單。',
      empty: '還沒有預訂記錄——這是真實的「暫無」。',
      today: '今天',
      all: '全部',
      counts: { total: '總筆數', awaiting: '待確認', seated: '已入座', cancelled: '已取消/未到', covers: '需接待人數' },
      columns: { guest: '客人', party: '人數', slot: '時段', status: '狀態', source: '來源', price: '金額', notes: '備註', contact: '聯絡' },
      advance: '推進狀態',
      advanceTo: (status) => `推進為「${status}」`,
      demoTransition: '演示：僅在本頁改變狀態，未寫入平台。',
      notWired: '狀態推進的真實接口是 PATCH /api/v1/reservations/{id}（§6），需要已認證的會話。',
      statuses: { requested: '待確認', pending: '待確認', confirmed: '已確認', seated: '已入座', completed: '已完成', cancelled: '已取消', no_show: '未到店' },
    },
    reviews: {
      title: '評價與評價洞察',
      intro: '摘要與主題由模型根據已發佈評價生成（§54/§55），每個主題都標註它引用了哪些評價；沒有證據的主題會明確標出。',
      empty: '還沒有已發佈的評價。',
      noSummary: '評價代理還沒有為這家商戶生成摘要——這是一個真實狀態，不是讀取失敗。',
      summaryTitle: '評價摘要',
      themes: '常被提到的主題',
      themeMentions: (count) => `${count} 次提及`,
      evidence: (count) => `依據 ${count} 條評價`,
      noEvidence: '該摘要沒有列出任何依據評價，因此不應被當作結論採信。',
      uncoveredThemes: (count) => `${count} 個主題未列出依據`,
      distribution: '評分分佈',
      ratingLabel: '平均評分',
      model: '模型',
      generatedAt: '生成於',
      aiGenerated: '由 AI 生成',
      humanReviewed: '已通過人工核對',
      humanUnreviewed: '尚未經人工核對',
      unpublishedNote: '摘要僅供商戶參考，不代表平台已對外發佈的內容。',
    },
    campaigns: {
      title: '營銷草案',
      intro: 'AI 生成的營銷草案永遠先停在 draft（§27）；只有人按下發佈，它才會對外。發佈是一個明確的、需要確認的動作，不會在頁面加載時觸發。',
      empty: '還沒有營銷草案。',
      columns: { name: '名稱', channel: '渠道', status: '狀態', audience: '受眾', created: '創建時間' },
      body: '內容',
      evidence: '引用事實',
      publish: '批準並發佈',
      publishing: '發佈中…',
      gateBlocked: '這是尚未經人工核對的 AI 內容，按 §27 不能發佈；請先完成人工核對。',
      confirmTitle: '確認發佈這條草案？',
      confirmText: (name) => `你即將發佈「${name}」。發佈後它會對外可見，且無法通過本頁撤回。`,
      published: '平台已接受發佈。',
      publishFailed: (code) => `發佈失敗（${code}），草案狀態未改變。`,
      demoPublish: '演示：僅在本頁標記，未寫入平台。',
      notWired: '發佈的真實接口是 POST /api/v1/merchant/campaigns/{id}/publish（§5/§27）。',
      statuses: { draft: '草案', approved: '已核準', published: '已發佈', rejected: '已駁回', archived: '已歸檔' },
    },
    imports: {
      title: 'AI 導入',
      intro: '從網址或文件抽取的商品提案（§22）。提案只是提案：每一項都需要人工逐條確認後才會成為資料，低信度與無依據的項會被標出。',
      empty: '還沒有導入任務。',
      jobStatus: '任務狀態',
      source: '來源',
      documents: '文檔數',
      chunks: '分塊數',
      created: '創建於',
      updated: '更新於',
      proposalsTitle: '抽取提案',
      lowConfidence: '低信度',
      withoutEvidence: '無依據',
      confidence: (value) => `信度 ${value}`,
      columns: { name: '名稱', kind: '類型', price: '價格', category: '類別', confidence: '信度', evidence: '依據事實', span: '來源片段' },
      confirmProposal: '確認並採納',
      confirmed: '已確認（演示）',
      confirmTitle: '確認採納這條提案？',
      confirmText: (name) => `你將把「${name}」確認為正式資料。確認前它不會出現在任何對外頁面。`,
      demoConfirm: '演示：僅在本頁標記，未寫入平台。',
      notWired: '提案確認的真實接口屬於 §5 的寫入族，尚未在頁面接入。',
      degraded: '該任務報告為降級：部分抽取結果可能不完整。',
      stages: { queued: '排隊', fetching: '抓取', parsing: '解析', embedding: '向量化', proposing: '生成提案' },
      statuses: { queued: '排隊中', running: '處理中', succeeded: '已完成', failed: '失敗', done: '已完成', cancelled: '已取消' },
    },
    analytics: {
      title: '經營數據',
      intro: '按窗口聚合的經營指標。每個數字都標明它是否由平台度量；平台沒有度量的字段顯示「—」，而不是 0（§19/§109）。',
      empty: '這個窗口內沒有事件。',
      window: (from, to) => `${from} 至 ${to}`,
      metric: '主指標',
      notProvided: '平台未度量此字段',
      providedNote: (fields) => `本次讀取實際帶回的字段：${fields}`,
      definitions: '口徑定義',
      source: '數據來源',
      note: '平台說明',
      eventSeries: '平台事件序列（每日）',
      ratesTitle: '推導比率',
      metrics: {
        views: '頁面瀏覽',
        clicks: '點擊',
        actions: '關鍵動作',
        reservations: '預訂',
        orders: '訂單',
        revenue: '收入',
        leads: '線索',
        ai_impressions: 'AI 曝光',
        search_appearances: '搜索出現',
        repeat_customers: '回頭客',
      },
      rates: { viewToClick: '瀏覽→點擊', clickToLead: '點擊→線索', leadToReservation: '線索→預訂', leadToOrder: '線索→訂單', repeatShare: '回頭客佔比' },
    },
    settings: {
      title: '設置',
      intro: '資料、營業時間、認證、AI 代理、團隊成員與 API 密鑰。資料由商戶控制（§47）；認證與密鑰的授予由平台記錄（§48）。',
      profileTitle: '商戶資料',
      hoursTitle: '營業時間',
      hoursNote: '營業時間由商戶自報（§47），不會由平台推斷。',
      verificationTitle: '認證狀態',
      agentTitle: 'AI 代理設置',
      agentIntro: '代理的問候語、語氣與轉人工閾值。低於閾值的回答會轉交人工（§26）。',
      teamTitle: '團隊成員',
      keysTitle: 'API 密鑰',
      knowledgeTitle: '知識庫',
      knowledgeIntro: 'AI 代理可以據以回答的文檔。只有 AI 服務會寫入向量（§52）；平台只標記為待重建，不會在這裡聲稱已完成索引。',
      verification: { verified: '已認證', pending: '審核中', unverified: '未認證', unknown: '狀態未知', note: '本構建中的認證為自述式（§48），商戶自己的狀態列是唯一權威。', request: '提交認證申請', demoRequest: '演示：未發送任何請求。', notWired: '認證接口為 POST /api/v1/businesses/{id}/verification（§5）。' },
      agent: {
        enabled: '啟用代理',
        greeting: '問候語',
        tone: '語氣',
        threshold: '轉人工閾值（0–1）',
        languages: '語言（逗號分隔）',
        outsideHours: '非營業時間回覆',
        save: '保存設置',
        saving: '保存中…',
        saved: '平台已接受設置。',
        notConfigured: '平台尚未提供當前設置的讀取接口，因此這裡不預填任何值。',
        updatedBy: (who) => `最後由 ${who} 更新`,
        demoSave: '演示：僅在本頁保存，未寫入平台。',
        notWired: '設置的寫入接口為 POST /api/v1/merchant/ai-agent/config（§5）。',
        errors: { required: '此項不能為空', too_long: (max) => `不能超過 ${max} 個字符`, invalid: '格式不正確' },
      },
      team: {
        empty: '還沒有團隊成員。',
        columns: { name: '姓名', email: '郵箱', role: '角色', permissions: '權限', status: '狀態', joined: '加入時間' },
        invite: '邀請成員',
        notWired: '邀請成員屬於 §48 的成員管理寫入族，尚未在頁面接入。',
      },
      keys: {
        empty: '還沒有 API 密鑰。',
        columns: { label: '名稱', prefix: '前綴', scopes: '範圍', created: '創建時間', lastUsed: '最近使用', revoked: '已撤銷' },
        create: '新建密鑰',
        notWired: '新建密鑰的真實接口為 POST /api/v1/merchant/api-keys（§5），密鑰只會在創建時完整返回一次。',
        onceNote: '完整密鑰只在創建時返回一次；此列表只會顯示前綴。',
      },
      knowledge: {
        empty: '知識庫還沒有文檔。',
        columns: { kind: '類型', title: '標題', status: '狀態', chunks: '分塊', updated: '更新時間' },
        indexed: '已索引',
        awaiting: '待索引',
        failed: '失敗',
        documents: '文檔數',
        chunksTotal: '分塊總數',
        reindex: '請求重建索引',
        notWired: '重建索引的接口為 POST /api/v1/merchant/knowledge-base/reindex（§5）；它只把文檔標記為待處理，實際的向量化由 AI 服務完成（§52）。',
        statuses: { indexed: '已索引', ready: '已索引', pending: '待索引', processing: '索引中', failed: '失敗', unknown: '狀態未知' },
      },
    },
    adminConsole: {
      overviewTitle: '管理端概覽',
      overviewIntro: '平台運營的入口：各類計數、AI 成本與系統健康的摘要。每個區塊各自讀取、各自降級——一個讀取失敗不會讓整頁變成空白。',
      moderationTitle: '審核隊列',
      moderationIntro: '平台把審核建模為「案件」：狀態為 open/resolved，決定寫在 resolution.decision（§9/§127）。只有 open 且 subject_type=review 的案件可以在本頁處理。',
      merchantsTitle: '商戶',
      merchantsIntro: '平台上的商戶與其狀態。停用是一個需要填寫理由、並且需要二次確認的人工動作（§9）。',
      usersTitle: '用戶',
      usersIntro: '平台用戶。§9 只文檔化了 GET /api/v1/users/{id} 這一條單用戶讀取，沒有列表接口，因此本頁在實時模式下會顯式說明它無法列出用戶。',
      ordersTitle: '訂單',
      ordersIntro: '平台訂單。§9 文檔化了 admin 列表族，但當前平台沒有對應控制器，因此實時模式下本頁顯式降級。',
      reservationsTitle: '預訂（全平台）',
      reservationsIntro: '全平台預訂。與訂單同理：文檔化的 admin 列表接口尚未被平台服務，實時模式下顯式降級。',
      aiTitle: 'AI 觀測',
      aiIntro: '代理運行記錄與成本，按代理/模型/日聚合（§70）。降級率與成本佔比是推導值，頁面上會如此標註。',
      searchTitle: '搜索分析',
      searchIntro: '平台按窗口統計的搜索需求（§9）。這是描述性計數：schema 裡沒有搜索質量分，本頁也不會憑空造一個（§109）。',
      systemTitle: '系統健康',
      systemIntro: '每個依賴各自探測（§9）：數據庫來自一次真實的 select 1，AI 服務只報告「是否配置」而刻意不做探測。',
      gate: {
        roleLabel: '當前角色',
        demoRole: '演示身份（未認證）',
        forbidden: (role) => `當前身份的角色是「${role}」，不是 platform_admin 或 platform_ops（§68），因此不展示任何運營數據。`,
        unverified: (code) => `無法確認你的角色（${code}），因此按最小權限處理：不展示任何運營數據（§105）。`,
        signIn: '管理端位於身份認證之後（§68）。登錄頁尚未上線，因此實時模式下不展示任何數據。',
      },
      counters: {
        users: '用戶',
        merchants: '商戶',
        orders: '訂單',
        reservations: '預訂',
        suspended: '已停用商戶',
        openCases: '待處理案件',
        resolvable: '可處理案件',
        degraded: (count) => `${count} 個讀取失敗——相關區塊顯示的是失敗本身，不是 0。`,
        unavailable: '平台未返回總數',
      },
      moderation: {
        caseLabel: '案件',
        subjectType: '對象類型',
        reason: '原因',
        policy: '策略',
        autoAction: '自動動作',
        created: '創建於',
        resolvedAt: '結案於',
        resolution: '決定',
        resolutionNote: '結案備註',
        subject: '對象內容',
        merchant: '商戶',
        merchantStatus: '商戶狀態',
        excerpt: '摘錄',
        rating: '評分',
        language: '語言',
        subjectMissing: '該案件的對象行已不存在，因此沒有可展示的內容。',
        notResolvable: '此案件當前不可處理（只有 open 且對象為 review 的案件可以）。',
        decision: '決定',
        decisions: { published: '發佈', rejected: '駁回', flagged: '標記' },
        displayStatus: { pending: '待處理', approved: '已通過', rejected: '已駁回' },
        note: '備註',
        noteHint: '最多 500 字；會隨決定一起寫入審計記錄。',
        resolve: '提交決定',
        resolving: '提交中…',
        confirmTitle: '確認提交這個決定？',
        confirmText: (caseId) => `你即將對案件 ${caseId} 寫入一個不可撤回的決定，並留下審計記錄。`,
        resolved: '平台已接受該決定。',
        resolveFailed: (code) => `提交失敗（${code}），案件狀態未改變。`,
        demoResolve: '演示：僅在本頁標記，未寫入平台。',
        notWired: '提交決定的接口是 POST /api/v1/admin/moderation/{case_id}/resolve（§9）。',
        empty: '這個篩選下沒有案件。',
        filter: '篩選',
        filterOpen: '待處理',
        filterResolved: '已結案',
        filterAll: '全部',
      },
      merchants: {
        empty: '沒有商戶。',
        columns: { name: '名稱', slug: '短鏈', status: '狀態', category: '類別', plan: '套餐', rating: '評分', reviews: '評價數', created: '創建時間' },
        suspend: '停用',
        suspendTitle: '停用這個商戶',
        suspendIntro: '停用會立刻對消費者生效：商戶頁面與其下所有商品都會停止對外服務，直到重新發佈。',
        suspendReason: '停用理由',
        suspendReasonHint: '必填。理由會寫入審計記錄，但不會對外顯示。',
        suspending: '停用中…',
        suspended: '平台已停用該商戶。',
        suspendFailed: (code) => `停用失敗（${code}），商戶狀態未改變。`,
        demoSuspend: '演示：僅在本頁標記，未寫入平台。',
        suspendNotWired: '停用的真實接口是 POST /api/v1/admin/merchants/{id}/suspend（§9），需要平台管理員會話。',
        alreadySuspended: '該商戶已經處於停用狀態。',
        effect: '對消費者的影響',
        listUnavailable: '§9 文檔化了 GET /api/v1/admin/merchants，但當前平台沒有對應控制器，因此實時模式下無法列出商戶——這裡顯示的是失敗本身。',
      },
      users: {
        empty: '沒有用戶。',
        columns: { name: '姓名', email: '郵箱', locale: '語言', roles: '角色', created: '創建時間' },
        listUnavailable: '§9 文檔化了 GET /api/v1/admin/users，但當前平台只提供 GET /api/v1/users/{id}（單用戶讀取），沒有列表接口。因此實時模式下無法列出用戶。',
        detailNote: '單用戶支持讀取（GET /api/v1/users/{id}）會返回該用戶的會員關係與活動計數（§3/§68）。',
      },
      orders: {
        empty: '沒有訂單。',
        columns: { id: '編號', status: '狀態', total: '金額', items: '項目數', merchant: '商戶', created: '創建時間' },
        listUnavailable: '§9 文檔化了 GET /api/v1/admin/orders，但當前平台沒有對應控制器，因此實時模式下無法列出訂單。',
      },
      reservations: {
        empty: '沒有預訂。',
        columns: { id: '編號', status: '狀態', party: '人數', startsAt: '開始時間', merchant: '商戶', created: '創建時間' },
        listUnavailable: '§9 文檔化了 GET /api/v1/admin/reservations，但當前平台沒有對應控制器，因此實時模式下無法列出預訂。',
      },
      ai: {
        runsTitle: '代理運行',
        runsIntro: 'agent_runs 的最近記錄：狀態、令牌、成本與是否觸發了降級（§70）。',
        runsEmpty: '沒有運行記錄。',
        degradedRate: (rate) => `降級率 ${rate}`,
        degradedDefinition: '降級 = status 為 fallback/degraded，或 fallback_used 有值（§105）。',
        runColumns: { id: '運行編號', agent: '代理', model: '模型', status: '狀態', degraded: '降級', latency: '延遲', tokens: '令牌', cost: '成本', started: '開始於' },
        costsTitle: '成本聚合',
        costsIntro: '同一批 agent_runs 按代理/模型/日聚合（§9）。佔比由本頁推導，並如此標註。',
        costsEmpty: '沒有成本記錄。',
        groupBy: { agent: '按代理', model: '按模型', day: '按日' },
        costColumns: { key: '分組', runs: '運行數', tokens: '令牌', cost: '成本（USD）', share: '佔比', latency: '平均延遲' },
        costUnavailable: '平台未提供該分組',
        noSpend: 'mock 提供方沒有真實花費，因此成本為空而不是 $0（D4）。',
        askTitle: '問數據（只讀）',
        askIntro: '§126 的分析代理只回答只讀問題：它基於本租戶自身行的聚合 SQL 作答，絕不寫入，也不虛構數字。',
        askPlaceholder: '例如：本租戶有多少已發佈商戶？',
        ask: '提問',
        asking: '查詢中…',
        askAnswer: '回答',
        askEvidence: '依據指標',
        askDegraded: (reason) => `本次回答是降級的（${reason}）：平台服務沒有 LLM 客戶端，因此答案來自確定性 SQL，而不是模型。`,
        askReadOnly: '只讀：該代理沒有任何寫入工具。',
        askFailed: (code) => `提問失敗（${code}）。`,
        askNotWired: '提問的真實接口是 POST /api/v1/admin/ai/ask（§9/§126）。',
        askEmpty: '還沒有提問。',
        askRefused: '平台拒絕了這次提問：它看起來是一條寫入指令，而該代理是只讀的（§126）。',
      },
      search: {
        window: (days) => `窗口：最近 ${days} 天`,
        totalsTitle: '窗口合計',
        totals: { searches: '搜索次數', sessions: '會話數', fulfilled: '已滿足意圖', activeDays: '有數據天數' },
        fulfilmentShare: '意圖滿足率',
        fulfilmentNote: '由「已滿足意圖 ÷ 搜索次數」推導；分母為 0 時顯示「—」。',
        dailyTitle: '每日序列',
        dailyColumns: { day: '日期', sessions: '會話', searches: '搜索', fulfilled: '已滿足' },
        dailyEmpty: '窗口內沒有每日數據。',
        eventsTitle: '事件分佈',
        eventColumns: { name: '事件', events: '次數', sessions: '會話' },
        eventsEmpty: '窗口內沒有事件。',
        noQualityScore: 'schema 中沒有「搜索質量分」這樣的指標；本頁只報告平台度量到的計數，不會從計數推導一個分數（§109）。',
      },
      system: {
        overall: { ok: '正常', degraded: '降級', down: '不可用', unknown: '未知' },
        dependenciesTitle: '依賴項',
        columns: { dependency: '依賴', state: '狀態', rawState: '原始值', latency: '延遲', detail: '詳情' },
        dependenciesEmpty: '平台未列出任何依賴項——「沒有列出」不等於「一切正常」（§155）。',
        version: '服務版本',
        schemaVersion: 'Schema 版本',
        profiles: '激活配置',
        notProbed: 'AI 服務只報告是否已配置，刻意不做探測（§9）。',
        sourceNote: '每個依賴在本次調用中被真實探測；數據庫狀態來自一次真實的 select 1。',
      },
    },
  },
  states: { loading: '加載中…', error: '加載失敗', empty: '暫無內容' },
  footer: {
    exploreTitle: '瀏覽',
    demoTitle: '示例數據聲明',
    demoText: 'Phase 1 使用合成數據集演示流程；所有示例內容均標註「示例數據」，不會以真實商戶或真實客流呈現。',
    methodTitle: '排序方法',
    methodText: '自然結果由相關度、質量、距離與價格匹配決定；付費展示位與自然排序分離，並始終標註「廣告」。',
    trustTitle: '信任與安全',
    trustText: '任何結論都可追溯到來源事實；模型不會直接寫入數據庫，商戶資料修改由商戶決定。',
    rights: '© 2026 NEXUS',
  },
};

const en: Dict = {
  locale: 'en',
  htmlLang: 'en',
  brand: { name: 'NEXUS', tagline: 'Say what you want. Find where to go.' },
  nav: {
    search: 'AI search',
    guides: 'Guides',
    collections: 'Collections',
    account: 'Account',
    merchantPortal: 'Merchant portal',
    skipToContent: 'Skip to content',
  },
  home: {
    eyebrow: 'Conversational local discovery',
    title: 'Just say it.',
    subtitle:
      'Describe the plan — area, budget, time, taste — and NEXUS understands, searches real listings and explains every result.',
    searchLabel: 'What are you looking for?',
    searchPlaceholder: 'e.g. date-friendly restaurants in Sha Tin, budget 500, quiet',
    submit: 'Search',
    examplesLabel: 'Try one of these',
    rails: {
      popular_near_you: { title: 'Popular near you', description: 'Distance and reputation, using verified facts only' },
      for_you: { title: 'For you', description: 'Trending nearby for guests; your declared preferences only after sign-in' },
      trending: { title: 'Trending this week', description: 'Ranked by review volume, not editorial picks' },
      recommended: { title: 'Good value', description: 'Ordered by verified average price' },
      recently_viewed: { title: 'Recently viewed', description: 'From your own browsing history' },
    },
    stepsTitle: 'What one search does',
    steps: [
      { title: 'Understands', text: 'Turns language into category, place, budget, time and preferences — asks instead of guessing.' },
      { title: 'Searches hybrid', text: 'Keywords plus semantic vectors plus geo range, ranked by relevance, quality, distance and price fit.' },
      { title: 'Explains', text: 'Every result carries its source and update time, so you can ask a follow-up or book.' },
    ],
    demoTitle: 'Demo data in use',
    demoText: 'Merchants, offerings and reviews here are synthetic and demonstrate the product flow. They represent no real business or trading state.',
    locationLabel: 'Location',
    locationPrompt: 'Grant location to rank by distance; Central is the default centre.',
  },
  search: {
    title: (query) => `Results for “${query}”`,
    subtitle: (count) => `${count} candidates`,
    stages: {
      understanding: 'Understanding the request…',
      searching: 'Searching nearby merchants…',
      comparing: 'Comparing and ranking…',
      summarizing: 'Writing the explanation…',
      done: 'Done',
    },
    found: (count) => `Found ${count} matching options`,
    groups: {
      best_match: { title: 'Best match', description: 'Highest combined relevance' },
      best_value: { title: 'Best value in budget', description: 'Verified prices within your budget' },
      closest: { title: 'Closest', description: 'By straight-line distance and walking time' },
      most_popular: { title: 'Most popular', description: 'By review volume and Bayesian quality' },
    },
    followUpLabel: 'Keep refining',
    followUpPlaceholder: 'e.g. only Saturday after 7pm',
    refineCheaper: 'Cheaper',
    refineCloser: 'Closer',
    newSearch: 'New search',
    clearQuery: 'Clear',
    compareLabel: 'Compare',
    compareClear: 'Clear comparison',
    compareRemoveItem: (title) => `Remove ${title} from comparison`,
    compareTitle: (count) => `Compare ${count} results`,
    emptyTitle: 'No results match',
    emptyText: 'Relaxing one constraint (budget, distance or time) usually helps.',
    emptyHint: 'We do not pad the page with irrelevant results.',
    errorTitle: 'AI search is unavailable',
    errorText: 'Served deterministic search results instead; the reason is shown below.',
    retry: 'Retry',
    degraded: 'Streaming failed, so results came from the deterministic search path.',
    answerDegraded: 'The model is unavailable: this summary was generated by rules; the results themselves still come from live search.',
    citations: (count) => `${count} source facts`,
    meta: (latencyMs, provider) => `${latencyMs} ms · model: ${provider}`,
    runId: (id) => `run ${id}`,
  },
  merchant: {
    notFoundTitle: 'Merchant not found',
    notFoundText: 'The link may be stale, or the merchant has not published a profile yet.',
    about: 'About',
    menu: 'Menu & services',
    reviews: 'Reviews',
    hours: 'Opening hours',
    location: 'Location & transit',
    summaryTitle: 'Review summary',
    themesLabel: 'Frequently mentioned',
    evidenceLabel: (count) => `Grounded in ${count} reviews`,
    reviewedBy: 'The summary is model-generated and quotes only the listed reviews.',
    reserve: 'Reserve',
    directions: 'Directions',
    call: 'Call',
    weekday: 'Day',
    today: 'Today',
    openNow: 'Open now',
    closedNow: 'Closed now',
    hoursFact: 'Hours are self-reported by the merchant',
    mtr: (station, minutes) => `${station} station, about ${minutes} min on foot`,
    offeringsEmpty: 'This merchant has no published offerings yet.',
    reviewsEmpty: 'No reviews yet.',
    slots: 'Next bookable slots',
    slotsNote: 'Availability syncs from the merchant; booking needs an account.',
    verifiedVisit: 'Visited',
    verifiedPurchase: 'Purchased',
    helpful: (count) => `${count} found this helpful`,
    degradedTitle: 'Some sections could not be loaded',
    cuisineLabel: 'Cuisine',
    attributesLabel: 'Features',
  },
  offering: {
    notFoundTitle: 'Offering not found',
    notFoundText: 'It may have been withdrawn; the merchant page lists the rest.',
    merchant: 'Merchant',
    highlights: 'Highlights',
    back: 'Back to merchant',
  },
  facts: {
    title: 'Data sources',
    note: 'Every number on this page resolves to a fact with a source, an observed time and a confidence.',
    empty: 'No source facts to show yet.',
    attributes: {
      price: 'Price',
      rating: 'Rating',
      business_hours: 'Opening hours',
      opening_hours: 'Opening hours',
      distance: 'Distance',
      availability: 'Availability',
      cuisine: 'Cuisine',
      price_band: 'Price band',
      menu: 'Menu',
      review: 'Review',
      location: 'Location',
      address: 'Address',
      phone: 'Phone',
      image: 'Image',
      category: 'Category',
      reservation: 'Reservation',
      promotion: 'Promotion',
      capacity: 'Capacity',
      atmosphere: 'Atmosphere',
    },
  },
  seo: {
    cities: { 'hong-kong': 'Hong Kong' },
    categories: {
      restaurants: 'Restaurants',
      cafes: 'Cafes & bakeries',
      fitness: 'Fitness',
      entertainment: 'Bars & entertainment',
      shopping: 'Shopping',
    },
    facets: {
      cantonese: 'Cantonese',
      japanese: 'Japanese',
      spicy: 'Spicy',
      vegetarian: 'Vegetarian',
      dimsum: 'Dim sum',
      korean: 'Korean',
      'date-night': 'Date night',
      family: 'Family friendly',
      quiet: 'Quiet',
      'sha-tin': 'Sha Tin',
      central: 'Central',
      'mong-kok': 'Mong Kok',
      coffee: 'Coffee',
      bakery: 'Bakery',
      early: 'Open early',
      gym: 'Gyms',
      'late-night': 'Late night',
      recovery: 'Recovery',
      'rainy-day': 'Rainy day',
    },
    cityHeading: (city) => `${city}, from real listings`,
    cityIntro: (city, categories) =>
      `${categories} categories of ${city} businesses, assembled from the same data the AI uses: opening status, price and rating each carry a source and a timestamp, and a number with no source never reaches this page.`,
    categoryHeading: (category, city) => `${category} in ${city}`,
    categoryIntro: (category, city, listings) =>
      `${listings} ${category.toLowerCase()} are listed in ${city}. Every figure on this page is counted from those listings: whether they are open now, the prices and ratings that carry a source, and the districts they sit in.`,
    facetHeading: (facet, category) => `${facet} ${category}`,
    facetIntro: (facet, category, city, listings) =>
      `${listings} of the ${category} in ${city} match “${facet}”. This page lists only businesses whose details can be traced to a source, and it does not pad itself with anything else.`,
    breadcrumbRoot: 'All categories',
    listingsLabel: 'Listed',
    openNowLabel: 'Open right now',
    underBudgetLabel: (amount) => `At or under HKD ${amount}`,
    priceRangeLabel: 'Price range',
    districtsLabel: 'Districts',
    priceRange: (min, max) => `HKD ${min} – ${max}`,
    updatedLabel: 'Data updated',
    browseTitle: 'Browse by category',
    browseIntro: 'The count beside each category is how many listings it holds today.',
    facetsTitle: 'What this page covers',
    listingsTitle: 'Listings',
    thinTitle: 'Too few listings for this combination',
    thinText: 'There is not enough data here to compare anything, so this page shows only what exists rather than padding itself with unrelated businesses.',
    noIndexNote: 'This page is below the listing-quality bar, so it is not offered to search engines.',
  },
  growth: {
    guidesTitle: 'City guides',
    guidesIntro: 'Guides written by the model from the platform’s own listings; every one says whether a human has checked it.',
    collectionsTitle: 'Collections',
    collectionsIntro: 'Groups of businesses assembled around a need, with every number on the card traceable to a source.',
    curatedBy: (name) => `Curated by ${name}`,
    aiDisclosureTitle: 'Written by AI',
    aiDisclosureText: 'This text was drafted by a model from the data the platform holds, and it can be out of date. Before you travel, trust the sourced figures on the business page.',
    reviewed: 'Checked by a human',
    unreviewed: 'Not checked by a human',
    publishedOn: (date) => `Published ${date}`,
    updatedOn: (date) => `Updated ${date}`,
  },
  console: {
    merchantTitle: 'Merchant business overview',
    merchantIntro: 'Traffic, conversion and leads come from documented platform reads; every figure shows its source, computation time and freshness, and a failed read is shown as a failure — never backfilled with fixtures.',
    listingsTitle: 'Profile & offerings',
    listingsIntro: 'The merchant owns and controls this data (§47). Edits stay on this page until you submit them.',
    adminTitle: 'Human review queue',
    adminIntro: 'Everything published (guides, coupons, listing changes) passes a human decision here (§27); models only produce drafts.',
    backToSite: 'Back to site',
    demoBanner: 'Demo mode (NEXT_PUBLIC_DATA_MODE=mock): every read below comes from the synthetic fixture catalogue and is demo-badged. Real data requires sign-in, and the sign-in page does not exist yet.',
    signInRequiredTitle: 'Sign-in required',
    signInRequiredText: 'The consoles sit behind identity (§46/§48). There is no login page yet, so live mode shows no business data here; the page stays renderable so the surface can still be reviewed.',
    businessPickerLabel: 'Demo business',
    demoIdentityNote: (name) => `Viewing the demo identity “${name}” (synthetic fixture — not a real merchant).`,
    notWiredTitle: 'Not wired to a live endpoint',
    notWiredText: 'This action needs a platform endpoint and an authenticated session. Neither exists yet, so nothing here pretends it succeeded.',
    sections: {
      overview: 'Business summary',
      funnel: 'Funnel (v_merchant_funnel)',
      funnelNote: 'The funnel row is computed by the platform from the event stream; this page restates its numbers and its definition, nothing more.',
      conversations: 'Customer conversations (AI / human)',
      listings: 'My profile & offerings',
      queue: 'Awaiting review',
      marketing: 'Marketing drafts (unpublished)',
    },
    funnel: {
      views: 'Views',
      clicks: 'Clicks',
      actions: 'Key actions',
      reservations: 'Reservations',
      orders: 'Orders',
      revenue: 'Revenue',
      clickThrough: 'View → click rate',
      actionPerClick: 'Click → action rate',
      derived: 'derived from the funnel row',
      definition: (text) => `Definition: ${text}`,
      zeroNote: 'Zero traffic or zero sales is a real state (0), not missing data.',
      statusLabel: 'Publish status',
      planLabel: 'Plan',
      categoryLabel: 'Category',
    },
    provenance: { source: 'Source', computedAt: 'computed', updated: 'updated' },
    freshness: { fresh: 'live', recent: 'within 24h', stale: 'possibly outdated', unknown: 'timestamp unknown' },
    read: { failed: (source, code) => `Read failed (${code}): ${source}. This section was not backfilled with demo data.` },
    conversations: {
      empty: 'No customer conversations yet — an honest “nothing yet”, not a load failure.',
      subjectFallback: '(untitled conversation)',
      modeLabel: 'Answered by',
      statusLabel: 'Status',
      lastActivity: 'Last activity',
      handoffOpen: 'Needs a human reply',
      modes: { ai: 'AI agent', hybrid: 'AI + human', human: 'Human staff' },
      statuses: { open: 'Open', handoff: 'Handed off', closed: 'Closed', archived: 'Archived' },
    },
    listings: {
      empty: 'This demo merchant has no published offerings yet.',
      editCta: 'Edit profile',
      editTitle: 'Edit my profile',
      editIntro: 'These fields are your merchant data (§47): changes live only in this browser until you submit, and a submitted change enters the human review queue (§27) rather than going live by itself.',
      dirtyBanner: 'You have unsaved changes — until you press submit they belong to you alone and go to no endpoint.',
      fields: { name: 'Business name', tagline: 'One-line tagline', description: 'Description', phone: 'Phone', price_amount: 'Average price (HKD)' },
      hints: { price_amount: 'A number with up to 2 decimals; leave empty to hide the price.' },
      errors: { required: 'Required', too_long: (max) => `At most ${max} characters`, invalid: 'Wrong format' },
      submit: 'Submit changes',
      reset: 'Discard unsaved changes',
      submitting: 'Submitting…',
      demoSubmittedTitle: 'Demo action: no request was sent',
      demoSubmittedText: (endpoint) => `Demo mode has no login session and no writable demo store, so this “submit” stayed on the page; the real write endpoint is ${endpoint} (merchant token + CSRF, §1).`,
      liveSubmittedTitle: 'Submitted — waiting for human review',
      liveSubmitFailed: (code) => `Submit failed (${code}): the platform did not accept the change; the fields below are untouched.`,
      gateNote: 'Nothing takes effect until a person approves it: publishing is always an explicit human action (§27).',
      signInBlockNote: 'In live mode a session is required before submitting; the login page does not exist yet.',
      rowsTitle: 'Currently published offerings',
    },
    paid: {
      title: 'Paid promotion is separate from organic data',
      text: 'Ad slots and campaigns are ranked and counted apart from the funnel above (§66/§67); this page never blends paid impressions into organic metrics.',
    },
    admin: {
      summary: (pending, unreviewedAi) => `${pending} pending, of which ${unreviewedAi} are AI items no human has checked yet.`,
      kinds: { guide: 'Guide draft', coupon: 'Coupon draft', listing_change: 'Listing change' },
      approve: 'Approve & publish',
      reject: 'Reject',
      decidedApprove: '(marked locally: intend to approve)',
      decidedReject: '(marked locally: intend to reject)',
      demoDecisionTitle: 'Demo decision: sent to no live endpoint',
      demoDecisionText: (endpoint) => `In demo mode this button writes nothing anywhere; the real flow is ${endpoint}, and it requires a platform-admin session (§9).`,
      liveDecisionFailed: (code) => `Review action failed (${code}); the queue state is unchanged.`,
      liveDecisionOk: 'Decision submitted to the platform.',
      submittedOn: (date) => `Submitted ${date}`,
      actorLabel: 'Proposed by',
      gateIntro: 'This is the human side of the §27 publish gate: AI-generated content stops at draft, and only a person’s action publishes it.',
      emptyQueue: 'The queue is empty — the platform has nothing awaiting review.',
      unreviewedAiNote: 'Not yet checked by a human; models can be wrong, weigh the evidence before deciding.',
    },
    nav: {
      merchant: 'Merchant',
      admin: 'Admin',
      overview: 'Overview',
      listings: 'Profile',
      offerings: 'Offerings',
      reservations: 'Reservations',
      conversations: 'Conversations',
      reviews: 'Reviews',
      campaigns: 'Campaigns',
      imports: 'Imports',
      analytics: 'Analytics',
      settings: 'Settings',
      moderation: 'Moderation',
      merchants: 'Merchants',
      users: 'Users',
      orders: 'Orders',
      adminReservations: 'Reservations',
      ai: 'AI observability',
      search: 'Search analytics',
      system: 'System health',
    },
    common: {
      empty: 'There is nothing to show here yet.',
      notStated: 'not stated',
      derived: 'derived from the rows above',
      readOnly: 'read-only',
      demoActionTitle: 'Demo action: no request was sent',
      demoActionText: (endpoint) => `In demo mode this button writes nothing anywhere; the real flow is ${endpoint}, and it needs an authenticated session (§1).`,
      liveActionOk: 'The platform accepted the action.',
      actionFailed: (code) => `Action failed (${code}): the platform did not accept it, and the state below is unchanged.`,
      confirm: 'Confirm',
      cancel: 'Cancel',
      submit: 'Submit',
      submitting: 'Submitting…',
      reason: 'Reason',
      window: 'Window',
      sectionUnavailable: 'The platform does not serve this section yet, so no number is shown here.',
    },
    offerings: {
      title: 'Offerings',
      intro: 'Your catalogue. The list is read from the documented public menu projection (§4) because §5 documents the writes only; every price and status is whatever the platform returned.',
      empty: 'No published offerings yet.',
      createTitle: 'Add one',
      fields: { title: 'Name', kind: 'Kind', description: 'Description', price_amount: 'Price (HKD)', currency: 'Currency' },
      kinds: { product: 'Product', service: 'Service', experience: 'Experience' },
      errors: { required: 'Required', too_long: (max) => `At most ${max} characters`, invalid: 'Wrong format' },
      create: 'Submit',
      created: 'The platform accepted the new offering and it enters review.',
      notWired: 'Demo mode writes nothing; the real write endpoint is POST /api/v1/merchant/offerings (§5).',
      columns: { title: 'Name', kind: 'Kind', price: 'Price', status: 'Status', updated: 'Updated' },
      createFailed: (code) => `Create failed (${code}).`,
    },
    reservations: {
      title: 'Reservations',
      intro: 'Bookings from the platform reservation inbox. Transitions are the platform’s own guarded state machine (§6): a cancelled or no-show booking has no outgoing edge — it is a new booking, not a resurrectable one.',
      empty: 'No reservations yet — an honest “nothing yet”.',
      today: 'Today',
      all: 'All',
      counts: { total: 'Total', awaiting: 'Awaiting', seated: 'Seated', cancelled: 'Cancelled / no-show', covers: 'Covers' },
      columns: { guest: 'Guest', party: 'Party', slot: 'Slot', status: 'Status', source: 'Source', price: 'Amount', notes: 'Notes', contact: 'Contact' },
      advance: 'Advance',
      advanceTo: (status) => `Advance to “${status}”`,
      demoTransition: 'Demo: the status changes on this page only; nothing was written.',
      notWired: 'The real transition endpoint is PATCH /api/v1/reservations/{id} (§6) and needs an authenticated session.',
      statuses: { requested: 'Requested', pending: 'Pending', confirmed: 'Confirmed', seated: 'Seated', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' },
    },
    reviews: {
      title: 'Reviews & review intelligence',
      intro: 'The summary and themes are model-generated from published reviews (§54/§55), and each theme lists the reviews it cites; a theme with no evidence is called out rather than smoothed over.',
      empty: 'No published reviews yet.',
      noSummary: 'The review agent has not produced a summary for this merchant — a real state, not a read failure.',
      summaryTitle: 'Review summary',
      themes: 'Frequently mentioned',
      themeMentions: (count) => `${count} mentions`,
      evidence: (count) => `Grounded in ${count} reviews`,
      noEvidence: 'This summary lists no supporting reviews, so it must not be treated as a conclusion.',
      uncoveredThemes: (count) => `${count} theme(s) cite nothing`,
      distribution: 'Rating distribution',
      ratingLabel: 'Average rating',
      model: 'Model',
      generatedAt: 'Generated',
      aiGenerated: 'Written by AI',
      humanReviewed: 'Checked by a human',
      humanUnreviewed: 'Not checked by a human',
      unpublishedNote: 'The summary is for the merchant’s own reference; it is not content the platform has published.',
    },
    campaigns: {
      title: 'Campaign drafts',
      intro: 'AI-generated campaigns stop at draft (§27); only a person pressing publish puts one in front of customers. Publishing is an explicit, confirmed action and never fires on page load.',
      empty: 'No campaign drafts yet.',
      columns: { name: 'Name', channel: 'Channel', status: 'Status', audience: 'Audience', created: 'Created' },
      body: 'Body',
      evidence: 'Evidence facts',
      publish: 'Approve & publish',
      publishing: 'Publishing…',
      gateBlocked: 'This is AI content no human has checked, so §27 does not permit publishing it; complete the human check first.',
      confirmTitle: 'Publish this draft?',
      confirmText: (name) => `You are about to publish “${name}”. It becomes visible to customers and cannot be withdrawn from this page.`,
      published: 'The platform accepted the publish.',
      publishFailed: (code) => `Publish failed (${code}); the draft is unchanged.`,
      demoPublish: 'Demo: marked on this page only; nothing was written.',
      notWired: 'The real publish endpoint is POST /api/v1/merchant/campaigns/{id}/publish (§5/§27).',
      statuses: { draft: 'Draft', approved: 'Approved', published: 'Published', rejected: 'Rejected', archived: 'Archived' },
    },
    imports: {
      title: 'AI imports',
      intro: 'Offerings extracted from a URL or file (§22). A proposal is a proposal: each one needs a human to confirm it before it becomes data, and low-confidence or unsupported items are flagged.',
      empty: 'No import jobs yet.',
      jobStatus: 'Job status',
      source: 'Source',
      documents: 'Documents',
      chunks: 'Chunks',
      created: 'Created',
      updated: 'Updated',
      proposalsTitle: 'Extracted proposals',
      lowConfidence: 'low confidence',
      withoutEvidence: 'no evidence',
      confidence: (value) => `confidence ${value}`,
      columns: { name: 'Name', kind: 'Kind', price: 'Price', category: 'Category', confidence: 'Confidence', evidence: 'Evidence facts', span: 'Source span' },
      confirmProposal: 'Confirm & accept',
      confirmed: 'Confirmed (demo)',
      confirmTitle: 'Accept this proposal?',
      confirmText: (name) => `You are about to accept “${name}” as data. Until you do, it appears on no public page.`,
      demoConfirm: 'Demo: marked on this page only; nothing was written.',
      notWired: 'The real proposal-confirmation endpoint belongs to the §5 write family and is not wired into this page yet.',
      degraded: 'This job reports itself degraded: some extraction results may be incomplete.',
      stages: { queued: 'Queued', fetching: 'Fetching', parsing: 'Parsing', embedding: 'Embedding', proposing: 'Proposing' },
      statuses: { queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', done: 'Done', cancelled: 'Cancelled' },
    },
    analytics: {
      title: 'Analytics',
      intro: 'Metrics aggregated over a window. Every figure says whether the platform measured it; a field the platform did not measure renders “—” rather than 0 (§19/§109).',
      empty: 'No events in this window.',
      window: (from, to) => `${from} to ${to}`,
      metric: 'Primary metric',
      notProvided: 'not measured by the platform',
      providedNote: (fields) => `Fields this read actually carried: ${fields}`,
      definitions: 'Definitions',
      source: 'Source',
      note: 'Platform note',
      eventSeries: 'Platform event series (daily)',
      ratesTitle: 'Derived rates',
      metrics: {
        views: 'Views',
        clicks: 'Clicks',
        actions: 'Key actions',
        reservations: 'Reservations',
        orders: 'Orders',
        revenue: 'Revenue',
        leads: 'Leads',
        ai_impressions: 'AI impressions',
        search_appearances: 'Search appearances',
        repeat_customers: 'Repeat customers',
      },
      rates: { viewToClick: 'View → click', clickToLead: 'Click → lead', leadToReservation: 'Lead → reservation', leadToOrder: 'Lead → order', repeatShare: 'Repeat share' },
    },
    settings: {
      title: 'Settings',
      intro: 'Profile, hours, verification, the AI agent, team members and API keys. The merchant controls their data (§47); verification and key grants are recorded by the platform (§48).',
      profileTitle: 'Merchant profile',
      hoursTitle: 'Opening hours',
      hoursNote: 'Hours are self-reported by the merchant (§47) and are never inferred by the platform.',
      verificationTitle: 'Verification',
      agentTitle: 'AI agent',
      agentIntro: 'The agent’s greeting, tone and handoff threshold. Answers below the threshold are handed to a person (§26).',
      teamTitle: 'Team members',
      keysTitle: 'API keys',
      knowledgeTitle: 'Knowledge base',
      knowledgeIntro: 'The documents the AI agent may answer from. Only the AI service writes embeddings (§52); the platform marks documents pending and never claims here that indexing is done.',
      verification: { verified: 'Verified', pending: 'Pending', unverified: 'Unverified', unknown: 'Unknown', note: 'Verification is self-attested in this build (§48); the merchant’s own status column is the only authority.', request: 'Request verification', demoRequest: 'Demo: no request was sent.', notWired: 'The verification endpoint is POST /api/v1/businesses/{id}/verification (§5).' },
      agent: {
        enabled: 'Agent enabled',
        greeting: 'Greeting',
        tone: 'Tone',
        threshold: 'Handoff threshold (0–1)',
        languages: 'Languages (comma separated)',
        outsideHours: 'Outside-hours message',
        save: 'Save settings',
        saving: 'Saving…',
        saved: 'The platform accepted the settings.',
        notConfigured: 'The platform does not serve a read of the current settings, so nothing is pre-filled here.',
        updatedBy: (who) => `Last updated by ${who}`,
        demoSave: 'Demo: saved on this page only; nothing was written.',
        notWired: 'The settings write endpoint is POST /api/v1/merchant/ai-agent/config (§5).',
        errors: { required: 'Required', too_long: (max) => `At most ${max} characters`, invalid: 'Wrong format' },
      },
      team: {
        empty: 'No team members yet.',
        columns: { name: 'Name', email: 'Email', role: 'Role', permissions: 'Permissions', status: 'Status', joined: 'Joined' },
        invite: 'Invite member',
        notWired: 'Inviting members belongs to the §48 member-management write family and is not wired into this page yet.',
      },
      keys: {
        empty: 'No API keys yet.',
        columns: { label: 'Label', prefix: 'Prefix', scopes: 'Scopes', created: 'Created', lastUsed: 'Last used', revoked: 'Revoked' },
        create: 'Create key',
        notWired: 'The real create endpoint is POST /api/v1/merchant/api-keys (§5); a key is returned in full exactly once.',
        onceNote: 'A full key is returned once at creation; this list only ever shows a prefix.',
      },
      knowledge: {
        empty: 'The knowledge base has no documents yet.',
        columns: { kind: 'Kind', title: 'Title', status: 'Status', chunks: 'Chunks', updated: 'Updated' },
        indexed: 'Indexed',
        awaiting: 'Awaiting index',
        failed: 'Failed',
        documents: 'Documents',
        chunksTotal: 'Total chunks',
        reindex: 'Request reindex',
        notWired: 'The reindex endpoint is POST /api/v1/merchant/knowledge-base/reindex (§5); it only marks documents pending — the AI service performs the embedding (§52).',
        statuses: { indexed: 'Indexed', ready: 'Indexed', pending: 'Awaiting index', processing: 'Indexing', failed: 'Failed', unknown: 'Unknown' },
      },
    },
    adminConsole: {
      overviewTitle: 'Admin overview',
      overviewIntro: 'The operator entry point: counters, AI cost and system health. Each block reads and degrades on its own — one failed read never blanks the page.',
      moderationTitle: 'Moderation queue',
      moderationIntro: 'The platform models moderation as *cases*: status is open/resolved and the decision lives in resolution.decision (§9/§127). Only `open` cases whose subject is a review can be actioned here.',
      merchantsTitle: 'Merchants',
      merchantsIntro: 'Merchants on the platform and their status. Suspension is a human action that requires a reason and an explicit confirmation (§9).',
      usersTitle: 'Users',
      usersIntro: 'Platform users. §9 documents only GET /api/v1/users/{id} — a single-user read, with no list route — so live mode says plainly that it cannot list users.',
      ordersTitle: 'Orders',
      ordersIntro: 'Platform orders. §9 documents the admin list family, but no controller serves it today, so live mode degrades visibly.',
      reservationsTitle: 'Reservations (all merchants)',
      reservationsIntro: 'All reservations. As with orders: the documented admin list route is not served yet, so live mode degrades visibly.',
      aiTitle: 'AI observability',
      aiIntro: 'Agent runs and cost, grouped by agent/model/day (§70). The degraded rate and cost share are derivations, labelled as such on the page.',
      searchTitle: 'Search analytics',
      searchIntro: 'What search demand the platform counted over a window (§9). These are descriptive counts: the schema has no search-quality score and this page will not invent one (§109).',
      systemTitle: 'System health',
      systemIntro: 'Each dependency is probed on the call (§9): the database state comes from a real select 1, and the AI service is reported as configured but deliberately not probed.',
      gate: {
        roleLabel: 'Acting role',
        demoRole: 'Demo identity (unauthenticated)',
        forbidden: (role) => `The acting identity’s role is “${role}”, not platform_admin or platform_ops (§68), so no operational data is shown.`,
        unverified: (code) => `Your role could not be verified (${code}), so this fails closed: no operational data is shown (§105).`,
        signIn: 'The admin console sits behind identity (§68). There is no login page yet, so live mode shows no data.',
      },
      counters: {
        users: 'Users',
        merchants: 'Merchants',
        orders: 'Orders',
        reservations: 'Reservations',
        suspended: 'Suspended merchants',
        openCases: 'Open cases',
        resolvable: 'Actionable cases',
        degraded: (count) => `${count} read(s) failed — the affected sections show the failure, not a 0.`,
        unavailable: 'platform did not report a total',
      },
      moderation: {
        caseLabel: 'Case',
        subjectType: 'Subject type',
        reason: 'Reason',
        policy: 'Policy',
        autoAction: 'Auto action',
        created: 'Created',
        resolvedAt: 'Resolved',
        resolution: 'Decision',
        resolutionNote: 'Resolution note',
        subject: 'Subject',
        merchant: 'Merchant',
        merchantStatus: 'Merchant status',
        excerpt: 'Excerpt',
        rating: 'Rating',
        language: 'Language',
        subjectMissing: 'The subject row for this case is gone, so there is nothing to show.',
        notResolvable: 'This case is not actionable here (only `open` cases whose subject is a review are).',
        decision: 'Decision',
        decisions: { published: 'Publish', rejected: 'Reject', flagged: 'Flag' },
        displayStatus: { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' },
        note: 'Note',
        noteHint: 'At most 500 characters; recorded in the audit trail with the decision.',
        resolve: 'Submit decision',
        resolving: 'Submitting…',
        confirmTitle: 'Submit this decision?',
        confirmText: (caseId) => `You are about to write an irreversible decision on case ${caseId}, leaving an audit record.`,
        resolved: 'The platform accepted the decision.',
        resolveFailed: (code) => `Submit failed (${code}); the case is unchanged.`,
        demoResolve: 'Demo: marked on this page only; nothing was written.',
        notWired: 'The resolve endpoint is POST /api/v1/admin/moderation/{case_id}/resolve (§9).',
        empty: 'No cases under this filter.',
        filter: 'Filter',
        filterOpen: 'Open',
        filterResolved: 'Resolved',
        filterAll: 'All',
      },
      merchants: {
        empty: 'No merchants.',
        columns: { name: 'Name', slug: 'Slug', status: 'Status', category: 'Category', plan: 'Plan', rating: 'Rating', reviews: 'Reviews', created: 'Created' },
        suspend: 'Suspend',
        suspendTitle: 'Suspend this merchant',
        suspendIntro: 'Suspension takes effect for consumers immediately: the merchant page and every listing under it stop being served until it is republished.',
        suspendReason: 'Reason',
        suspendReasonHint: 'Required. The reason is written to the audit log and is not shown publicly.',
        suspending: 'Suspending…',
        suspended: 'The platform suspended the merchant.',
        suspendFailed: (code) => `Suspend failed (${code}); the merchant is unchanged.`,
        demoSuspend: 'Demo: marked on this page only; nothing was written.',
        suspendNotWired: 'The real suspend endpoint is POST /api/v1/admin/merchants/{id}/suspend (§9) and requires a platform-admin session.',
        alreadySuspended: 'This merchant is already suspended.',
        effect: 'Consumer effect',
        listUnavailable: '§9 documents GET /api/v1/admin/merchants, but no controller serves it today, so live mode cannot list merchants — what you see is the failure itself.',
      },
      users: {
        empty: 'No users.',
        columns: { name: 'Name', email: 'Email', locale: 'Locale', roles: 'Roles', created: 'Created' },
        listUnavailable: '§9 documents GET /api/v1/admin/users, but the platform serves only GET /api/v1/users/{id} (a single-user read) — there is no list route. Live mode therefore cannot list users.',
        detailNote: 'The single-user support read (GET /api/v1/users/{id}) returns that user’s memberships and activity counts (§3/§68).',
      },
      orders: {
        empty: 'No orders.',
        columns: { id: 'ID', status: 'Status', total: 'Total', items: 'Items', merchant: 'Merchant', created: 'Created' },
        listUnavailable: '§9 documents GET /api/v1/admin/orders, but no controller serves it today, so live mode cannot list orders.',
      },
      reservations: {
        empty: 'No reservations.',
        columns: { id: 'ID', status: 'Status', party: 'Party', startsAt: 'Starts at', merchant: 'Merchant', created: 'Created' },
        listUnavailable: '§9 documents GET /api/v1/admin/reservations, but no controller serves it today, so live mode cannot list reservations.',
      },
      ai: {
        runsTitle: 'Agent runs',
        runsIntro: 'Recent agent_runs rows: status, tokens, cost and whether a fallback fired (§70).',
        runsEmpty: 'No runs recorded.',
        degradedRate: (rate) => `Degraded rate ${rate}`,
        degradedDefinition: 'Degraded = status is fallback/degraded, or fallback_used is set (§105).',
        runColumns: { id: 'Run', agent: 'Agent', model: 'Model', status: 'Status', degraded: 'Degraded', latency: 'Latency', tokens: 'Tokens', cost: 'Cost', started: 'Started' },
        costsTitle: 'Cost roll-up',
        costsIntro: 'The same agent_runs rows rolled up by agent/model/day (§9). The share column is derived here and labelled as such.',
        costsEmpty: 'No cost rows.',
        groupBy: { agent: 'By agent', model: 'By model', day: 'By day' },
        costColumns: { key: 'Group', runs: 'Runs', tokens: 'Tokens', cost: 'Cost (USD)', share: 'Share', latency: 'Avg latency' },
        costUnavailable: 'group not provided by the platform',
        noSpend: 'The mock provider has no real spend, so cost is empty rather than $0 (D4).',
        askTitle: 'Ask (read-only)',
        askIntro: 'The §126 analytics agent answers read-only questions: it works from aggregate SQL over this tenant’s own rows and never writes or invents a number.',
        askPlaceholder: 'e.g. how many published merchants does this tenant have?',
        ask: 'Ask',
        asking: 'Asking…',
        askAnswer: 'Answer',
        askEvidence: 'Evidence metrics',
        askDegraded: (reason) => `This answer is degraded (${reason}): the platform service ships no LLM client, so the answer came from deterministic SQL, not a model.`,
        askReadOnly: 'Read-only: this agent has no write tools.',
        askFailed: (code) => `Ask failed (${code}).`,
        askNotWired: 'The real ask endpoint is POST /api/v1/admin/ai/ask (§9/§126).',
        askEmpty: 'No question asked yet.',
        askRefused: 'The platform refused this question: it reads as a write instruction, and the agent is read-only (§126).',
      },
      search: {
        window: (days) => `Window: last ${days} days`,
        totalsTitle: 'Window totals',
        totals: { searches: 'Searches', sessions: 'Sessions', fulfilled: 'Fulfilled intents', activeDays: 'Active days' },
        fulfilmentShare: 'Fulfilment share',
        fulfilmentNote: 'Derived as fulfilled intents ÷ searches; “—” when the denominator is zero.',
        dailyTitle: 'Daily series',
        dailyColumns: { day: 'Day', sessions: 'Sessions', searches: 'Searches', fulfilled: 'Fulfilled' },
        dailyEmpty: 'No daily rows in the window.',
        eventsTitle: 'Event breakdown',
        eventColumns: { name: 'Event', events: 'Events', sessions: 'Sessions' },
        eventsEmpty: 'No events in the window.',
        noQualityScore: 'The schema has no “search quality” metric; this page reports the counts the platform measured and will not derive a score from them (§109).',
      },
      system: {
        overall: { ok: 'Healthy', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' },
        dependenciesTitle: 'Dependencies',
        columns: { dependency: 'Dependency', state: 'State', rawState: 'Raw value', latency: 'Latency', detail: 'Detail' },
        dependenciesEmpty: 'The platform listed no dependencies — “not listed” is not “all clear” (§155).',
        version: 'Service version',
        schemaVersion: 'Schema version',
        profiles: 'Active profiles',
        notProbed: 'The AI service reports whether it is configured and is deliberately not probed (§9).',
        sourceNote: 'Each dependency is probed on this call; the database state comes from a real select 1.',
      },
    },
  },
  states: { loading: 'Loading…', error: 'Could not load', empty: 'Nothing here yet' },
  footer: {
    exploreTitle: 'Explore',
    demoTitle: 'Demo data notice',
    demoText: 'Phase 1 runs on a synthetic dataset. Demo content is labelled as such and never presented as a real merchant or real footfall.',
    methodTitle: 'Ranking method',
    methodText: 'Organic ranking uses relevance, quality, distance and price fit. Paid placement is separate and always labelled “Ad”.',
    trustTitle: 'Trust and safety',
    trustText: 'Every claim traces back to a source fact. The model never writes to the database, and merchants control their own data.',
    rights: '© 2026 NEXUS',
  },
};

const DICTS: Record<Locale, Dict> = { 'zh-HK': zhHK, en };

export function getDict(locale: string | null | undefined): Dict {
  return DICTS[normalizeLocale(locale)];
}
