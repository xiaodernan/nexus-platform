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
    backToTop: string;
    /** The theme switch's accessible name, per direction: the theme it moves TO. */
    themeToDark: string;
    themeToLight: string;
    /** D1095: the /hk-type archetype quiz link, shown in the footer. */
    hkType: string;
    handbook: string;
  };
  home: {
    eyebrow: string;
    title: string;
    subtitle: string;
    /** The search field's accessible name — a question, not an example. */
    searchLabel: string;
    searchPlaceholder: string;
    freshnessLine: string;
    submit: string;
    examplesLabel: string;
    /** §8 district chips row beneath the examples label — tasteful quickjumps. */
    districtsLabel: string;
    districtChips: { district: string; q: string; label: string }[];
    /** D1105: the /hong-kong mega hub — the HK story series consolidated. */
    hkHub: {
      eyebrow: string;
      title: string;
      intro: string;
      chaptersTitle: string;
      quizCtaTitle: string;
      quizCtaBody: string;
      quizCta: string;
      searchCta: string;
      searchCtaBody: string;
      searchHref: string;
      searchHrefLabel: string;
      /** D1118: eyebrow badges that had previously leaked English into the zh plane; D1119: handbook chapter-link label. */
      quizBadge: string;
      realSearchBadge: string;
      seriesLink: string;
      /** D1124: the arc timeline strip — chapters in clock order. */
      clockTitle: string;
      clockHint: string;
      clock: Array<{ time: string; name: string; href: string }>;
      /** D1115: 每日一句 — the Cantonese-of-the-day pool, picked by the HK date's FNV hash. */
      cantonese: {
        eyebrow: string;
        note: string;
        placeholder: string;
        pool: Array<{ phrase: string; jyutping: string; gloss: string }>;
      };
    };
    /** D1099: the HK story series rail — four chapters presented as a single literary thread on home. */
    hkSeries: { kicker: string; title: string; cards: Array<{ slug: string; label: string; kicker: string }> };
    /** D1112: 今日食運 — the deterministic daily card; twelve Traditional-HK entries chosen by the HK date's FNV hash. */
    hkDaily: {
      eyebrow: string;
      note: string;
      placeholder: string;
      entries: string[];
    };
    /** D1122: the home newcomer strip — five first-run anchors; localStorage-off dismissable. */
    newcomer: {
      eyebrow: string;
      dismiss: string;
      steps: Array<{ href: string; label: string }>;
    };
    /** D1118: mixed-locale fixes — badges that used to leak English into the zh plane. */
    hkProgress: {
      done: string;
      reset: string;
      mark: string;
      readCta: string;
    };
    /** One sentence under the tagline line underlining the sourcing discipline. */
    sourceNote: string;
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
    stickyCtaLabel: string;
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
    shareLabel: string;
    shareTitle: string;
    shareCopyLink: string;
    shareWhatsapp: string;
    shareCopied: string;
    shareCopyFailed: string;
  };
  /**
   * The merchant Q&A widget (§142). The agent answers only from the merchant's knowledge base and
   * hands off when it cannot; the copy below frames those two outcomes and never asserts anything
   * about the merchant itself.
   */
  ask: {
    title: string;
    hint: string;
    placeholder: string;
    submit: string;
    submitting: string;
    reading: string;
    you: string;
    agent: string;
    merchant: string;
    empty: string;
    handoffTitle: string;
    handoffBody: string;
    signInTitle: string;
    signInBody: string;
    signInCta: string;
    errorTitle: string;
    errorBody: string;
    demoNote: string;
    citations: (count: number) => string;
    runId: (id: string) => string;
    clear: string;
    starters: { key: string; label: string; question: string }[];
    mockAnswer: (name: string) => string;
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
    /** D1102: the HK series featured group — a tasteful teaser for the home-made chapters. */
    hkSeriesFeatured: {
      eyebrow: string;
      title: string;
      blurb: string;
    };
  };
  /** /hk-type — the consumer archetype quiz (Hong Kong series). */
  hkType: {
    eyebrow: string;
    title: string;
    intro: string;
    seriesLabel: string;
    chapters: Array<{ href: string; title: string; hint: string }>;
    start: string;
    progress: (current: number, total: number) => string;
    questionAria: string;
    questions: Array<{ text: string; options: Array<{ label: string; scores: Partial<Record<'yum_cha' | 'siu_mei' | 'cha_chaan_teng' | 'temple_street' | 'cha_chaan', number>> }> }>;
    results: Record<'yum_cha' | 'siu_mei' | 'cha_chaan_teng' | 'temple_street' | 'cha_chaan', { title: string; blurb: string; guideHref: string; guideTitle: string }>;
    resultEyebrow: string;
    copyShare: string;
    shareCopied: string;
    restart: string;
    backToHome: string;
    noTracking: string;
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
      replyLabel: string;
      replyHint: string;
      replyPlaceholder: string;
      replySubmit: string;
      replySubmitting: string;
      replyFailed: (code: string) => string;
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
        cacheTitle: string;
        cacheIntro: string;
        cacheEmpty: string;
        cacheColumns: { provider: string; model: string; calls: string; prompt: string; cached: string; hitRate: string; hits: string; reporting: string; replay: string };
        cacheReplayLabel: string;
        cacheHitRateLabel: string;
        cacheCoverageLabel: string;
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
        eventsTitle: string;
        eventsEmpty: string;
        eventsDisabled: string;
        eventsDegraded: (reason: string) => string;
        eventsColumns: { stream: string; length: string; inFlight: string; backlogNote: string };
        pendingDetailTitle: string;
        pendingDetailEmpty: string;
        pendingColumns: { id: string; consumer: string; idle: string; redeliveries: string };
      };
    };
  };
  /** /me — the consumer account hub. */
  me: {
    title: string;
    intro: string;
    eyebrow: string;
    membershipsLabel: string;
    preferencesSignals: (count: number) => string;
    preferencesTitle: string;
    preferencesIntro: string;
    preferencesSource: Record<'declared' | 'inferred' | 'explicit_feedback' | 'transaction', string>;
    preferencesScope: Record<'session' | 'long_term', string>;
    preferencesConfidence: string;
    /** Accessible label for the in-page jump chips (D1083). */
    jumpNavLabel: string;
    statsFavorites: string;
    statsReservations: string;
    statsOrders: string;
    favoritesTitle: string;
    favoritesIntro: string;
    favoritesEmptyTitle: string;
    favoritesEmptyText: string;
    favoritesNote: string;
    favoritesManage: string;
    favoritesUnsave: string;
    favoritesUnsaveBusy: string;
    favoritesUnsaveDone: string;
    favoritesUnsaveFailed: string;
    savedSearchesTitle: string;
    savedSearchesRerun: string;
    notificationsTitle: string;
    notificationsUnread: (count: number) => string;
    notificationsEmptyTitle: string;
    notificationsEmptyText: string;
    notificationsReadAll: string;
    notificationsReadAllDone: string;
    notificationsReadAllBusy: string;
    reservationsTitle: string;
    reservationsEmptyTitle: string;
    reservationsEmptyText: string;
    ordersTitle: string;
    ordersEmptyTitle: string;
    ordersEmptyText: string;
    orderStatus: Record<'pending_payment' | 'paid' | 'confirmed' | 'completed' | 'cancelled' | 'refunded', string>;
    reservationStatus: Record<'requested' | 'confirmed' | 'seated' | 'completed' | 'cancelled' | 'no_show', string>;
  };
  states: { loading: string; error: string; empty: string };
  /**
   * `/signin` — the local sign-in desk (§46/§48). Live mode had no route that sets the cookie the
   * consoles read, so every operator surface was unreachable; this is that route.
   */
  signin: {
    title: string;
    intro: string;
    roles: { merchant: string; consumer: string; admin: string };
    merchantHint: string;
    consumerHint: string;
    adminHint: string;
    submit: string;
    submitting: string;
    success: (role: string) => string;
    failed: (code: string) => string;
    signOut: string;
    signingOut: string;
    signedOut: string;
    deniedTitle: string;
    deniedBody: string;
    /** Left panel of the sign-in desk: three HK-local proof points (D1077). */
    proofsTitle: string;
    proofs: Array<{ title: string; text: string }>;
  };
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
  /** D1119: the /handbook page — the complete usage manual, new-user tour and game tutorial. */
  handbook: {
    eyebrow: string;
    title: string;
    intro: string;
    cta: string;
    navTitle: string;
    exampleLabel: string;
    exampleQuery: string;
    exampleCaption: string;
    tourTitle: string;
    tour: Array<{ title: string; text: string }>;
    sections: Array<{ id: string; kicker: string; title: string; paragraphs: string[]; bullets?: string[] }>;
    nextTitle: string;
    screenshotNote: string;
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
    backToTop: '回到頁首',
    themeToDark: '切換至深色主題',
    themeToLight: '切換至淺色主題',
    hkType: '香港人格',
    handbook: '說明書',
  },
  home: {
    eyebrow: '對話式本地發現',
    title: '想說就去。',
    subtitle: '講出你的條件——地區、預算、時間、口味——NEXUS 會理解需求、搜索真實商戶並解釋每個推薦。',
    searchLabel: '你想要什麼？',
    freshnessLine: '· 香港 · 真實商家 · 有據可查',
    sourceNote: '我們不冒充商家；每一個數字都對應一條可追溯的事實。沒有來源的資訊不會出現在這頁。',
    searchPlaceholder: '例如：幫我找沙田適合約會的餐廳，預算 500，安靜一點',
    submit: '開始搜索',
    examplesLabel: '試試這些',
    hkSeries: {
      kicker: '香港系列',
      title: '二十章反覆走完一個 HK',
      cards: [
        { slug: 'hk-food-chronicle', label: '香港三餐的血脈', kicker: '第一章' },
        { slug: 'hk-siu-mei-chronicle', label: '燒味：凌晨兩點的光與炭', kicker: '第二章' },
        { slug: 'hk-dim-sum-chronicle', label: '早茶：竹籠與陳皮茶香', kicker: '第三章' },
        { slug: 'hk-temple-street-chronicle', label: '廟街：宵夜成的一座廟', kicker: '第四章' },
        { slug: 'hk-cha-chaan-teng-chronicle', label: '茶餐廳：歸於日常', kicker: '第五章' },
        { slug: 'hk-fish-market-chronicle', label: '天光魚市：凌晨四點半的香港', kicker: '第六章' },
        { slug: 'hk-yu-huei-chronicle', label: '春花姨', kicker: '第七章' },
        { slug: 'hk-fruit-market-chronicle', label: '果欄：凌晨三點的卸貨', kicker: '第八章' },
        { slug: 'hk-tongsui-chronicle', label: '糖水：宵夜後的一碗甜', kicker: '第九章' },
        { slug: 'hk-bing-sat-chronicle', label: '冰室：菠蘿包與一杯鴛鴦', kicker: '第十章' },
        { slug: 'hk-cart-noodles-chronicle', label: '車仔麵：一桶會預告的夜', kicker: '第十一章' },
        { slug: 'hk-congee-chronicle', label: '皮蛋瘦肉粥：全城加班後的最後一味', kicker: '第十二章' },
        { slug: 'hk-lion-rock-chronicle', label: '獅子山：17:58 的第一粒燈', kicker: '第十三章' },
        { slug: 'hk-cheung-chau-chronicle', label: '長洲：渡輪上把海打開', kicker: '第十四章' },
        { slug: 'hk-mtr-evening-chronicle', label: '十八點半：辦公室落到地鐵', kicker: '第十五章' },
        { slug: 'hk-lei-yue-mun-chronicle', label: '鯉魚門：晨的海風與黃昏的聲音', kicker: '第十六章' },
        { slug: 'hk-bakery-dawn-chronicle', label: '鹹光燒餅：凌晨三點的第十七章', kicker: '第十七章' },
        { slug: 'hk-central-bourse-chronicle', label: '中環交易所：下午四點的鐘聲', kicker: '第十八章' },
        { slug: 'hk-er-chronicle', label: '半夜三點：急症室入口', kicker: '第十九章' },
        { slug: 'hk-window-cleaner-chronicle', label: '抹窗師傅：凌晨四點', kicker: '第二十章' },
      ],
    },
    hkDaily: {
      eyebrow: '今日食運',
      note: '按香港時間的今日日期推算，純粹好玩——想食咩，最後都係你話事。',
      placeholder: '正在翻今日的牌…',
      entries: [
        '『宜』：果欄當令的山竹——一日一果，香味最足',
        '『宜』：早茶第二籠蝦餃——第一籠留畀家人',
        '『留意』：燒味飯排隊的話，六點前落手最啱',
        '『宜』：茶餐廳的鴛鴦——紅茶加奶，三點後的魂都收得番',
        '『宜』：上環茶樓的陳皮普洱——理氣順喉',
        '『留意』：蘭芳園先睇牆上的位牌，再排隊',
        '『宜』：檸蜜金桔雪葩——一口都是甜',
        '『留意』：夜冷車前的艇仔麵——最後一口最入味',
        '『宜』：新鮮五花肉，回家燒給唞齊——週末先香',
        '『宜』：維園蛋撻檔剛出爐——先排先食',
        '『留意』：上水豬潤粥，熱辣辣落肚',
        '『宜』：兩隻腸粉加常餐——雨天不需要傘',
      ],
    },
    newcomer: {
      eyebrow: '新手上路',
      dismiss: '我知道了',
      steps: [
        { href: '/search', label: '先打句話' },
        { href: '/hong-kong', label: '讀香港系列' },
        { href: '/hk-type', label: '自測係邊個' },
        { href: '/handbook', label: '翻閱說明書' },
      ],
    },
    hkProgress: {
      done: '已讀 {read} ／ 共 {total} 章',
      reset: '重設',
      mark: '已讀',
      readCta: '讀章節',
    },
    hkHub: {
      eyebrow: '香港系列 · 完整篇章',
      title: '香港的一桌宴',
      intro: '從凌晨四點半的魚市與果欄，到廟街的車仔麵、冰室的菠蘿包、最後一碗糖水——本系列為香港人的早餐、午飯、宵夜與甜品寫下了一頁頁，每一章都是這座城市的一個縮影。',
      chaptersTitle: '二十章反覆走完一個香港',
      clockTitle: '香港一日的讀法：照時間讀',
      clockHint: '由 02:00 皮蛋瘦肉粥到 22:45 車仔麵 — 照順序進入這座城的節拍',
      clock: [
        { time: '02:00', name: '皮蛋瘦肉粥', href: '/guides/hk-congee-chronicle' },
        { time: '03:00', name: '急症室入口', href: '/guides/hk-er-chronicle' },
        { time: '03:10', name: '果欄', href: '/guides/hk-fruit-market-chronicle' },
        { time: '03:30', name: '鹹光燒餅', href: '/guides/hk-bakery-dawn-chronicle' },
        { time: '04:00', name: '抹窗師傅', href: '/guides/hk-window-cleaner-chronicle' },
        { time: '04:15', name: '春花姨', href: '/guides/hk-yu-huei-chronicle' },
        { time: '04:30', name: '天光魚市', href: '/guides/hk-fish-market-chronicle' },
        { time: '05:30', name: '三餐', href: '/guides/hk-food-chronicle' },
        { time: '06:00', name: '茶餐廳', href: '/guides/hk-cha-chaan-teng-chronicle' },
        { time: '06:30', name: '鯉魚門', href: '/guides/hk-lei-yue-mun-chronicle' },
        { time: '06:45', name: '冰室', href: '/guides/hk-bing-sat-chronicle' },
        { time: '07:30', name: '早茶', href: '/guides/hk-dim-sum-chronicle' },
        { time: '09:30', name: '長洲', href: '/guides/hk-cheung-chau-chronicle' },
        { time: '12:00', name: '燒味', href: '/guides/hk-siu-mei-chronicle' },
        { time: '16:00', name: '交易所鐘聲', href: '/guides/hk-central-bourse-chronicle' },
        { time: '17:58', name: '獅子山', href: '/guides/hk-lion-rock-chronicle' },
        { time: '18:30', name: '寫字樓落到地鐵', href: '/guides/hk-mtr-evening-chronicle' },
        { time: '19:00', name: '廟街', href: '/guides/hk-temple-street-chronicle' },
        { time: '22:30', name: '糖水', href: '/guides/hk-tongsui-chronicle' },
        { time: '22:45', name: '車仔麵', href: '/guides/hk-cart-noodles-chronicle' },
      ],
      quizCtaTitle: '你係邊一個 HK？',
      quizCtaBody: '10 道問題，找出你在香港的最近似的人格——從常餐店長到廟街解籤婆婆。',
      quizCta: '去 /hk-type 試自己',
      searchCta: '找一家沙田茶餐廳',
      searchCtaBody: '用關鍵字去這座城市搜一次——下一頓吃飯就在那兒。',
      quizBadge: '測驗',
      realSearchBadge: '真·搜尋',
      seriesLink: '香港系列',
      searchHref: '/search?q=沙田%20下午茶',
      searchHrefLabel: '沙田 下午茶',
      cantonese: {
        eyebrow: '每日一句 · 廣東話',
        note: '按香港時間的今日日期推算；一句就得。',
        placeholder: '正在想今日講邊句…',
        pool: [
          { phrase: '慢慢來，唔使急', jyutping: 'maan6 maan6 loi4, m4 sai2 gap1', gloss: 'You can take your time — the tea is no better for hurrying.' },
          { phrase: '有冇推介？', jyutping: 'jau5 mou5 teoi1 gaai3', gloss: 'Got a recommendation? The local way to ask.' },
          { phrase: '唔該，請問', jyutping: 'm4 goi1, ceng2 man6', gloss: 'Excuse me — may I ask something?' },
          { phrase: '貴唔貴呀？', jyutping: 'gwai3 m4 gwai3 aa3', gloss: 'How much? The only bargaining opener you need.' },
          { phrase: '真係抵食', jyutping: 'zan1 hai6 dai2 sik6', gloss: 'Genuinely worth the price — the quiet verdict of queuing locals.' },
          { phrase: '走先喇！', jyutping: 'zaau2 sin1 laa3', gloss: 'Heading off now — the Hong Kong goodbye.' },
          { phrase: '唔好意思，等一陣', jyutping: 'm4 hou2 ji3 si1, dang2 jat1 zan6', gloss: 'Sorry — one moment.' },
          { phrase: '唔係攪笑！', jyutping: 'm4 hai6 gaau2 siu3', gloss: 'I am not joking — the honest intensifier.' },
          { phrase: '歡迎光臨', jyutping: 'fun1 jing4 gwong1 lam4', gloss: 'To your custom, welcome — the greeting over every threshold.' },
          { phrase: '尋日見呢', jyutping: 'cam4 jat6 gin3 ne1', gloss: 'See you tomorrow — the friendly close of the day.' },
          { phrase: '多謝你啦', jyutping: 'do1 ze6 nei5 laa3', gloss: 'Thank you kindly — warmer than a receipt.' },
          { phrase: '等一陣先', jyutping: 'dang2 jat1 zan6 sin1', gloss: 'Hold on a second — the working phrase of every kitchen.' },
        ],
      },
    },
    districtsLabel: '熱門地區',
    districtChips: [
      { district: '沙田', q: '沙田 下午茶', label: '沙田 · 下午茶' },
      { district: '中環', q: '中環 酒吧', label: '中環 · 酒吧' },
      { district: '旺角', q: '旺角 抵食', label: '旺角 · 抵食' },
      { district: '尖沙咀', q: '尖沙咀 海鮮', label: '尖沙咀 · 海鮮' },
      { district: '銅鑼灣', q: '銅鑼灣 咖啡', label: '銅鑼灣 · 咖啡' },
      { district: '荃灣', q: '荃灣 火鍋', label: '荃灣 · 火鍋' },
    ],
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
    stickyCtaLabel: '直接行動',
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
    shareLabel: '分享',
    shareTitle: '分享這間商戶',
    shareCopyLink: '複製連結',
    shareWhatsapp: '用 WhatsApp 分享',
    shareCopied: '已複製連結',
    shareCopyFailed: '無法複製到剪貼簿；請長按上方的連結自行複製。',
  },
  ask: {
    title: '問問這間商戶',
    hint: '由商戶知識庫回答；找不到答案時會轉交商戶團隊，不會猜測。',
    placeholder: '例如：週六晚上七點有位嗎？招牌菜是什麼？',
    starters: [
      { key: 'availability', label: '有無位', question: '週六晚上七點有位嗎？' },
      { key: 'signature', label: '招牌菜', question: '招牌菜是什麼？' },
      { key: 'hours', label: '幾點開', question: '幾點開到幾點？' },
    ],
    submit: '送出問題',
    submitting: '正在回覆…',
    reading: '查閱商戶知識庫…',
    you: '你',
    agent: '商戶助理',
    merchant: '商戶團隊',
    empty: '還沒有對話。問一個關於營業時間、價格或預約的問題。',
    handoffTitle: '已轉交商戶團隊',
    handoffBody: '知識庫沒有足夠資料回答這題；商戶可在收件箱看到這條對話並接手回覆。',
    signInTitle: '登錄後才可提問',
    signInBody: '提問會建立一條你可追蹤的對話，因此需要先登錄。',
    signInCta: '前往登錄',
    errorTitle: '暫時無法回答',
    errorBody: '商戶助理暫不可用；你的問題未被記錄，請稍後再試。',
    demoNote: '示例環境：此回答未經商戶知識庫檢索，也未寫入任何對話。',
    citations: (count) => `${count} 條知識庫依據`,
    runId: (id) => `運行編號 ${id}`,
    clear: '開始新對話',
    mockAnswer: (name) =>
      `示例環境尚未連接商戶知識庫，因此不會代「${name}」作答。連接平台與 AI 後，這裡會先檢索該商戶已發佈的資料；找不到時才轉交商戶團隊。`,
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
    hkSeriesFeatured: {
      eyebrow: '香港系列 · 編者點線',
      title: '五章反覆走完一個香港',
      blurb: '從凌晨四點半街市裡冒煙的叉燒店，到午夜廟街的霓虹還剩最後一格——這是一座還沒被現實寫完的城市。',
    },
  },
  hkType: {
    eyebrow: '香港系列 · 互動篇章',
    title: '你係邊一個 HK？',
    intro: '食是香港這座城最不願意向你解釋、又最願意向你展示的一門功課。用十條問題找出你屬於哪一種香港人。',
    seriesLabel: '二十章香港系列指南',
    chapters: [
      { href: '/guides/hk-food-chronicle', title: '香港三餐的血脈', hint: '入門篇' },
      { href: '/guides/hk-siu-mei-chronicle', title: '燒味：凌晨兩點的光與炭', hint: '第二章' },
      { href: '/guides/hk-dim-sum-chronicle', title: '早茶：竹籠與陳皮茶香', hint: '第三章' },
      { href: '/guides/hk-temple-street-chronicle', title: '廟街：宵夜成的一座廟', hint: '第四章' },
      { href: '/guides/hk-cha-chaan-teng-chronicle', title: '茶餐廳：歸於日常', hint: '第五章' },
      { href: '/guides/hk-fish-market-chronicle', title: '天光魚市：凌晨四點半的香港', hint: '第六章' },
      { href: '/guides/hk-yu-huei-chronicle', title: '春花姨', hint: '第七章' },
      { href: '/guides/hk-fruit-market-chronicle', title: '果欄：凌晨三點的卸貨', hint: '第八章' },
      { href: '/guides/hk-tongsui-chronicle', title: '糖水：宵夜後的一碗甜', hint: '第九章' },
      { href: '/guides/hk-bing-sat-chronicle', title: '冰室：菠蘿包與一杯鴛鴦', hint: '第十章' },
      { href: '/guides/hk-cart-noodles-chronicle', title: '車仔麵：一桶會預告的夜', hint: '第十一章' },
      { href: '/guides/hk-congee-chronicle', title: '皮蛋瘦肉粥：全城加班後的最後一味', hint: '第十二章' },
      { href: '/guides/hk-lion-rock-chronicle', title: '獅子山：17:58 的第一粒燈', hint: '第十三章' },
      { href: '/guides/hk-cheung-chau-chronicle', title: '長洲：渡輪上把海打開', hint: '第十四章' },
      { href: '/guides/hk-mtr-evening-chronicle', title: '十八點半：辦公室落到地鐵', hint: '第十五章' },
      { href: '/guides/hk-lei-yue-mun-chronicle', title: '鯉魚門：晨的海風與黃昏的聲音', hint: '第十六章' },
      { href: '/guides/hk-bakery-dawn-chronicle', title: '鹹光燒餅：凌晨三點的第十七章', hint: '第十七章' },
      { href: '/guides/hk-central-bourse-chronicle', title: '中環交易所：下午四點的鐘聲', hint: '第十八章' },
      { href: '/guides/hk-er-chronicle', title: '半夜三點：急症室入口', hint: '第十九章' },
      { href: '/guides/hk-window-cleaner-chronicle', title: '抹窗師傅：凌晨四點', hint: '第二十章' },
    ],
    start: '開始',
    progress: (current, total) => `第 ${current} / ${total} 問`,
    questionAria: '三個選項，A、B、C',
    questions: [
      {
        text: '早上七點的街上，你會先去哪裡？',
        options: [
          { label: '茶餐廳，吃一份常餐', scores: { cha_chaan_teng: 2 } },
          { label: '茶樓，配兩籠點心和一壺普洱', scores: { yum_cha: 2 } },
          { label: '街市，先看燒味檔的燈亮着沒', scores: { siu_mei: 2 } },
        ],
      },
      {
        text: '常餐這個詞，對你來說是什麼？',
        options: [
          { label: '日日要食的那一份，無需理由', scores: { cha_chaan_teng: 2 } },
          { label: '每次去茶樓，那一份枱禮', scores: { yum_cha: 2 } },
          { label: '燒味檔六朝早上的第一道光', scores: { siu_mei: 2 } },
        ],
      },
      {
        text: '你下班第一件事想做什麼？',
        options: [
          { label: '找間茶餐廳，坐一會兒看電影回放', scores: { cha_chaan_teng: 2 } },
          { label: '午市街市，找師傅學燒味', scores: { siu_mei: 2 } },
          { label: '茶樓，點一壺普洱聊一天', scores: { yum_cha: 2 } },
        ],
      },
      {
        text: '你想帶一個外國朋友去哪裡吃飯？',
        options: [
          { label: '茶樓，三樓的竹籠推車', scores: { yum_cha: 2 } },
          { label: '街市，站着吃一碗燒鴨髀飯', scores: { siu_mei: 2 } },
          { label: '茶餐廳，靠窗的位子看街口又亮又匆忙', scores: { cha_chaan_teng: 2 } },
        ],
      },
      {
        text: '你覺得「等食」是什麼？',
        options: [
          { label: '有書看，有人說笑，菜會到', scores: { yum_cha: 2 } },
          { label: '火夠了，油脆了，終於輪到你', scores: { siu_mei: 2 } },
          { label: '等位之間，常餐突然遞到', scores: { cha_chaan_teng: 2 } },
        ],
      },
      {
        text: '你收到信息，猶豫了一下，你會：',
        options: [
          { label: '先點菊花普洱，再慢慢回覆', scores: { yum_cha: 2 } },
          { label: '先點常餐，吃完再答', scores: { cha_chaan_teng: 2 } },
          { label: '感覺重點還沒看明白，多坐一會', scores: { siu_mei: 2 } },
        ],
      },
      {
        text: '你的手提包裡永遠有什麼？',
        options: [
          { label: '一小包種籽，提醒自己悠然一下', scores: { yum_cha: 1, cha_chaan_teng: 1 } },
          { label: '收據，紀錄一天對準一份常餐的客套', scores: { cha_chaan_teng: 2 } },
          { label: '一疊餐巾紙，具備長時間等候的耐心', scores: { siu_mei: 2 } },
        ],
      },
      {
        text: '有一天你夜歸，看見廟街的鬼火，你會：',
        options: [
          { label: '走過去問解籤婆婆', scores: { temple_street: 2 } },
          { label: '去吃點東西，然後離開', scores: { cha_chaan: 2 } },
          { label: '徑直回家，不告訴別人', scores: { cha_chaan_teng: 2 } },
        ],
      },
      {
        text: '茶餐廳的紙巾，你會：',
        options: [
          { label: '抹手然後放到盤子底下', scores: { cha_chaan_teng: 2 } },
          { label: '整理包裝外頭一起帶走', scores: { cha_chaan: 2 } },
          { label: '寫下今晚火氣的方向，留下給朋友', scores: { temple_street: 2 } },
        ],
      },
      {
        text: '凌晨三點，你會在做什麼？',
        options: [
          { label: '茶樓消夜，不限數量的蒸籠', scores: { yum_cha: 2 } },
          { label: '常餐宵夜，對帳', scores: { cha_chaan_teng: 2 } },
          { label: '街市巡邏，看燒味檔燈熄了沒', scores: { siu_mei: 2 } },
          { label: '廟街散步，解籤婆婆還醒着', scores: { temple_street: 2 } },
        ],
      },
    ],
    results: {
      yum_cha: {
        title: '茶樓早茶：你係人間禮儀的原型',
        blurb: '你不追逐匆忙，寧肯多坐一會——普洱加菊花，炭火蒸氣推着手，每一籠都是一整個早晨。這股從容，就是茶樓的 DNA。',
        guideHref: '/guides/hk-dim-sum-chronicle',
        guideTitle: '閱讀《早茶：竹籠與陳皮茶香》',
      },
      siu_mei: {
        title: '燒味師傅：燃燒之於沉默',
        blurb: '你不愛波普，最在乎火候。蜜汁的顏色、炭缸的焦殼、八分鐘的那一瞬間——這就是你一生的堅持。',
        guideHref: '/guides/hk-siu-mei-chronicle',
        guideTitle: '閱讀《燒味：凌晨兩點的光與炭》',
      },
      cha_chaan_teng: {
        title: '常餐店長：這座城的節奏',
        blurb: '你不是大師，也不是職員——你是儀式本身。常餐一落枱，時間就對了；這座城市不缺店長，缺的是記得你的人。',
        guideHref: '/guides/hk-food-chronicle',
        guideTitle: '閱讀《香港三餐的血脈》',
      },
      temple_street: {
        title: '廟街之夜：',
        blurb: '你晚上去廟街是為了解籤婆婆把你的困境一字一句念完。這才是香港。',
        guideHref: '/guides/hk-temple-street-chronicle',
        guideTitle: '閱讀《廟街：宵夜成的一座廟》',
      },
      cha_chaan: {
        title: '茶餐廳血脈：',
        blurb: '你不是新來的——你是從戰後那把椅子爬出來的。絲襪奶茶流過你的血，常餐落在你的手上你不需要問。',
        guideHref: '/guides/hk-cha-chaan-teng-chronicle',
        guideTitle: '閱讀《茶餐廳》',
      },
    },
    resultEyebrow: '你的香港人格',
    copyShare: '分享',
    shareCopied: '已複製連結',
    restart: '再玩一次',
    backToHome: '回到首頁',
    noTracking: '此頁面不保存你的答案；它只是香港系列的另一篇章。',
  },
  console: {
    merchantTitle: '商戶經營概覽',
    merchantIntro: '流量、轉化與詢盤均來自平台文檔化接口；每個數字標明來源、計算時間與新鮮度，讀取失敗會直接顯示，不會用示例數據補位。',
    listingsTitle: '資料與商品管理',
    listingsIntro: '商戶擁有並控制自己的資料（§47）。這裡的修改在你點擊提交前只存在於本頁面。',
    adminTitle: '人工審核隊列',
    adminIntro: '所有對外發佈的內容（指南、優惠、資料變更）都要經過這裡的人工確認（§27）；模型只能生成草案。',
    backToSite: '返回站點',
    demoBanner: '當前為示例模式（NEXT_PUBLIC_DATA_MODE=mock）：頁面讀取的是合成夾具目錄，全部數字均為演示數據；真實數據需要登錄，示例登入在 /signin。',
    signInRequiredTitle: '需要登錄後查看',
    signInRequiredText: '控制台位於身份認證之後（§46/§48）。請先到 /signin 以示例身份登入；實時模式下這裡不展示任何經營數據，本頁保持可渲染，方便評審界面與文案。',
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
      replyLabel: '回覆這個顧客',
      replyHint: '你的回覆會立即寫進這條會話，以商戶團隊身份出現在線程中；顧客下次打開時就會看到。',
      replyPlaceholder: '寫給顧客的回覆…',
      replySubmit: '送出回覆',
      replySubmitting: '送出中…',
      replyFailed: (code) => `送出失敗（${code}）：平台沒有接受這次回覆，請稍後再試。`,
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
      signInBlockNote: '實時模式下需要先登錄才能提交；示例登入在 /signin。',
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
        signIn: '管理端位於身份認證之後（§68）。請先到 /signin 以管理員身份登入，實時模式下否則不展示任何數據。',
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
        cacheTitle: '快取記賬',
        cacheIntro: 'provider 回傳的逐次快取記賬（V13/V14：llm_calls.cached_tokens + cache_reported），經由 agent_runs 聯結限定本租戶範圍（§9/D1045/D1052）。命中率只在 provider 真的回報了快取記賬的調用上計算：未回報 ≠ 未命中；覆蓋率一欄說明了有多少調用真的回答了這個問題。沒有發明金額。',
        cacheEmpty: '沒有快取記賬行。',
        cacheColumns: { provider: 'Provider', model: '模型', calls: '調用', prompt: '輸入令牌', cached: '快取令牌', hitRate: '命中率', hits: '命中調用', reporting: '已回報', replay: '回放調用' },
        cacheReplayLabel: '確定性回放（D1047）—— 零 token、零往返',
        cacheHitRateLabel: '命中率（快取令牌 ÷ 已回報輸入令牌）',
        cacheCoverageLabel: '未回報 ≠ 未命中（D1052）',
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
        eventsTitle: '事件流',
        eventsEmpty: '自啟動以來沒有事件發佈到 Redis Stream（nexus:events）；零行不等於靜默丟棄——只表示沒有新的事件（§155）。',
        eventsDisabled: '平台 `nexus.events.redis-stream-enabled=false`；事件橋接默認不掛載——設為 true 之後才會有事件。',
        eventsDegraded: (reason: string) => `事件流不可用：${reason}`,
        eventsColumns: { stream: 'Redis Stream', length: '隊列長度', inFlight: '在途消息 (pending)', backlogNote: '環形上限 = nexus.events.max-len（默認 1000）' },
        pendingDetailTitle: '卡住的消息',
        pendingDetailEmpty: '消費組沒有卡住的消息——pending = 0。',
        pendingColumns: { id: 'Entry ID', consumer: '消費者', idle: '未確認空閒', redeliveries: '重投次數' },
      },
    },
  },
  me: {
    title: '我的',
    intro: '檔案、收藏、訂位與提醒——一個頁面讀完你在平台上的全部',
    eyebrow: '你的帳戶',
    membershipsLabel: '你的身份',
    preferencesSignals: (count) => `排序偏好：${count} 筆`,
    preferencesTitle: '我的排序訊號',
    preferencesIntro: '排名器會參考這些你講明或系統推斷的偏好。這些紀錄只屬於你，不會為他人開口。',
    preferencesSource: {
      declared: '你講明咗',
      inferred: '系統推斷',
      explicit_feedback: '你明確反饋',
      transaction: '你的交易',
    },
    preferencesScope: {
      session: '今次',
      long_term: '長期',
    },
    preferencesConfidence: '信心',
    jumpNavLabel: '跳到區塊',
    statsFavorites: '收藏',
    statsReservations: '訂位',
    statsOrders: '訂單',
    favoritesTitle: '我的收藏',
    favoritesIntro: '你保存的商戶，下次直接點開',
    favoritesEmptyTitle: '還沒有收藏',
    favoritesEmptyText: '在搜尋結果點一下愛心，保存的商戶會留在這裡',
    favoritesNote: '現階段只能預覽「商戶」類型的收藏——平台還未公開其他類型的單頁讀取',
    favoritesManage: '去搜尋更多',
    favoritesUnsave: '取消收藏',
    favoritesUnsaveBusy: '取消中…',
    favoritesUnsaveDone: '已全部取消收藏',
    favoritesUnsaveFailed: '取消失敗',
    savedSearchesTitle: '我的搜尋',
    savedSearchesRerun: '再搜尋',
    notificationsTitle: '提醒',
    notificationsUnread: (count) => `${count} 條未讀`,
    notificationsEmptyTitle: '沒有未讀提醒',
    notificationsEmptyText: '訂位確認、價格下降、評論回覆，都會留在這裡',
    notificationsReadAll: '全部標記為已讀',
    notificationsReadAllDone: '已全部讀取',
    notificationsReadAllBusy: '標記中…',
    reservationsTitle: '我的訂位',
    reservationsEmptyTitle: '近期沒有訂位',
    reservationsEmptyText: '在商戶頁按「訂位」，即可在這裡見到',
    ordersTitle: '我的訂單',
    ordersEmptyTitle: '還沒有訂單',
    ordersEmptyText: '完成下單後可在這裡查看進度',
    orderStatus: {
      pending_payment: '待付款',
      paid: '已付款',
      confirmed: '已確認',
      completed: '已完成',
      cancelled: '已取消',
      refunded: '已退款',
    },
    reservationStatus: {
      requested: '已提交',
      confirmed: '已確認',
      seated: '已入座',
      completed: '已完成',
      cancelled: '已取消',
      no_show: '未出席',
    },
  },
  signin: {
    title: '示例登入',
    intro: '本地演示用的登入口：選一個示例身份即可以該身份繼續瀏覽。真實環境需要完整的身份認證。',
    roles: { merchant: '商戶', consumer: '消費者', admin: '管理員' },
    merchantHint: '以示例商戶（example.hk）登入，可進入商戶控制台。',
    consumerHint: '以示例消費者登入，可保存收藏與查看個人資料。',
    adminHint: '以示例管理員登入，可進入人工審核隊列。',
    submit: '繼續',
    submitting: '正在登入…',
    success: (role) => `已作為${role}登入。`,
    failed: (code) => `登入被拒絕：${code}。`,
    signOut: '登出',
    signingOut: '正在登出…',
    signedOut: '已登出。',
    deniedTitle: '示例登入已被此環境關閉',
    deniedBody: '平台把 /api/v1/auth/demo 以 nexus.demo.login-enabled=false 關閉了。本頁只能用作說明；身份認證的正式流程還未上線。',
    proofsTitle: '為什麼是香港本地',
    proofs: [
      { title: '香港本地優先', text: '沙田、中環、旺角——查詢、價格、營業狀態都按香港商戶的真實資訊呈現。' },
      { title: '每個數字都有出處', text: '評分、價格、營業時間旁邊標明觀測時間與來源；沒有來源的資訊不會冒充事實。' },
      { title: '一句話就能搜', text: '「幫我搵邊間好食啲」直接落結果，不需要逐個欄位填表。' },
    ],
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
  handbook: {
    eyebrow: 'NEXUS · 簡明說明書',
    title: '玩盡 NEXUS，三分鐘讀完的完整說明書',
    intro: '由首頁的 SearchBox 到香港系列、每日食運，再到 /me 帳戶 hub——這本手冊逐頁告訴你：每個功能是什麼、怎麼用、注意什麼。',
    cta: '立即試第一步',
    navTitle: '本手冊目錄',
    exampleLabel: '試試看：把下面這句打進 SearchBox',
    exampleQuery: '油麻地 魚蛋，要抵食又快',
    exampleCaption: 'NEXUS 收到這句話，會拆出「油麻地」（地區）、「魚蛋」（品類）以及「抵食又快」（預算、時間偏好），再返回附近的商戶；每張卡下面都寫明為什麼推薦你這一間。',
    tourTitle: '三分鐘，五步上手',
    tour: [
      { title: '一句話入門', text: '搜尋任何你想吃的、做的、遇見的——「油麻地 魚蛋 抵食」或「廟街 宵夜」。' },
      { title: '看 AI 的理由', text: '每張推薦卡都會寫明為何推薦；每個數字都能追到事實。' },
      { title: '按你的口味收窄', text: '把條件說出來即得——「要有堂食座位」「預算 HK$200 內」「附近 15 分鐘步行」。' },
      { title: '香港系列照單全收', text: '/hong-kong 把這座城的一整天放在卡片上；讀過哪章，進度條會記住。' },
      { title: '/me 收起你的最愛', text: '收藏店舖、偏好、預約和收件匣全在一頁；九成功能不登入也用得。' },
    ],
    sections: [
      { id: 'search', kicker: 'SEARCH', title: '1 · SearchBox：一句話，就是一張地圖', paragraphs: [
        'SearchBox 收的不是關鍵詞——是一句人話。地區（油麻地／將軍澳／沙田）、品類（魚蛋／燒味飯／茶餐廳）、預算（HK$200 內）、時間（今晚／假日／打烊前）、口味（辣的／要快）都可以混在一起講。',
        '結果每張卡下面都有一行「為什麼推薦」——那是 AI 判斷鏈的任務聲明，每一步都能追到事實（距離、營業時段、最新評價、預算匹配）。找不到就直接告訴你找不到，不會把亂湊的東西塞進表格。',
      ] },
      { id: 'home', kicker: 'HOME', title: '2 · 首頁 rails 與 district chips', paragraphs: [
        '首頁的 rails（你附近熱門／為你推薦／熱門榜）由同一份本地事實聚合而來；登入之後，為你推薦才會反映你聲明過的偏好——這是為什麼「為你推薦」在登入前看起來像預設榜單。',
        'District chips（沙田／中環／旺角／銅鑼灣／荃灣…）是無腦跳法：點一下就把搜索丟進那個地區；想再精修就在 SearchBox 後面加條件即可。',
      ] },
      { id: 'hkseries', kicker: 'STORY', title: '3 · 香港系列 · 由凌晨三點走到最甜的杯底', paragraphs: [
        '二十章反覆走一遍香港這座城市的一整天——本系列經已拓至第二十章。順序按讀書順序：02:00 皮蛋瘦肉粥（第十二章）→ 03:00 急症室入口（第十九章）→ 03:10 果欄（第八章）→ 03:30 鹹光燒餅（第十七章）→ 04:00 抹窗師傅（第二十章）→ 04:15 春花姨（第七章）→ 04:30 天光魚市（第六章）→ 05:30 三餐的血（第一章）→ 06:00 茶餐廳（第五章）→ 06:30 鯉魚門（第十六章）→ 06:45 冰室（第十章）→ 07:30 早茶（第三章）→ 09:30 長洲（第十四章）→ 12:00 燒味（第二章）→ 16:00 交易所鐘聲（第十八章）→ 17:58 獅子山（第十三章）→ 18:30 寫字樓落到地鐵（第十五章）→ 19:00 廟街（第四章）→ 22:30 糖水（第九章）→ 22:45 車仔麵（第十一章）。',
        '每章都是「合成敘事示例」（旗幟標誌 demo: true），用於演示內容層的呈現能力；不是真實店家推薦，但就是那樣真實的一頓飯。',
        '/hong-kong 頂部的進度條會記住你讀過哪章（存在瀏覽器 localStorage，不會上傳；換裝置重頭開始）。',
      ] },
      { id: 'quiz', kicker: 'PLAY', title: '4 · /hk-type「香港人格」：怎麼玩', paragraphs: [
        '10 題——由早餐到夜宵，找出你在香港的最近似的人格：常餐店長、茶餐廳老闆、廟街解籤婆婆。沒有對錯，結果只是一面哈哈鏡。',
      ], bullets: [
        '每題三個選項；手機上點、桌面上撳 A / B / C 均可。',
        '每個選項會加權到一種人格；最高分的那一類勝出。',
        '結果頁一共三樣：專屬指南、分享（複製連結）、重新開始。',
        '全程無分析、無 cookie、無後端——結果不會離開你的螢幕。',
      ] },
      { id: 'daily', kicker: 'RITUAL', title: '5 · 三個每日儀式：今日食運／每日一句／章節進度', paragraphs: [
        '今日食運：以香港時間今日的日期（HKT）走 FNV-1a 雜湊取一句籤評——同一日同一張卡；它是純粹好玩，不是建議。',
        '每日一句：十二條手工核對過的廣東話，附 jyutping 與英文註釋（可作為簡單的廣東話入門）。',
        '章節進度：在目錄卡片上點一下即記錄；十章讀完，進度條就會滿了——地圖上每章會出現「已讀」徽章。',
      ] },
      { id: 'me', kicker: 'ACCOUNT', title: '6 · 我的 /me：收藏、偏好、預約、收件匣', paragraphs: [
        '/me 是登入後的總部。六份讀取（檔案／收藏／預約／訂單／已儲存搜索／收件匣）各自呈現在同一頁；任何一份壞了就明說，不會沉默。',
        '收件匣底部有「全部已讀」一鍵清空；偏好（§33 visibility）可以隨時打開或關閉「為你推薦」——不勾選，rails 也不會作任何假設。',
      ] },
      { id: 'merchant', kicker: 'MERCHANT', title: '7 · 如果你是商家：商戶中心', paragraphs: [
        '/merchant 是開店的地方：listing、對話、分析、預約欄、評價維護全在裡面；批量導入可以讓新商店把舊 listing 一次過入平台。',
        '想試商戶 shell 的話，demo 模式會給你一個示例商戶（merchant@example.hk）可以玩一遍；live 模式才看到真的成交和評價。',
      ] },
      { id: 'privacy', kicker: 'PRIVACY', title: '8 · 隱私與誠實說明', paragraphs: [
        '這是一個刻意誠實標示示例的產品——你看到的「示例數據」標籤不是彩蛋；而是所有沒有真數據時會寫明的合同。',
      ], bullets: [
        'Mock 模式（NEXT_PUBLIC_DATA_MODE=mock）：所有商戶／評價／預約皆為虛構，頁面會標註「示例數據」。',
        'Live 模式（NEXT_PUBLIC_DATA_MODE=live）：數字來自已連上的真實商戶；標籤消失，所以你會知道你看到哪一種。',
        '不接入任何分析 pixel、不載入第三方廣告；AI 草拟的東西會明文標註「由 AI 草拟／未有人審」。',
        '僅本地儲存：章節進度、已讀計數存在瀏覽器；清一清 localStorage 就回到零。',
      ] },
      { id: 'faq', kicker: 'FAQ', title: '9 · 常見問題，三條最實用', paragraphs: [
        '你衝過來只想知道一兩件事的話，先看這三條：',
      ], bullets: [
        '「為什麼我打不到東京的結果？」示例數據集僅有香港樣本；將來會拓更多城市。',
        '「商戶的價錢是真的嗎？」mock 模式是虛構；live 模式才有實時價錢。',
        '「還有第十一章嗎？」這個系列永遠有下一章；發佈進度寫進 STATUS.md（開發者賬本），跟進系列節奏就來 /hong-kong 看板更新。',
      ] },
    ],
    nextTitle: '想要更多？',
    screenshotNote: '截圖與實際畫面以現場部署為準；本說明書隨每次里程碑發佈更新。',
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
    backToTop: 'Back to top',
    themeToDark: 'Switch to the dark theme',
    themeToLight: 'Switch to the light theme',
    hkType: 'HK quiz',
    handbook: 'Handbook',
  },
  home: {
    eyebrow: 'Conversational local discovery',
    title: 'Just say it.',
    subtitle:
      'Describe the plan — area, budget, time, taste — and NEXUS understands, searches real listings and explains every result.',
    searchLabel: 'What are you looking for?',
    freshnessLine: '· Hong Kong · Real merchants · Every number sourced',
    sourceNote: 'We do not impersonate merchants; every number traces to a fact. A page without sources says so instead of guessing.',
    searchPlaceholder: 'e.g. date-friendly restaurants in Sha Tin, budget 500, quiet',
    submit: 'Search',
    examplesLabel: 'Try one of these',
    hkSeries: {
      kicker: 'HK SERIES',
      title: 'One HK in twenty chapters',
      cards: [
        { slug: 'hk-food-chronicle', label: "Hong Kong's Three Meals", kicker: 'Chapter I' },
        { slug: 'hk-siu-mei-chronicle', label: 'Siu Mei: The Light and Charcoal at Two A.M.', kicker: 'Chapter II' },
        { slug: 'hk-dim-sum-chronicle', label: 'Yum Cha: Steam and Aged Pu-erh', kicker: 'Chapter III' },
        { slug: 'hk-temple-street-chronicle', label: 'Temple Street: The Night Temple', kicker: 'Chapter IV' },
        { slug: 'hk-cha-chaan-teng-chronicle', label: 'The Cha Chaan Teng: Where the City Eats', kicker: 'Chapter V' },
        { slug: 'hk-fish-market-chronicle', label: 'The Four-Thirty Fish Market', kicker: 'Chapter VI' },
        { slug: 'hk-yu-huei-chronicle', label: 'Auntie Chun Fa Yee', kicker: 'Chapter VII' },
        { slug: 'hk-fruit-market-chronicle', label: 'The Fruit Market', kicker: 'Chapter VIII' },
        { slug: 'hk-tongsui-chronicle', label: 'Tong Sui: The Sweet Finish', kicker: 'Chapter IX' },
        { slug: 'hk-bing-sat-chronicle', label: 'The Ice-Room: Pineapple Bun and Yuenyeung', kicker: 'Chapter X' },
        { slug: 'hk-cart-noodles-chronicle', label: 'The Cart Noodles', kicker: 'Chapter XI' },
        { slug: 'hk-congee-chronicle', label: 'Century Egg Congee: The Last Honour', kicker: 'Chapter XII' },
        { slug: 'hk-lion-rock-chronicle', label: 'The Lion Rock: First Light of Dusk', kicker: 'Chapter XIII' },
        { slug: 'hk-cheung-chau-chronicle', label: 'Cheung Chau: The Ferry Opens the Sea', kicker: 'Chapter XIV' },
        { slug: 'hk-mtr-evening-chronicle', label: 'Eighteen-Thirty: From the Office to the MTR', kicker: 'Chapter XV' },
        { slug: 'hk-lei-yue-mun-chronicle', label: 'Lei Yue Mun: Morning Sea Wind, Evening Harbour Voice', kicker: 'Chapter XVI' },
        { slug: 'hk-bakery-dawn-chronicle', label: 'The Dawn Bakery', kicker: 'Chapter XVII' },
        { slug: 'hk-central-bourse-chronicle', label: 'The Central Bourse: The Four O Clock Bell', kicker: 'Chapter XVIII' },
        { slug: 'hk-er-chronicle', label: 'The Emergency Entrance at Half-Past Three', kicker: 'Chapter XIX' },
        { slug: 'hk-window-cleaner-chronicle', label: 'The Window Cleaners of 4 A.M.', kicker: 'Chapter XX' },
      ],
    },
    hkDaily: {
      eyebrow: "TODAY'S FOOD TICKET",
      note: 'Computed from today’s Hong Kong date — a bit of fun. Your appetite always has the last word.',
      placeholder: 'Peeking at today’s ticket…',
      entries: [
        'Fruit lorries at dawn — mangosteen at the peak of its swing best',
        'A second basket of har gow at yum cha — the first one stays with the family',
        'Roast-meat rice before six — the siu mei case empties fast',
        'Yuenyeung at 3 p.m. — red tea with milk, built for the afternoon',
        'Aged pu-erh with chenpi at a cha lau — smooth and easy',
        'Lan Fong Yuen hint: scout the queue board before joining the line',
        'Lemon-and-orange sorbet — one mouthful of Hong Kong summer',
        'Teng jai at two in the morning — the last bowl tastes the best',
        'Fresh pork belly, home roast — Saturday smells like this',
        'Warm egg tarts at Victoria Park — the first batch is the right batch',
        'Pork-offal congee at Sheung Shui — hot going in, quiet day after',
        'Two cheung fun and a set meal — enough rain-gear for any wet afternoon',
      ],
    },
    newcomer: {
      eyebrow: 'FIRST RUN',
      dismiss: 'Got it',
      steps: [
        { href: '/search', label: 'Make a guess' },
        { href: '/hong-kong', label: 'Read the series' },
        { href: '/hk-type', label: 'Ask which you are' },
        { href: '/handbook', label: 'Open the handbook' },
      ],
    },
    hkProgress: {
      done: '{read} of {total} chapters read',
      reset: 'Reset marks',
      mark: 'Read',
      readCta: 'READ THE CHAPTER',
    },
    hkHub: {
      eyebrow: 'THE HONG KONG SERIES · THE COMPLETE CHAPTERS',
      title: 'One table, one Hong Kong',
      intro: 'From the 4:30 a.m. fish market and the fruit lorries of Yau Ma Tei to the cart-noodles at Temple Street, the ice-room’s pineapple bun, and the sweet soup that closes the night — a chapter-by-chapter narrative of a city.',
      chaptersTitle: 'Twenty chapters through one Hong Kong',
      clockTitle: 'Reading the day in Hong Kong — clock order',
      clockHint: 'Every chapter, one time of day — from 02:00 through 22:45',
      clock: [
        { time: '02:00', name: 'Congee', href: '/guides/hk-congee-chronicle' },
        { time: '03:00', name: 'Emergency Entrance', href: '/guides/hk-er-chronicle' },
        { time: '03:10', name: 'Fruit market', href: '/guides/hk-fruit-market-chronicle' },
        { time: '03:30', name: 'The Dawn Bakery', href: '/guides/hk-bakery-dawn-chronicle' },
        { time: '04:00', name: 'Window cleaners', href: '/guides/hk-window-cleaner-chronicle' },
        { time: '04:15', name: 'Auntie', href: '/guides/hk-yu-huei-chronicle' },
        { time: '04:30', name: 'Fish market', href: '/guides/hk-fish-market-chronicle' },
        { time: '05:30', name: 'Three meals', href: '/guides/hk-food-chronicle' },
        { time: '06:00', name: 'Cha chaan teng', href: '/guides/hk-cha-chaan-teng-chronicle' },
        { time: '06:30', name: 'Lei Yue Mun', href: '/guides/hk-lei-yue-mun-chronicle' },
        { time: '06:45', name: 'Ice-room', href: '/guides/hk-bing-sat-chronicle' },
        { time: '07:30', name: 'Yum cha', href: '/guides/hk-dim-sum-chronicle' },
        { time: '09:30', name: 'Cheung Chau', href: '/guides/hk-cheung-chau-chronicle' },
        { time: '12:00', name: 'Siu mei', href: '/guides/hk-siu-mei-chronicle' },
        { time: '16:00', name: 'The Bourse Bell', href: '/guides/hk-central-bourse-chronicle' },
        { time: '17:58', name: 'Lion Rock', href: '/guides/hk-lion-rock-chronicle' },
        { time: '18:30', name: 'Office to MTR', href: '/guides/hk-mtr-evening-chronicle' },
        { time: '19:00', name: 'Temple Street', href: '/guides/hk-temple-street-chronicle' },
        { time: '22:30', name: 'Tong sui', href: '/guides/hk-tongsui-chronicle' },
        { time: '22:45', name: 'Cart noodles', href: '/guides/hk-cart-noodles-chronicle' },
      ],
      quizCtaTitle: 'Which HK are you?',
      quizCtaBody: 'Ten questions — from Cha Chaan Teng manager to the fate-teller on Temple Street.',
      quizCta: 'Try /hk-type',
      searchCta: 'Search a Sha Tin tea house',
      searchCtaBody: 'Type it and actually eat it — your next meal is one tap away.',
      quizBadge: 'QUIZ',
      realSearchBadge: 'REAL SEARCH',
      seriesLink: 'HK Series',
      searchHref: '/search?q=Sha%20Tin%20afternoon',
      searchHrefLabel: 'Sha Tin afternoon tea',
      cantonese: {
        eyebrow: 'ONE CANTONESE TODAY',
        note: 'Drawn fresh from the Hong Kong clock — one sentence, one day.',
        placeholder: 'Deciding which phrase today…',
        pool: [
          { phrase: '慢慢來，唔使急', jyutping: 'maan6 maan6 loi4, m4 sai2 gap1', gloss: 'You can take your time — the tea is no better for hurrying.' },
          { phrase: '有冇推介？', jyutping: 'jau5 mou5 teoi1 gaai3', gloss: 'Got a recommendation? The local way to ask.' },
          { phrase: '唔該，請問', jyutping: 'm4 goi1, ceng2 man6', gloss: 'Excuse me — may I ask something?' },
          { phrase: '貴唔貴呀？', jyutping: 'gwai3 m4 gwai3 aa3', gloss: 'How much? The only bargaining opener you need.' },
          { phrase: '真係抵食', jyutping: 'zan1 hai6 dai2 sik6', gloss: 'Genuinely worth the price — the quiet verdict of queuing locals.' },
          { phrase: '走先喇！', jyutping: 'zaau2 sin1 laa3', gloss: 'Heading off now — the Hong Kong goodbye.' },
          { phrase: '唔好意思，等一陣', jyutping: 'm4 hou2 ji3 si1, dang2 jat1 zan6', gloss: 'Sorry — one moment.' },
          { phrase: '唔係攪笑！', jyutping: 'm4 hai6 gaau2 siu3', gloss: 'I am not joking — the honest intensifier.' },
          { phrase: '歡迎光臨', jyutping: 'fun1 jing4 gwong1 lam4', gloss: 'To your custom, welcome — the greeting over every threshold.' },
          { phrase: '尋日見呢', jyutping: 'cam4 jat6 gin3 ne1', gloss: 'See you tomorrow — the friendly close of the day.' },
          { phrase: '多謝你啦', jyutping: 'do1 ze6 nei5 laa3', gloss: 'Thank you kindly — warmer than a receipt.' },
          { phrase: '等一陣先', jyutping: 'dang2 jat1 zan6 sin1', gloss: 'Hold on a second — the working phrase of every kitchen.' },
        ],
      },
    },
    districtsLabel: 'Hot districts',
    districtChips: [
      { district: 'Sha Tin', q: 'Sha Tin afternoon tea', label: 'Sha Tin · Afternoon tea' },
      { district: 'Central', q: 'Central bar', label: 'Central · Bars' },
      { district: 'Mong Kok', q: 'Mong Kok cheap eats', label: 'Mong Kok · Cheap eats' },
      { district: 'Tsim Sha Tsui', q: 'TST seafood', label: 'TST · Seafood' },
      { district: 'Causeway Bay', q: 'Causeway Bay coffee', label: 'Causeway Bay · Coffee' },
      { district: 'Tsuen Wan', q: 'Tsuen Wan hotpot', label: 'Tsuen Wan · Hotpot' },
    ],
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
    stickyCtaLabel: 'Quick actions',
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
    shareLabel: 'Share',
    shareTitle: 'Share this merchant',
    shareCopyLink: 'Copy link',
    shareWhatsapp: 'Share on WhatsApp',
    shareCopied: 'Link copied',
    shareCopyFailed: 'Could not write to the clipboard; hold the link above to copy it by hand.',
  },
  ask: {
    title: 'Ask this merchant',
    hint: 'Answered from this merchant’s own knowledge base; when it cannot answer, the team takes over instead of guessing.',
    placeholder: 'e.g. Is there a table on Saturday at 7pm? What is the signature dish?',
    starters: [
      { key: 'availability', label: 'Availability', question: 'Is there a table on Saturday at 7pm?' },
      { key: 'signature', label: 'Signature dish', question: 'What is the signature dish?' },
      { key: 'hours', label: 'Opening hours', question: 'When do you open and close?' },
    ],
    submit: 'Send question',
    submitting: 'Answering…',
    reading: 'Reading the merchant knowledge base…',
    you: 'You',
    agent: 'Merchant assistant',
    merchant: 'Merchant team',
    empty: 'No conversation yet. Ask about opening hours, prices or reservations.',
    handoffTitle: 'Handed to the merchant team',
    handoffBody: 'The knowledge base does not hold enough to answer this; the merchant can see this thread in their inbox and reply.',
    signInTitle: 'Sign in to ask',
    signInBody: 'A question opens a conversation you can track, so it needs an account first.',
    signInCta: 'Go to sign in',
    errorTitle: 'Cannot answer right now',
    errorBody: 'The merchant assistant is unavailable; your question was not recorded. Please try again later.',
    demoNote: 'Demo mode: this answer came from no knowledge base and was not written to any conversation.',
    citations: (count) => `${count} knowledge-base references`,
    runId: (id) => `Run ${id}`,
    clear: 'Start a new conversation',
    mockAnswer: (name) =>
      `Demo mode is not connected to a merchant knowledge base, so it will not answer for ${name}. With the platform and AI services attached it would search what this merchant has published, and hand over to the team only when nothing answers.`,
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
    hkSeriesFeatured: {
      eyebrow: "HK SERIES · The Editor's Line",
      title: 'Five chapters, one Hong Kong',
      blurb: "From the wok smoke still rising at 4:30 a.m. to the neon that has not yet retired on Temple Street — a city still being written.",
    },
  },
  hkType: {
    eyebrow: 'Hong Kong Series · The Interactive Chapter',
    title: 'Which Hong Kong are you?',
    intro: 'Food is the one exam Hong Kong will give you without warning. Ten questions to find which Hong Kong you are.',
    seriesLabel: 'Twenty HK chapters',
    chapters: [
      { href: '/guides/hk-food-chronicle', title: "Hong Kong's Three Meals", hint: 'Part one' },
      { href: '/guides/hk-siu-mei-chronicle', title: 'Siu Mei: The Light and Charcoal at Two A.M.', hint: 'Chapter two' },
      { href: '/guides/hk-dim-sum-chronicle', title: 'Yum Cha: Steam and Aged Pu-erh', hint: 'Chapter three' },
      { href: '/guides/hk-temple-street-chronicle', title: 'Temple Street: The Night Market', hint: 'Chapter four' },
      { href: '/guides/hk-cha-chaan-teng-chronicle', title: 'The Cha Chaan Teng: Where the City Eats', hint: 'Chapter five' },
      { href: '/guides/hk-fish-market-chronicle', title: 'The Four-Thirty Fish Market', hint: 'Chapter six' },
      { href: '/guides/hk-yu-huei-chronicle', title: 'Auntie Chun Fa Yee', hint: 'Chapter seven' },
      { href: '/guides/hk-fruit-market-chronicle', title: 'The Fruit Market', hint: 'Chapter eight' },
      { href: '/guides/hk-tongsui-chronicle', title: 'Tong Sui: The Sweet Finish', hint: 'Chapter nine' },
      { href: '/guides/hk-bing-sat-chronicle', title: 'The Ice-Room: Pineapple Bun and Yuenyeung', hint: 'Chapter ten' },
      { href: '/guides/hk-cart-noodles-chronicle', title: 'The Cart Noodles', hint: 'Chapter eleven' },
      { href: '/guides/hk-congee-chronicle', title: 'Century Egg Congee: The Last Honour', hint: 'Chapter twelve' },
      { href: '/guides/hk-lion-rock-chronicle', title: 'The Lion Rock: First Light of Dusk', hint: 'Chapter thirteen' },
      { href: '/guides/hk-cheung-chau-chronicle', title: 'Cheung Chau: The Ferry Opens the Sea', hint: 'Chapter fourteen' },
      { href: '/guides/hk-mtr-evening-chronicle', title: 'Eighteen-Thirty: From the Office to the MTR', hint: 'Chapter fifteen' },
      { href: '/guides/hk-lei-yue-mun-chronicle', title: 'Lei Yue Mun: Morning Sea Wind, Evening Harbour Voice', hint: 'Chapter sixteen' },
      { href: '/guides/hk-bakery-dawn-chronicle', title: 'The Dawn Bakery', hint: 'Chapter seventeen' },
      { href: '/guides/hk-central-bourse-chronicle', title: 'The Central Bourse: The Four O Clock Bell', hint: 'Chapter eighteen' },
      { href: '/guides/hk-er-chronicle', title: 'The Emergency Entrance at Half-Past Three', hint: 'Chapter nineteenth' },
      { href: '/guides/hk-window-cleaner-chronicle', title: 'The Window Cleaners of 4 A.M.', hint: 'Chapter twentieth' },
    ],
    start: 'Start',
    progress: (current, total) => `Question ${current} / ${total}`,
    questionAria: 'Three options, A through C',
    questions: [
      {
        text: 'At seven in the morning, where are you?',
        options: [
          { label: 'A cha chaan teng, order the usual', scores: { cha_chaan_teng: 2 } },
          { label: 'A yum cha house, two steam baskets and pu-erh', scores: { yum_cha: 2 } },
          { label: "On the street, checking the siu mei fire's still lit", scores: { siu_mei: 2 } },
        ],
      },
      {
        text: 'What does "cha chaan teng" (常餐) mean to you?',
        options: [
          { label: 'The one you order every single day, without reason', scores: { cha_chaan_teng: 2 } },
          { label: 'The etiquette you serve alongside the tea', scores: { yum_cha: 2 } },
          { label: 'The fire that wakes the whole street, then winds down', scores: { siu_mei: 2 } },
        ],
      },
      {
        text: 'After work, what do you want most?',
        options: [
          { label: 'A cha chaan teng, sit by the window, let the street blur', scores: { cha_chaan_teng: 2 } },
          { label: 'The siu mei stall — watch them work the roaster', scores: { siu_mei: 2 } },
          { label: 'One long pot of pu-erh at yum cha, on the ground floor', scores: { yum_cha: 2 } },
        ],
      },
      {
        text: 'Where would you feed a foreign friend first?',
        options: [
          { label: 'Yum cha — third floor, steam still climbing', scores: { yum_cha: 2 } },
          { label: 'Siu mei on the street, eaten with the market crowd', scores: { siu_mei: 2 } },
          { label: 'Cha chaan teng — by the window, watching the street wake up', scores: { cha_chaan_teng: 2 } },
        ],
      },
      {
        text: 'What does "the wait" mean, to you?',
        options: [
          { label: 'Something to read, someone to talk to, and the dish arrives', scores: { yum_cha: 2 } },
          { label: "The fire is right, the skin is right — finally it's your turn", scores: { siu_mei: 2 } },
          { label: 'Between the look and the first bite, the order arrives anyway', scores: { cha_chaan_teng: 2 } },
        ],
      },
      {
        text: 'A message arrives. You hesitate. You reach for:',
        options: [
          { label: 'Chrysanthemum pu-erh — the reply can wait one sip', scores: { yum_cha: 2 } },
          { label: 'The cha chaan teng usual — answer after the plate arrives', scores: { cha_chaan_teng: 2 } },
          { label: 'The siu mei fire — it is distracting and I love counting it', scores: { siu_mei: 2 } },
        ],
      },
      {
        text: 'What is always in the bag over your shoulder?',
        options: [
          { label: 'A little seedy coin purse — for future luck', scores: { yum_cha: 1, cha_chaan_teng: 1 } },
          { label: 'The receipt for my usual, to track time', scores: { cha_chaan_teng: 2 } },
          { label: 'A packet of tissues — for the steam, not the spillover', scores: { siu_mei: 2 } },
        ],
      },
      {
        text: 'Walking home late, you see the ghosts of Temple Street. You:',
        options: [
          { label: 'Ask the fate-teller for the name of the ghost', scores: { temple_street: 2 } },
          { label: 'Keep walking to the cha chaan teng with the warm door', scores: { cha_chaan: 2 } },
          { label: 'Go home, say nothing, and eat left-overs', scores: { cha_chaan_teng: 2 } },
        ],
      },
      {
        text: 'The napkin at the cha chaan teng is kept:',
        options: [
          { label: 'folded tightly on the tray', scores: { cha_chaan_teng: 2 } },
          { label: 'passed on the way out for the road', scores: { cha_chaan: 2 } },
          { label: 'scribbled with something for the next person who sits here', scores: { temple_street: 2 } },
        ],
      },
      {
        text: 'At three in the morning, you are:',
        options: [
          { label: 'Yum cha, no limits, no names on baskets', scores: { yum_cha: 2 } },
          { label: 'Cha chaan teng — the books are closed for the day', scores: { cha_chaan_teng: 2 } },
          { label: 'The last street patrol: is the roaster still lit?', scores: { siu_mei: 2 } },
          { label: 'Temple Street: the fate-teller still probably up', scores: { temple_street: 2 } },
        ],
      },
    ],
    results: {
      yum_cha: {
        title: 'Yum Cha: the original HK etiquette',
        blurb: 'You do not chase the rush. You stay an extra minute for the pu-erh and chrysanthemum — and the whole city follows you out the door.',
        guideHref: '/guides/hk-dim-sum-chronicle',
        guideTitle: 'Read 早茶：竹籠與陳皮茶香',
      },
      siu_mei: {
        title: 'Siu Mei: the fire is the point',
        blurb: 'You do not chase speed. You chase eight perfect minutes — the sauce, the snap of the skin — a Hong Kong that never hurries, and never slips.',
        guideHref: '/guides/hk-siu-mei-chronicle',
        guideTitle: 'Read 燒味：凌晨兩點的光與炭',
      },
      cha_chaan_teng: {
        title: 'Cha Chaan Teng: the city on time',
        blurb: 'You are not a connoisseur or a staff member — you are the ritual. The cha chaan teng lands the moment ordered; the city owes you its breath.',
        guideHref: '/guides/hk-food-chronicle',
        guideTitle: 'Read 香港三餐的血脈',
      },
      temple_street: {
        title: 'Temple Street: the fortune-walker',
        blurb: 'You go to Temple Street to let the fate-teller read what you have been avoiding. This is the Hong Kong the streetcar people will never know.',
        guideHref: '/guides/hk-temple-street-chronicle',
        guideTitle: 'Read Temple Street',
      },
      cha_chaan: {
        title: 'The Cha Chaan Teng bloodline',
        blurb: 'You are silk-stocking milk tea walking. You are an egg tart in motion. Every morning starts with custard, every night ends with one more cup.',
        guideHref: '/guides/hk-cha-chaan-teng-chronicle',
        guideTitle: 'Read the Cha Chaan Teng',
      },
    },
    resultEyebrow: 'Your Hong Kong archetype',
    copyShare: 'Share',
    shareCopied: 'Copied',
    restart: 'Play again',
    backToHome: 'Back home',
    noTracking: 'No answers are stored — this is one chapter of the series, not a service.',
  },
  console: {
    merchantTitle: 'Merchant business overview',
    merchantIntro: 'Traffic, conversion and leads come from documented platform reads; every figure shows its source, computation time and freshness, and a failed read is shown as a failure — never backfilled with fixtures.',
    listingsTitle: 'Profile & offerings',
    listingsIntro: 'The merchant owns and controls this data (§47). Edits stay on this page until you submit them.',
    adminTitle: 'Human review queue',
    adminIntro: 'Everything published (guides, coupons, listing changes) passes a human decision here (§27); models only produce drafts.',
    backToSite: 'Back to site',
    demoBanner: 'Demo mode (NEXT_PUBLIC_DATA_MODE=mock): every read below comes from the synthetic fixture catalogue and is demo-badged. Real data requires sign-in at /signin.',
    signInRequiredTitle: 'Sign-in required',
    signInRequiredText: 'The consoles sit behind identity (§46/§48). Sign in at /signin with an example identity; live mode shows no business data here, and the page stays renderable so the surface can still be reviewed.',
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
      replyLabel: 'Reply to this customer',
      replyHint: 'Your reply is written into the conversation as a team member, and the customer will see it the next time they open the thread.',
      replyPlaceholder: 'Write your reply to the customer…',
      replySubmit: 'Send reply',
      replySubmitting: 'Sending…',
      replyFailed: (code) => `Reply failed (${code}): the platform did not accept it — please try again.`,
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
      signInBlockNote: 'In live mode a session is required before submitting; the demo sign-in lives at /signin.',
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
        signIn: 'The admin console sits behind identity (§68). Sign in at /signin as an admin; until then live mode shows no data.',
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
        cacheTitle: 'Cache accounting',
        cacheIntro: "The provider's per-call cache figures (V13/V14: llm_calls.cached_tokens + cache_reported), scoped to this tenant through the agent_runs join (§9/D1045/D1052). The hit rate divides over the calls whose provider actually reported cache accounting — a silent response is not a miss, and the coverage cell states how many calls answered the question. No dollar saving is invented here.",
        cacheEmpty: 'No cache-ledger rows yet.',
        cacheColumns: { provider: 'Provider', model: 'Model', calls: 'Calls', prompt: 'Prompt tokens', cached: 'Cached tokens', hitRate: 'Hit rate', hits: 'Hit calls', reporting: 'Reported', replay: 'Replay calls' },
        cacheReplayLabel: 'Deterministic replays (D1047) — zero tokens, zero round trips',
        cacheHitRateLabel: 'Hit rate (cached ÷ reported prompt)',
        cacheCoverageLabel: 'Silent is not a miss (D1052)',
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
        eventsTitle: 'Event stream',
        eventsEmpty: 'No events since boot were published to the Redis stream (nexus:events). Zero rows is zero rows — it means no events, not a silent discard.',
        eventsDisabled: 'platform `nexus.events.redis-stream-enabled=false`; the bridge never mounts until set to true (default).',
        eventsDegraded: (reason: string) => `event stream unavailable: ${reason}`,
        eventsColumns: { stream: 'Redis stream', length: 'Length', inFlight: 'In-flight (pending)', backlogNote: 'ring cap = nexus.events.max-len (default 1000)' },
        pendingDetailTitle: 'Stuck messages',
        pendingDetailEmpty: 'No pending messages in the consumer group — pending = 0.',
        pendingColumns: { id: 'Entry ID', consumer: 'Consumer', idle: 'Idle since', redeliveries: 'Redeliveries' },
      },
    },
  },
  me: {
    title: 'My account',
    intro: 'Your profile, saves, bookings and inbox — one honest read of your page',
    eyebrow: 'Your account',
    membershipsLabel: 'Your roles',
    preferencesSignals: (count) => `Ranking preferences: ${count}`,
    preferencesTitle: 'My ranking signals',
    preferencesIntro: 'Ranking draws on these, declared by you or inferred by the system. They belong only to you.',
    preferencesSource: {
      declared: 'Declared by you',
      inferred: 'Inferred',
      explicit_feedback: 'Explicit feedback',
      transaction: 'Your transactions',
    },
    preferencesScope: {
      session: 'This session',
      long_term: 'Long-term',
    },
    preferencesConfidence: 'Confidence',
    jumpNavLabel: 'Jump to',
    statsFavorites: 'Saved',
    statsReservations: 'Reservations',
    statsOrders: 'Orders',
    favoritesTitle: 'My saved merchants',
    favoritesIntro: 'The places you kept — one tap from here the next time',
    favoritesEmptyTitle: 'Nothing saved yet',
    favoritesEmptyText: 'Tap the heart on any search result; saved merchants live here',
    favoritesNote: 'Only merchant saves preview as cards today — the platform has no public read for other subject types yet',
    favoritesManage: 'Find more places',
    favoritesUnsave: 'Unsave',
    favoritesUnsaveBusy: 'Unsaving…',
    favoritesUnsaveDone: 'All saved places removed',
    favoritesUnsaveFailed: 'Could not unsave',
    savedSearchesTitle: 'My searches',
    savedSearchesRerun: 'Run again',
    notificationsTitle: 'Inbox',
    notificationsUnread: (count) => `${count} unread`,
    notificationsEmptyTitle: 'Nothing new',
    notificationsEmptyText: 'Booking confirmations, price drops and review replies land here',
    notificationsReadAll: 'Mark all as read',
    notificationsReadAllDone: 'All caught up',
    notificationsReadAllBusy: 'Marking…',
    reservationsTitle: 'My reservations',
    reservationsEmptyTitle: 'No upcoming reservations',
    reservationsEmptyText: 'Book a table from any merchant page and it will show up here',
    ordersTitle: 'My orders',
    ordersEmptyTitle: 'No orders yet',
    ordersEmptyText: 'Once you check out, progress shows up here',
    orderStatus: {
      pending_payment: 'Pending payment',
      paid: 'Paid',
      confirmed: 'Confirmed',
      completed: 'Completed',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
    },
    reservationStatus: {
      requested: 'Requested',
      confirmed: 'Confirmed',
      seated: 'Seated',
      completed: 'Completed',
      cancelled: 'Cancelled',
      no_show: 'No-show',
    },
  },
  signin: {
    title: 'Demo sign-in',
    intro: 'This desk is for the demo plane: pick an example identity to continue as. Production requires full identity verification.',
    roles: { merchant: 'Merchant', consumer: 'Consumer', admin: 'Admin' },
    merchantHint: 'Sign in as an example merchant (example.hk) to reach the merchant console.',
    consumerHint: 'Sign in as an example consumer to save favourites and view your profile.',
    adminHint: 'Sign in as an example admin to reach the moderation queue.',
    submit: 'Continue',
    submitting: 'Signing in…',
    success: (role) => `Signed in as ${role}.`,
    failed: (code) => `Sign-in refused: ${code}.`,
    signOut: 'Sign out',
    signingOut: 'Signing out…',
    signedOut: 'Signed out.',
    deniedTitle: 'The demo sign-in is disabled in this environment',
    deniedBody: 'The platform closed /api/v1/auth/demo with nexus.demo.login-enabled=false. This page is an explanation only; the real identity flow is not available yet.',
    proofsTitle: 'Why Hong Kong first',
    proofs: [
      { title: 'Hong Kong first', text: 'Districts, prices and opening states are shown as the platform actually heard them from local merchants.' },
      { title: 'Every number has a source', text: 'Ratings, prices and hours carry their observed-at stamp; a page with no sources says so.' },
      { title: 'Ask in one line', text: '“someplace great for dim sum on Saturday” lands a considered answer, not a form.' },
    ],
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
  handbook: {
    eyebrow: 'NEXUS · THE HANDBOOK',
    title: 'Own NEXUS in three minutes',
    intro: 'From the SearchBox on the home page to the nine guide chapters, the daily cards and the /me hub — this book tells you what every feature is, how to drive it, and what to watch for.',
    cta: 'Take the first step',
    navTitle: 'IN THIS BOOK',
    exampleLabel: 'TRY THIS IN THE SEARCHBOX',
    exampleQuery: 'Yau Ma Tei fish balls, cheap and fast',
    exampleCaption: 'NEXUS parses the sentence into district (Yau Ma Tei), item (fish ball), budget and rush cues (cheap and fast); then returns matching merchants — every card tells you why that one made the cut.',
    tourTitle: 'Five steps, three minutes',
    tour: [
      { title: 'Ask once', text: 'Search for anything you would want nearby — "Yau Ma Tei fish balls, cheap" or "Temple Street late night".' },
      { title: 'Read the why', text: 'Each card prints its reason; every number traces back to a fact.' },
      { title: 'Tighten the answer', text: 'State the constraint like a sentence — "only with a bathroom", "under HK$200", "within a fifteen-minute walk".' },
      { title: 'Walk the series', text: 'One full day of Hong Kong in /hong-kong; the strip above the grid remembers every chapter you finished.' },
      { title: 'Save what you love', text: 'Favourites, preferences, reservations and inbox in /me — nine-tenths of the product works without an account.' },
    ],
    sections: [
      { id: 'search', kicker: 'SEARCH', title: '1 · SearchBox — one sentence is a map', paragraphs: [
        'The SearchBox reads a sentence, not keywords: districts (Yau Ma Tei / Sha Tin / Central), items (fish balls / siu mei / cha chaan teng), budgets (under HK$200), timing (tonight / rainy day / before close) and taste (spicy / steps from a cab) — mix them freely.',
        'Every result carries a "why this" line; the model writes it from the fact chain (distance, open hours, latest ratings, budget match). If nothing matches, it says so plainly — it never pads the list with a passable guess.',
      ] },
      { id: 'home', kicker: 'HOME', title: '2 · Home rails and district chips', paragraphs: [
        'The rails (popular near you / for you / trending) come from the same local fact set; the for-you rail only reflects your declared preferences after you sign in — before that it is honestly just the local leaderboard.',
        'District chips (Sha Tin / Central / Mong Kok / Causeway Bay / Tsuen Wan…) are the no-thinking jump: tap one, and the search is re-fired with the district preset — then refine from the SearchBox as usual.',
      ] },
      { id: 'hkseries', kicker: 'STORY', title: '3 · The HK series — lifetime chapters across the whole day', paragraphs: [
        'Twenty chapters walk through a whole Hong Kong day. Newest: Chapter 20 (the Window Cleaners of 4 A.M., 04:00). In chronological reading order: Chapter 12 (congee, 02:00) → Chapter 19 (the emergency triage, 03:00) → Chapter 8 (fruit market, 03:10) → Chapter 17 (the Dawn Bakery, 03:30) → Chapter 20 (the window cleaners, 04:00) → Chapter 7 (Auntie Chun Fa Yee, 04:15) → Chapter 6 (fish market, 04:30) → Chapter 1 (three meals, 05:30) → Chapter 5 (cha chaan teng, 06:00) → Chapter 16 (Lei Yue Mun, 06:30) → Chapter 10 (the ice-room, 06:45) → Chapter 3 (yum cha, 07:30) → Chapter 14 (Cheung Chau, 09:30) → Chapter 2 (siu mei, 12:00) → Chapter 18 (the Central Bourse, 16:00) → Chapter 13 (the Lion Rock, 17:58) → Chapter 15 (office to MTR, 18:30) → Chapter 4 (Temple Street, 19:00) → Chapter 9 (tong sui, 22:30) → Chapter 11 (cart noodles, 22:45).',



        'Every chapter is a synthetic editorial fixture (flags: demo) built to demonstrate the content layer — not a real restaurant list, but very much a real day of appetite.',
        'The strip above the chapter grid on /hong-kong remembers which ones you read (localStorage only; a new device starts from zero).',
      ] },
      { id: 'quiz', kicker: 'PLAY', title: '4 · /hk-type — how to play the Hong Kong persona quiz', paragraphs: [
        'Ten questions — from the first bowl at dawn to the one before you sleep — find the closest-matching Hong Kong you. There are no wrong answers; the result is a fun mirror, not a diagnosis.',
      ], bullets: [
        'Three options per question; tap on mobile or press A / B / C on desktop.',
        'Each option weights one persona; the highest-scoring persona wins.',
        'The result screen gives you three things: a matching guide, share (copy the link), and restart.',
        'Zero analytics, zero cookies, zero backend — your scores never leave the page.',
      ] },
      { id: 'daily', kicker: 'RITUAL', title: '5 · Three daily rituals — the almanac, the Cantonese of the day, the reading strip', paragraphs: [
        'The almanac: a deterministic one-liner seeded by the live Hong Kong clock (FNV-1a over the local date); same day, same card — it is a wink, not advice.',
        'Cantonese of the day: twelve hand-checked phrases with Jyutping and an English gloss — treat it as a seven-second Cantonese class before breakfast.',
        'The reading strip: tap a chapter on /hong-kong to chalk it; nine glyphs worth of pride are one tap away.',
      ] },
      { id: 'me', kicker: 'ACCOUNT', title: '6 · /me — favorites, preferences, reservations, inbox', paragraphs: [
        '/me is the post-sign-in headquarters. Six reads (profile, favorites, reservations, orders, saved searches, inbox), each on its own fate — if one fails, it says so, never silent filler.',
        'The inbox carries a read-all button; the preferences section toggles personalized ranking per surface — unset it, and the rails make no assumption about you.',
      ] },
      { id: 'merchant', kicker: 'MERCHANT', title: '7 · If you are a merchant', paragraphs: [
        '/merchant is where a storefront opens: listings, conversations, analytics, reservations queue, review moderation — plus a bulk import if a new store comes with forty legacy listings in a spreadsheet.',
        'want to try it before committing? The demo mode ships you with a demo merchant (merchant@example.hk) — feel around the console with zero paperwork.',
      ] },
      { id: 'privacy', kicker: 'PRIVACY', title: '8 · Privacy and honesty', paragraphs: [
        'This is a product built to say "synthetic" out loud — those tags are the contract, not a footnote.',
      ], bullets: [
        'Mock mode (NEXT_PUBLIC_DATA_MODE=mock): every merchant, review and reservation is invented; the page tags say "synthetic demo".',
        'Live mode (NEXT_PUBLIC_DATA_MODE=live): the numbers come from the merchants the platform has actually wired; the tags vanish because the demo story is now the real one.',
        'No analytics pixels, no advertising trackers; AI-drafted copy is flagged as "AI-drafted, unedited".',
        'localStorage only: reading progress and inbox counters live in your browser; wipe it, start over.',
      ] },
      { id: 'faq', kicker: 'FAQ', title: '9 · The three questions everyone asks', paragraphs: [
        'If you stuck around for three lines, here they are:',
      ], bullets: [
        '"Why no Tokyo?" The fixture set holds Hong Kong; other cities are future expansion.',
        '"Is the price real?" In mock mode it is imaginary; in live mode the platform only shows what it has checked.',
        '"Is a twentieth chapter planned?" The series never stops; the milestone ledger (STATUS.md) shows what is live, and the reader board is /hong-kong.',
      ] },
    ],
    nextTitle: 'Want more?',
    screenshotNote: 'Screenshots lag the running build; this handbook is refreshed on every shipped milestone.',
  },
};


const DICTS: Record<Locale, Dict> = { 'zh-HK': zhHK, en };

export function getDict(locale: string | null | undefined): Dict {
  return DICTS[normalizeLocale(locale)];
}
