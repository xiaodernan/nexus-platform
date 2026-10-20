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
    newSearch: string;
    clearQuery: string;
    compareLabel: string;
    compareClear: string;
    compareTitle: (count: number) => string;
    emptyTitle: string;
    emptyText: string;
    emptyHint: string;
    errorTitle: string;
    errorText: string;
    retry: string;
    degraded: string;
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
  brand: { name: 'NEXUS', tagline: '用一句话，找到今天想去的地方' },
  nav: {
    search: '智能搜索',
    guides: '指南',
    collections: '精选',
    account: '我的',
    merchantPortal: '商户中心',
    skipToContent: '跳到主要内容',
  },
  home: {
    eyebrow: '对话式本地发现',
    title: '想说就去。',
    subtitle: '讲出你的条件——地区、预算、时间、口味——NEXUS 会理解需求、搜索真实商户并解释每个推荐。',
    searchPlaceholder: '例如：帮我找沙田适合约会的餐厅，预算 500，安静一点',
    submit: '开始搜索',
    examplesLabel: '试试这些',
    rails: {
      popular_near_you: { title: '你附近热门', description: '按距离与口碑排序，仅显示已有事实的资料' },
      for_you: { title: '为你推荐', description: '未登录时按附近热度排序；登录后才使用你声明的偏好' },
      trending: { title: '本周热议', description: '按评价数量而非人为推荐' },
      recommended: { title: '高性价比', description: '以已验证的均价排序' },
      recently_viewed: { title: '最近浏览', description: '来自你的浏览记录' },
    },
    stepsTitle: '一次搜索做了什么',
    steps: [
      { title: '理解需求', text: '把自然语言拆成类别、地点、预算、时间与偏好；不确定就问，不猜。' },
      { title: '混合搜索', text: '关键词 + 语义向量 + 地理范围，再按相关性、质量、距离与价格匹配排序。' },
      { title: '解释与预订', text: '每个结果标注数据来源与更新时间，你可以直接追问或预订。' },
    ],
    demoTitle: '当前是示例数据',
    demoText: '站内商户、商品与评价均为合成数据，用于演示产品流程；不代表任何真实商户或营业状况。',
    locationLabel: '位置',
    locationPrompt: '允许定位后可按距离排序；默认以中环为中心。',
  },
  search: {
    title: (query) => `“${query}”的结果`,
    subtitle: (count) => `${count} 个候选`,
    stages: {
      understanding: '理解需求…',
      searching: '搜索附近商户…',
      comparing: '比较与排序…',
      summarizing: '生成说明…',
      done: '完成',
    },
    found: (count) => `找到 ${count} 个符合条件的选择`,
    groups: {
      best_match: { title: '最匹配', description: '综合相关度最高的结果' },
      best_value: { title: '预算内优选', description: '在已验证价格内符合条件' },
      closest: { title: '最近', description: '按直线距离与步行时间' },
      most_popular: { title: '最热门', description: '按评价数量与质量分' },
    },
    followUpLabel: '继续追问',
    followUpPlaceholder: '例如：只看周六晚上 7 点后的',
    newSearch: '新搜索',
    clearQuery: '清除输入',
    compareLabel: '加入对比',
    compareClear: '清除对比',
    compareTitle: (count) => `对比 ${count} 个结果`,
    emptyTitle: '没有符合条件的结果',
    emptyText: '放宽一个条件（预算、距离或时间）通常就会有结果。',
    emptyHint: '我们不会用不相关的结果填满页面。',
    errorTitle: 'AI 搜索暂不可用',
    errorText: '已改用确定性搜索返回结果；下方会标明降级原因。',
    retry: '重试',
    degraded: '流式搜索失败，已降级为确定性搜索结果。',
    citations: (count) => `${count} 条来源事实`,
    meta: (latencyMs, provider) => `${latencyMs} 毫秒 · 模型：${provider}`,
    runId: (id) => `运行编号 ${id}`,
  },
  merchant: {
    notFoundTitle: '找不到该商户',
    notFoundText: '链接可能过期，或该商户尚未发布资料。',
    about: '简介',
    menu: '菜单与服务',
    reviews: '评价',
    hours: '营业时间',
    location: '位置与交通',
    summaryTitle: '评价摘要',
    themesLabel: '常被提到',
    evidenceLabel: (count) => `依据 ${count} 条评价`,
    reviewedBy: '摘要由模型生成，只引用列出评价中的原句。',
    reserve: '预订',
    directions: '路线',
    call: '电话',
    weekday: '星期',
    today: '今天',
    openNow: '营业中',
    closedNow: '休息中',
    hoursFact: '营业时间由商户自报',
    mtr: (station, minutes) => `${station}站步行约 ${minutes} 分钟`,
    offeringsEmpty: '该商户暂无已发布的商品或服务。',
    reviewsEmpty: '暂无评价。',
    slots: '最近可订时段',
    slotsNote: '位况由商户数据同步，预订需登录后查看。',
    verifiedVisit: '已到店消费',
    verifiedPurchase: '已购买',
    helpful: (count) => `${count} 人觉得有用`,
    degradedTitle: '部分资料暂时无法读取',
    cuisineLabel: '菜系',
    attributesLabel: '设施与特色',
  },
  offering: {
    notFoundTitle: '找不到该商品或服务',
    notFoundText: '它可能已下架；商户主页仍可查看其他项目。',
    merchant: '所属商户',
    highlights: '特点',
    back: '返回商户',
  },
  facts: {
    title: '资料来源',
    note: '页面上每个数字都指向一条带来源、更新时间与置信度的事实。',
    empty: '暂无可展示的资料来源。',
    attributes: {
      price: '价格',
      rating: '评分',
      business_hours: '营业时间',
      opening_hours: '营业时间',
      distance: '距离',
      availability: '位况',
      cuisine: '菜系',
      price_band: '价位',
      menu: '菜单',
      review: '评价',
      location: '位置',
      address: '地址',
      phone: '电话',
      image: '图片',
      category: '类别',
      reservation: '预订',
      promotion: '优惠',
      capacity: '容纳人数',
      atmosphere: '氛围',
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
      bakery: '面包',
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
    merchantTitle: '商户经营概览',
    merchantIntro: '流量、转化与询盘均来自平台文档化接口；每个数字标明来源、计算时间与新鲜度，读取失败会直接显示，不会用示例数据补位。',
    listingsTitle: '资料与商品管理',
    listingsIntro: '商户拥有并控制自己的资料（§47）。这里的修改在你点击提交前只存在于本页面。',
    adminTitle: '人工审核队列',
    adminIntro: '所有对外发布的内容（指南、优惠、资料变更）都要经过这里的人工确认（§27）；模型只能生成草案。',
    backToSite: '返回站点',
    demoBanner: '当前为示例模式（NEXT_PUBLIC_DATA_MODE=mock）：页面读取的是合成夹具目录，全部数字均为演示数据；真实数据需要登录，而登录页尚未上线。',
    signInRequiredTitle: '需要登录后查看',
    signInRequiredText: '控制台位于身份认证之后（§46/§48）。登录页尚未上线，因此实时模式下这里不展示任何经营数据；本页保持可渲染，方便评审界面与文案。',
    businessPickerLabel: '示例商户',
    demoIdentityNote: (name) => `当前查看的是演示身份「${name}」（合成夹具，不代表任何真实商户）。`,
    notWiredTitle: '尚未接入实时接口',
    notWiredText: '该操作需要平台接口与已认证的会话；两者都还没上线，所以这里不假装它成功了。',
    sections: {
      overview: '经营概况',
      funnel: '流量漏斗（v_merchant_funnel）',
      funnelNote: '漏斗行由平台按事件流计算；本页只重述它给出的数字与定义。',
      conversations: '客户询盘（AI/人工会话）',
      listings: '我的资料与商品',
      queue: '待审内容',
      marketing: '营销草案（未发布）',
    },
    funnel: {
      views: '页面浏览',
      clicks: '点击',
      actions: '关键动作',
      reservations: '有效预订',
      orders: '有效订单',
      revenue: '收入',
      clickThrough: '浏览→点击转化率',
      actionPerClick: '点击→动作转化率',
      derived: '由漏斗行推导',
      definition: (text) => `口径：${text}`,
      zeroNote: '没有流量/成交是真实状态（0），不是缺失数据。',
      statusLabel: '发布状态',
      planLabel: '套餐',
      categoryLabel: '类别',
    },
    provenance: { source: '来源', computedAt: '计算于', updated: '更新于' },
    freshness: { fresh: '实时', recent: '24 小时内', stale: '可能已过期', unknown: '时间未知' },
    read: { failed: (source, code) => `读取失败（${code}）：${source}。该区块没有用示例数据回填。` },
    conversations: {
      empty: '还没有客户询盘——这是真实的“暂无”，不是加载失败。',
      subjectFallback: '（无标题会话）',
      modeLabel: '应答模式',
      statusLabel: '状态',
      lastActivity: '最近活动',
      handoffOpen: '需要人工介入',
      modes: { ai: 'AI 应答', hybrid: 'AI+人工', human: '人工应答' },
      statuses: { open: '进行中', handoff: '已转人工', closed: '已结束', archived: '已归档' },
    },
    listings: {
      empty: '这个演示商户还没有已发布的商品或服务。',
      editCta: '编辑资料',
      editTitle: '编辑我的资料',
      editIntro: '这些字段就是你的商户资料（§47）：提交前修改只保留在这个浏览器里；提交后进入人工审核队列（§27），不会自动上线。',
      dirtyBanner: '你有未提交的修改——在你点击提交前，它们只属于你，不会发给任何接口。',
      fields: { name: '商户名称', tagline: '一句话简介', description: '简介', phone: '电话', price_amount: '人均价格（HKD）' },
      hints: { price_amount: '数字，最多两位小数；留空表示不展示价格。' },
      errors: { required: '此项不能为空', too_long: (max) => `不能超过 ${max} 个字符`, invalid: '格式不正确' },
      submit: '提交修改',
      reset: '撤销未提交的修改',
      submitting: '提交中…',
      demoSubmittedTitle: '演示动作：未发送任何请求',
      demoSubmittedText: (endpoint) => `示例模式没有登录会话，也没有可写的演示库，因此这次“提交”只停留在页面上；真实的写入接口是 ${endpoint}（需商户令牌与 CSRF，§1）。`,
      liveSubmittedTitle: '已提交，等待人工审核',
      liveSubmitFailed: (code) => `提交失败（${code}）：平台没有接受这次修改，下方内容仍是你未提交的原样。`,
      gateNote: '通过审核后才会生效：发布永远需要一个明确的人工动作（§27）。',
      signInBlockNote: '实时模式下需要先登录才能提交；登录页尚未上线。',
      rowsTitle: '当前已发布的商品/服务',
    },
    paid: {
      title: '付费推广与自然数据分离',
      text: '广告位与促销独立于上面的漏斗数字排序与统计（§66/§67）；本页不会把付费曝光合并进自然指标。',
    },
    admin: {
      summary: (pending, unreviewedAi) => `${pending} 项待审，其中 ${unreviewedAi} 项为尚未人工核对的 AI 内容。`,
      kinds: { guide: '指南草案', coupon: '优惠券草案', listing_change: '资料变更' },
      approve: '通过并发布',
      reject: '驳回',
      decidedApprove: '（本地标记：拟通过）',
      decidedReject: '（本地标记：拟驳回）',
      demoDecisionTitle: '演示决定：未发送到任何实时接口',
      demoDecisionText: (endpoint) => `示例模式下这个按钮不写入任何系统；真实流程是 ${endpoint}，且需要平台管理员会话（§9）。`,
      liveDecisionFailed: (code) => `审核动作失败（${code}），队列状态未变。`,
      liveDecisionOk: '决定已提交给平台。',
      submittedOn: (date) => `提交于 ${date}`,
      actorLabel: '提出者',
      gateIntro: '这里是 §27 发布门的人工侧：AI 生成的内容永远先停在 draft，只有人的动作能让它发布。',
      emptyQueue: '队列为空——平台目前没有待审内容。',
      unreviewedAiNote: '该内容仍未经过人工核对；模型可能出错，请对照证据后再决定。',
    },
    nav: {
      merchant: '商户中心',
      admin: '管理端',
      overview: '概览',
      listings: '资料',
      offerings: '商品与服务',
      reservations: '预订',
      conversations: '客户会话',
      reviews: '评价',
      campaigns: '营销',
      imports: '导入',
      analytics: '数据',
      settings: '设置',
      moderation: '审核队列',
      merchants: '商户',
      users: '用户',
      orders: '订单',
      adminReservations: '预订',
      ai: 'AI 观测',
      search: '搜索分析',
      system: '系统健康',
    },
    common: {
      empty: '这里暂时没有可显示的内容。',
      notStated: '未说明',
      derived: '由上方数据推导',
      readOnly: '只读',
      demoActionTitle: '演示动作：未发送任何请求',
      demoActionText: (endpoint) => `示例模式下这个按钮不写入任何系统；真实流程是 ${endpoint}，且需要已认证的会话（§1）。`,
      liveActionOk: '平台已接受这次操作。',
      actionFailed: (code) => `操作失败（${code}）：平台没有接受这次请求，下方状态未改变。`,
      confirm: '确认执行',
      cancel: '取消',
      submit: '提交',
      submitting: '提交中…',
      reason: '理由',
      window: '时间范围',
      sectionUnavailable: '该区块的数据源尚未由平台提供，因此这里不显示任何数字。',
    },
    offerings: {
      title: '商品与服务',
      intro: '你的商品与服务清单。列表读取自平台的公开菜单投影（§4），因为 §5 只文档化了写入接口；每一项的价格与状态都以平台返回的为准。',
      empty: '还没有已发布的商品或服务。',
      createTitle: '新增一项',
      fields: { title: '名称', kind: '类型', description: '说明', price_amount: '价格（HKD）', currency: '币种' },
      kinds: { product: '商品', service: '服务', experience: '体验' },
      errors: { required: '此项不能为空', too_long: (max) => `不能超过 ${max} 个字符`, invalid: '格式不正确' },
      create: '提交新增',
      created: '平台已接受新增，进入审核流程。',
      notWired: '示例模式下不会写入；真实写入接口为 POST /api/v1/merchant/offerings（§5）。',
      columns: { title: '名称', kind: '类型', price: '价格', status: '状态', updated: '更新时间' },
      createFailed: (code) => `新增失败（${code}）。`,
    },
    reservations: {
      title: '预订',
      intro: '来自平台预订收件箱的订位记录。状态流转由平台的状态机约束（§6）：已取消或未到店的预订没有后继状态，那是一笔新预订，不是可以「复原」的旧单。',
      empty: '还没有预订记录——这是真实的「暂无」。',
      today: '今天',
      all: '全部',
      counts: { total: '总笔数', awaiting: '待确认', seated: '已入座', cancelled: '已取消/未到', covers: '需接待人数' },
      columns: { guest: '客人', party: '人数', slot: '时段', status: '状态', source: '来源', price: '金额', notes: '备注', contact: '联络' },
      advance: '推进状态',
      advanceTo: (status) => `推进为「${status}」`,
      demoTransition: '演示：仅在本页改变状态，未写入平台。',
      notWired: '状态推进的真实接口是 PATCH /api/v1/reservations/{id}（§6），需要已认证的会话。',
      statuses: { requested: '待确认', pending: '待确认', confirmed: '已确认', seated: '已入座', completed: '已完成', cancelled: '已取消', no_show: '未到店' },
    },
    reviews: {
      title: '评价与评价洞察',
      intro: '摘要与主题由模型根据已发布评价生成（§54/§55），每个主题都标注它引用了哪些评价；没有证据的主题会明确标出。',
      empty: '还没有已发布的评价。',
      noSummary: '评价代理还没有为这家商户生成摘要——这是一个真实状态，不是读取失败。',
      summaryTitle: '评价摘要',
      themes: '常被提到的主题',
      themeMentions: (count) => `${count} 次提及`,
      evidence: (count) => `依据 ${count} 条评价`,
      noEvidence: '该摘要没有列出任何依据评价，因此不应被当作结论采信。',
      uncoveredThemes: (count) => `${count} 个主题未列出依据`,
      distribution: '评分分布',
      ratingLabel: '平均评分',
      model: '模型',
      generatedAt: '生成于',
      aiGenerated: '由 AI 生成',
      humanReviewed: '已通过人工核对',
      humanUnreviewed: '尚未经人工核对',
      unpublishedNote: '摘要仅供商户参考，不代表平台已对外发布的内容。',
    },
    campaigns: {
      title: '营销草案',
      intro: 'AI 生成的营销草案永远先停在 draft（§27）；只有人按下发布，它才会对外。发布是一个明确的、需要确认的动作，不会在页面加载时触发。',
      empty: '还没有营销草案。',
      columns: { name: '名称', channel: '渠道', status: '状态', audience: '受众', created: '创建时间' },
      body: '内容',
      evidence: '引用事实',
      publish: '批准并发布',
      publishing: '发布中…',
      gateBlocked: '这是尚未经人工核对的 AI 内容，按 §27 不能发布；请先完成人工核对。',
      confirmTitle: '确认发布这条草案？',
      confirmText: (name) => `你即将发布「${name}」。发布后它会对外可见，且无法通过本页撤回。`,
      published: '平台已接受发布。',
      publishFailed: (code) => `发布失败（${code}），草案状态未改变。`,
      demoPublish: '演示：仅在本页标记，未写入平台。',
      notWired: '发布的真实接口是 POST /api/v1/merchant/campaigns/{id}/publish（§5/§27）。',
      statuses: { draft: '草案', approved: '已核准', published: '已发布', rejected: '已驳回', archived: '已归档' },
    },
    imports: {
      title: 'AI 导入',
      intro: '从网址或文件抽取的商品提案（§22）。提案只是提案：每一项都需要人工逐条确认后才会成为资料，低信度与无依据的项会被标出。',
      empty: '还没有导入任务。',
      jobStatus: '任务状态',
      source: '来源',
      documents: '文档数',
      chunks: '分块数',
      created: '创建于',
      updated: '更新于',
      proposalsTitle: '抽取提案',
      lowConfidence: '低信度',
      withoutEvidence: '无依据',
      confidence: (value) => `信度 ${value}`,
      columns: { name: '名称', kind: '类型', price: '价格', category: '类别', confidence: '信度', evidence: '依据事实', span: '来源片段' },
      confirmProposal: '确认并采纳',
      confirmed: '已确认（演示）',
      confirmTitle: '确认采纳这条提案？',
      confirmText: (name) => `你将把「${name}」确认为正式资料。确认前它不会出现在任何对外页面。`,
      demoConfirm: '演示：仅在本页标记，未写入平台。',
      notWired: '提案确认的真实接口属于 §5 的写入族，尚未在页面接入。',
      degraded: '该任务报告为降级：部分抽取结果可能不完整。',
      stages: { queued: '排队', fetching: '抓取', parsing: '解析', embedding: '向量化', proposing: '生成提案' },
      statuses: { queued: '排队中', running: '处理中', succeeded: '已完成', failed: '失败', done: '已完成', cancelled: '已取消' },
    },
    analytics: {
      title: '经营数据',
      intro: '按窗口聚合的经营指标。每个数字都标明它是否由平台度量；平台没有度量的字段显示「—」，而不是 0（§19/§109）。',
      empty: '这个窗口内没有事件。',
      window: (from, to) => `${from} 至 ${to}`,
      metric: '主指标',
      notProvided: '平台未度量此字段',
      providedNote: (fields) => `本次读取实际带回的字段：${fields}`,
      definitions: '口径定义',
      source: '数据来源',
      note: '平台说明',
      eventSeries: '平台事件序列（每日）',
      ratesTitle: '推导比率',
      metrics: {
        views: '页面浏览',
        clicks: '点击',
        actions: '关键动作',
        reservations: '预订',
        orders: '订单',
        revenue: '收入',
        leads: '线索',
        ai_impressions: 'AI 曝光',
        search_appearances: '搜索出现',
        repeat_customers: '回头客',
      },
      rates: { viewToClick: '浏览→点击', clickToLead: '点击→线索', leadToReservation: '线索→预订', leadToOrder: '线索→订单', repeatShare: '回头客占比' },
    },
    settings: {
      title: '设置',
      intro: '资料、营业时间、认证、AI 代理、团队成员与 API 密钥。资料由商户控制（§47）；认证与密钥的授予由平台记录（§48）。',
      profileTitle: '商户资料',
      hoursTitle: '营业时间',
      hoursNote: '营业时间由商户自报（§47），不会由平台推断。',
      verificationTitle: '认证状态',
      agentTitle: 'AI 代理设置',
      agentIntro: '代理的问候语、语气与转人工阈值。低于阈值的回答会转交人工（§26）。',
      teamTitle: '团队成员',
      keysTitle: 'API 密钥',
      knowledgeTitle: '知识库',
      knowledgeIntro: 'AI 代理可以据以回答的文档。只有 AI 服务会写入向量（§52）；平台只标记为待重建，不会在这里声称已完成索引。',
      verification: { verified: '已认证', pending: '审核中', unverified: '未认证', unknown: '状态未知', note: '本构建中的认证为自述式（§48），商户自己的状态列是唯一权威。', request: '提交认证申请', demoRequest: '演示：未发送任何请求。', notWired: '认证接口为 POST /api/v1/businesses/{id}/verification（§5）。' },
      agent: {
        enabled: '启用代理',
        greeting: '问候语',
        tone: '语气',
        threshold: '转人工阈值（0–1）',
        languages: '语言（逗号分隔）',
        outsideHours: '非营业时间回复',
        save: '保存设置',
        saving: '保存中…',
        saved: '平台已接受设置。',
        notConfigured: '平台尚未提供当前设置的读取接口，因此这里不预填任何值。',
        updatedBy: (who) => `最后由 ${who} 更新`,
        demoSave: '演示：仅在本页保存，未写入平台。',
        notWired: '设置的写入接口为 POST /api/v1/merchant/ai-agent/config（§5）。',
        errors: { required: '此项不能为空', too_long: (max) => `不能超过 ${max} 个字符`, invalid: '格式不正确' },
      },
      team: {
        empty: '还没有团队成员。',
        columns: { name: '姓名', email: '邮箱', role: '角色', permissions: '权限', status: '状态', joined: '加入时间' },
        invite: '邀请成员',
        notWired: '邀请成员属于 §48 的成员管理写入族，尚未在页面接入。',
      },
      keys: {
        empty: '还没有 API 密钥。',
        columns: { label: '名称', prefix: '前缀', scopes: '范围', created: '创建时间', lastUsed: '最近使用', revoked: '已撤销' },
        create: '新建密钥',
        notWired: '新建密钥的真实接口为 POST /api/v1/merchant/api-keys（§5），密钥只会在创建时完整返回一次。',
        onceNote: '完整密钥只在创建时返回一次；此列表只会显示前缀。',
      },
      knowledge: {
        empty: '知识库还没有文档。',
        columns: { kind: '类型', title: '标题', status: '状态', chunks: '分块', updated: '更新时间' },
        indexed: '已索引',
        awaiting: '待索引',
        failed: '失败',
        documents: '文档数',
        chunksTotal: '分块总数',
        reindex: '请求重建索引',
        notWired: '重建索引的接口为 POST /api/v1/merchant/knowledge-base/reindex（§5）；它只把文档标记为待处理，实际的向量化由 AI 服务完成（§52）。',
        statuses: { indexed: '已索引', ready: '已索引', pending: '待索引', processing: '索引中', failed: '失败', unknown: '状态未知' },
      },
    },
    adminConsole: {
      overviewTitle: '管理端概览',
      overviewIntro: '平台运营的入口：各类计数、AI 成本与系统健康的摘要。每个区块各自读取、各自降级——一个读取失败不会让整页变成空白。',
      moderationTitle: '审核队列',
      moderationIntro: '平台把审核建模为「案件」：状态为 open/resolved，决定写在 resolution.decision（§9/§127）。只有 open 且 subject_type=review 的案件可以在本页处理。',
      merchantsTitle: '商户',
      merchantsIntro: '平台上的商户与其状态。停用是一个需要填写理由、并且需要二次确认的人工动作（§9）。',
      usersTitle: '用户',
      usersIntro: '平台用户。§9 只文档化了 GET /api/v1/users/{id} 这一条单用户读取，没有列表接口，因此本页在实时模式下会显式说明它无法列出用户。',
      ordersTitle: '订单',
      ordersIntro: '平台订单。§9 文档化了 admin 列表族，但当前平台没有对应控制器，因此实时模式下本页显式降级。',
      reservationsTitle: '预订（全平台）',
      reservationsIntro: '全平台预订。与订单同理：文档化的 admin 列表接口尚未被平台服务，实时模式下显式降级。',
      aiTitle: 'AI 观测',
      aiIntro: '代理运行记录与成本，按代理/模型/日聚合（§70）。降级率与成本占比是推导值，页面上会如此标注。',
      searchTitle: '搜索分析',
      searchIntro: '平台按窗口统计的搜索需求（§9）。这是描述性计数：schema 里没有搜索质量分，本页也不会凭空造一个（§109）。',
      systemTitle: '系统健康',
      systemIntro: '每个依赖各自探测（§9）：数据库来自一次真实的 select 1，AI 服务只报告「是否配置」而刻意不做探测。',
      gate: {
        roleLabel: '当前角色',
        demoRole: '演示身份（未认证）',
        forbidden: (role) => `当前身份的角色是「${role}」，不是 platform_admin 或 platform_ops（§68），因此不展示任何运营数据。`,
        unverified: (code) => `无法确认你的角色（${code}），因此按最小权限处理：不展示任何运营数据（§105）。`,
        signIn: '管理端位于身份认证之后（§68）。登录页尚未上线，因此实时模式下不展示任何数据。',
      },
      counters: {
        users: '用户',
        merchants: '商户',
        orders: '订单',
        reservations: '预订',
        suspended: '已停用商户',
        openCases: '待处理案件',
        resolvable: '可处理案件',
        degraded: (count) => `${count} 个读取失败——相关区块显示的是失败本身，不是 0。`,
        unavailable: '平台未返回总数',
      },
      moderation: {
        caseLabel: '案件',
        subjectType: '对象类型',
        reason: '原因',
        policy: '策略',
        autoAction: '自动动作',
        created: '创建于',
        resolvedAt: '结案于',
        resolution: '决定',
        resolutionNote: '结案备注',
        subject: '对象内容',
        merchant: '商户',
        merchantStatus: '商户状态',
        excerpt: '摘录',
        rating: '评分',
        language: '语言',
        subjectMissing: '该案件的对象行已不存在，因此没有可展示的内容。',
        notResolvable: '此案件当前不可处理（只有 open 且对象为 review 的案件可以）。',
        decision: '决定',
        decisions: { published: '发布', rejected: '驳回', flagged: '标记' },
        displayStatus: { pending: '待处理', approved: '已通过', rejected: '已驳回' },
        note: '备注',
        noteHint: '最多 500 字；会随决定一起写入审计记录。',
        resolve: '提交决定',
        resolving: '提交中…',
        confirmTitle: '确认提交这个决定？',
        confirmText: (caseId) => `你即将对案件 ${caseId} 写入一个不可撤回的决定，并留下审计记录。`,
        resolved: '平台已接受该决定。',
        resolveFailed: (code) => `提交失败（${code}），案件状态未改变。`,
        demoResolve: '演示：仅在本页标记，未写入平台。',
        notWired: '提交决定的接口是 POST /api/v1/admin/moderation/{case_id}/resolve（§9）。',
        empty: '这个筛选下没有案件。',
        filter: '筛选',
        filterOpen: '待处理',
        filterResolved: '已结案',
        filterAll: '全部',
      },
      merchants: {
        empty: '没有商户。',
        columns: { name: '名称', slug: '短链', status: '状态', category: '类别', plan: '套餐', rating: '评分', reviews: '评价数', created: '创建时间' },
        suspend: '停用',
        suspendTitle: '停用这个商户',
        suspendIntro: '停用会立刻对消费者生效：商户页面与其下所有商品都会停止对外服务，直到重新发布。',
        suspendReason: '停用理由',
        suspendReasonHint: '必填。理由会写入审计记录，但不会对外显示。',
        suspending: '停用中…',
        suspended: '平台已停用该商户。',
        suspendFailed: (code) => `停用失败（${code}），商户状态未改变。`,
        demoSuspend: '演示：仅在本页标记，未写入平台。',
        suspendNotWired: '停用的真实接口是 POST /api/v1/admin/merchants/{id}/suspend（§9），需要平台管理员会话。',
        alreadySuspended: '该商户已经处于停用状态。',
        effect: '对消费者的影响',
        listUnavailable: '§9 文档化了 GET /api/v1/admin/merchants，但当前平台没有对应控制器，因此实时模式下无法列出商户——这里显示的是失败本身。',
      },
      users: {
        empty: '没有用户。',
        columns: { name: '姓名', email: '邮箱', locale: '语言', roles: '角色', created: '创建时间' },
        listUnavailable: '§9 文档化了 GET /api/v1/admin/users，但当前平台只提供 GET /api/v1/users/{id}（单用户读取），没有列表接口。因此实时模式下无法列出用户。',
        detailNote: '单用户支持读取（GET /api/v1/users/{id}）会返回该用户的会员关系与活动计数（§3/§68）。',
      },
      orders: {
        empty: '没有订单。',
        columns: { id: '编号', status: '状态', total: '金额', items: '项目数', merchant: '商户', created: '创建时间' },
        listUnavailable: '§9 文档化了 GET /api/v1/admin/orders，但当前平台没有对应控制器，因此实时模式下无法列出订单。',
      },
      reservations: {
        empty: '没有预订。',
        columns: { id: '编号', status: '状态', party: '人数', startsAt: '开始时间', merchant: '商户', created: '创建时间' },
        listUnavailable: '§9 文档化了 GET /api/v1/admin/reservations，但当前平台没有对应控制器，因此实时模式下无法列出预订。',
      },
      ai: {
        runsTitle: '代理运行',
        runsIntro: 'agent_runs 的最近记录：状态、令牌、成本与是否触发了降级（§70）。',
        runsEmpty: '没有运行记录。',
        degradedRate: (rate) => `降级率 ${rate}`,
        degradedDefinition: '降级 = status 为 fallback/degraded，或 fallback_used 有值（§105）。',
        runColumns: { id: '运行编号', agent: '代理', model: '模型', status: '状态', degraded: '降级', latency: '延迟', tokens: '令牌', cost: '成本', started: '开始于' },
        costsTitle: '成本聚合',
        costsIntro: '同一批 agent_runs 按代理/模型/日聚合（§9）。占比由本页推导，并如此标注。',
        costsEmpty: '没有成本记录。',
        groupBy: { agent: '按代理', model: '按模型', day: '按日' },
        costColumns: { key: '分组', runs: '运行数', tokens: '令牌', cost: '成本（USD）', share: '占比', latency: '平均延迟' },
        costUnavailable: '平台未提供该分组',
        noSpend: 'mock 提供方没有真实花费，因此成本为空而不是 $0（D4）。',
        askTitle: '问数据（只读）',
        askIntro: '§126 的分析代理只回答只读问题：它基于本租户自身行的聚合 SQL 作答，绝不写入，也不虚构数字。',
        askPlaceholder: '例如：本租户有多少已发布商户？',
        ask: '提问',
        asking: '查询中…',
        askAnswer: '回答',
        askEvidence: '依据指标',
        askDegraded: (reason) => `本次回答是降级的（${reason}）：平台服务没有 LLM 客户端，因此答案来自确定性 SQL，而不是模型。`,
        askReadOnly: '只读：该代理没有任何写入工具。',
        askFailed: (code) => `提问失败（${code}）。`,
        askNotWired: '提问的真实接口是 POST /api/v1/admin/ai/ask（§9/§126）。',
        askEmpty: '还没有提问。',
        askRefused: '平台拒绝了这次提问：它看起来是一条写入指令，而该代理是只读的（§126）。',
      },
      search: {
        window: (days) => `窗口：最近 ${days} 天`,
        totalsTitle: '窗口合计',
        totals: { searches: '搜索次数', sessions: '会话数', fulfilled: '已满足意图', activeDays: '有数据天数' },
        fulfilmentShare: '意图满足率',
        fulfilmentNote: '由「已满足意图 ÷ 搜索次数」推导；分母为 0 时显示「—」。',
        dailyTitle: '每日序列',
        dailyColumns: { day: '日期', sessions: '会话', searches: '搜索', fulfilled: '已满足' },
        dailyEmpty: '窗口内没有每日数据。',
        eventsTitle: '事件分布',
        eventColumns: { name: '事件', events: '次数', sessions: '会话' },
        eventsEmpty: '窗口内没有事件。',
        noQualityScore: 'schema 中没有「搜索质量分」这样的指标；本页只报告平台度量到的计数，不会从计数推导一个分数（§109）。',
      },
      system: {
        overall: { ok: '正常', degraded: '降级', down: '不可用', unknown: '未知' },
        dependenciesTitle: '依赖项',
        columns: { dependency: '依赖', state: '状态', rawState: '原始值', latency: '延迟', detail: '详情' },
        dependenciesEmpty: '平台未列出任何依赖项——「没有列出」不等于「一切正常」（§155）。',
        version: '服务版本',
        schemaVersion: 'Schema 版本',
        profiles: '激活配置',
        notProbed: 'AI 服务只报告是否已配置，刻意不做探测（§9）。',
        sourceNote: '每个依赖在本次调用中被真实探测；数据库状态来自一次真实的 select 1。',
      },
    },
  },
  states: { loading: '加载中…', error: '加载失败', empty: '暂无内容' },
  footer: {
    exploreTitle: '浏览',
    demoTitle: '示例数据声明',
    demoText: 'Phase 1 使用合成数据集演示流程；所有示例内容均标注“示例数据”，不会以真实商户或真实客流呈现。',
    methodTitle: '排序方法',
    methodText: '自然结果由相关度、质量、距离与价格匹配决定；付费展示位与自然排序分离，并始终标注“广告”。',
    trustTitle: '信任与安全',
    trustText: '任何结论都可追溯到来源事实；模型不会直接写入数据库，商户资料修改由商户决定。',
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
    newSearch: 'New search',
    clearQuery: 'Clear',
    compareLabel: 'Compare',
    compareClear: 'Clear comparison',
    compareTitle: (count) => `Compare ${count} results`,
    emptyTitle: 'No results match',
    emptyText: 'Relaxing one constraint (budget, distance or time) usually helps.',
    emptyHint: 'We do not pad the page with irrelevant results.',
    errorTitle: 'AI search is unavailable',
    errorText: 'Served deterministic search results instead; the reason is shown below.',
    retry: 'Retry',
    degraded: 'Streaming failed, so results came from the deterministic search path.',
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
