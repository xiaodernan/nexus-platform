"""HK-market lexicon for deterministic query understanding (spec §7, §111-112).

Everything here is data so the extractors stay readable and the eval suites can be
extended without touching logic. Aliases cover zh-HK (traditional, the default copy
language), zh-CN (simplified) and en, per AGENT_CONTRACT §12.
"""

from __future__ import annotations

from nexus_ai.nlu.canonical import canonical

import re
from typing import Any

# ------------------------------------------------------------------ districts (HK)
# Coordinates are approximate demo anchors for the Hong Kong market tenant.
DISTRICTS: dict[str, dict[str, Any]] = {
    "Central":          {"aliases": ["中環", "中环", "central"], "lat": 22.2817, "lng": 114.1577, "area": "HKI"},
    "Admiralty":        {"aliases": ["金鐘", "金钟", "admiralty"], "lat": 22.2775, "lng": 114.1644, "area": "HKI"},
    "Wan Chai":         {"aliases": ["灣仔", "湾仔", "wan chai", "wanchai"], "lat": 22.2779, "lng": 114.1749, "area": "HKI"},
    "Causeway Bay":     {"aliases": ["銅鑼灣", "铜锣湾", "causeway bay", "cwb"], "lat": 22.2805, "lng": 114.1851, "area": "HKI"},
    "Soho":             {"aliases": ["上環", "上环", "soho", "sheung wan"], "lat": 22.2868, "lng": 114.1467, "area": "HKI"},
    "Tsim Sha Tsui":    {"aliases": ["尖沙咀", "tsim sha tsui", "tst"], "lat": 22.2988, "lng": 114.1722, "area": "KLN"},
    "Mong Kok":         {"aliases": ["旺角", "mong kok", "mongkok"], "lat": 22.3193, "lng": 114.1694, "area": "KLN"},
    "Sham Shui Po":     {"aliases": ["深水埗", "sham shui po", "ssp"], "lat": 22.3334, "lng": 114.1630, "area": "KLN"},
    "Kowloon City":     {"aliases": ["九龍城", "九龙城", "kowloon city", "hung hom", "紅磡", "红磡"], "lat": 22.3253, "lng": 114.1864, "area": "KLN"},
    "Kwun Tong":        {"aliases": ["觀塘", "观塘", "kwun tong"], "lat": 22.3134, "lng": 114.2259, "area": "KLN"},
    "Tseung Kwan O":    {"aliases": ["將軍澳", "将军澳", "tseung kwan o", "tko"], "lat": 22.3090, "lng": 114.2600, "area": "NT"},
    "Sha Tin":          {"aliases": ["沙田", "sha tin", "shatin"], "lat": 22.3809, "lng": 114.1861, "area": "NT"},
    "Tai Po":           {"aliases": ["大埔", "tai po"], "lat": 22.4510, "lng": 114.1620, "area": "NT"},
    "Tsuen Wan":        {"aliases": ["荃灣", "荃湾", "tsuen wan"], "lat": 22.3683, "lng": 114.1156, "area": "NT"},
    "Tuen Mun":         {"aliases": ["屯門", "屯门", "tuen mun"], "lat": 22.3960, "lng": 113.9750, "area": "NT"},
    "Yuen Long":        {"aliases": ["元朗", "yuen long"], "lat": 22.4420, "lng": 114.0210, "area": "NT"},
    "Kai Tak":          {"aliases": ["啟德", "启德", "kai tak"], "lat": 22.3320, "lng": 114.1930, "area": "KLN"},
    "Cyberport":        {"aliases": ["數碼港", "数码港", "cyberport"], "lat": 22.2570, "lng": 114.1290, "area": "HKI"},
    "Lantau":           {"aliases": ["大嶼山", "大屿山", "tant", "disney", "迪士尼"], "lat": 22.2950, "lng": 113.9430, "area": "NT"},
    "Sheung Shui":      {"aliases": ["上水", "sheung shui"], "lat": 22.5010, "lng": 114.1280, "area": "NT"},
}

#: "附近/近一点/nearby" — no district, radius around the user's geo hint.
NEARBY_TERMS = ["附近", "對開", "对开", "周边", "鄰近", "邻近", "nearby", "near me", "close by",
                "closeby", "行幾遠", "行几分钟", "走路"]

# ------------------------------------------------------------------ categories
CATEGORY_SYNONYMS: dict[str, list[str]] = {
    "restaurant": ["餐廳", "餐厅", "饭店", "飯店", "食店", "食飤", "食饭", "食飯", "吃饭", "吃飯", "小食", "美食", "食堂", "restaurant",
                   "dining", "eats", "food", "粉麵"],
    "cafe": ["咖啡", "咖啡店", "cafe", "coffee", "茶記", "冰室", "茶餐廳", "茶餐室", "brunch",
             "早午餐"],
    "bakery": ["餅店", "饼店", "麵包", "面包", "bakery", "cake", "蛋糕", "甜品", "dessert"],
    "bar": ["酒吧", "bar", "pub", "酒廊", "lounge", "啤酒", "cocktail", "調酒"],
    "hotpot": ["火鍋", "火锅", "hotpot", "hot pot", "打邊炉", "打邊爐", "盆菜"],
    "gym": ["健身房", "健身中心", "健身", "gym", "fitness", "weight training", "舉重",
            "體能", "体能"],
    "yoga": ["瑜伽", "yoga", "pilates", "普拉提", "伸展班"],
    "swimming": ["泳池", "游泳", "swim", "swimming", "游泳池"],
    "hotel": ["酒店", "宾馆", "賓館", "hotel", "住宿", "stay", "resort", "渡假", "度假"],
    "beauty": ["美容", "髮型", "发型", "理髮", "理发", "salon", "haircut", "美甲", "nail",
               "massage", "按摩", "spa", "水療", "水疗", "護膚", "护肤"],
    "medical": ["診所", "诊所", "dentist", "牙醫", "牙医", "clinic", "physio", "物理治療"],
    "retail": ["商店", "舖", "店", "shop", "store", "買", "买", "shopping", "百貨", "百货"],
    "footwear": ["鞋", "波鞋", "运动鞋", "運動鞋", "boots", "鞋款", "shoes", "sneaker",
                 "footwear", "雨鞋", "皮鞋"],
    "electronics": ["手機", "手机", "電話", "电话", "laptop", "電腦", "电脑", "electronics",
                    "充電", "充电", "earbuds", "耳機", "耳机"],
    "attraction": ["景點", "景点", "打卡", "好玩", "娛樂", "娱乐", "娱樂", "attraction", "things to do",
                   "play", "museum", "博物館", "博物馆", "公園", "公园", "park", "海濱", "海滨"],
    "escape_room": ["密室", "escape room", "劇本殺", "剧本杀"],
    "karaoke": ["ktv", "卡拉ok", "唱k", "karaoke"],
    "cinema": ["戲院", "戏院", "cinema", "movie", "電影", "电影"],
    "afternoon_tea": ["下午茶", "afternoon tea", "high tea", "tea time"],
    "pet": ["寵物", "宠物", "pet", "dog", "猫", "貓", "vet"],
    "cooking_class": ["煮餸班", "烹飪", "烹饪", "cooking class", "workshop", "工作坊"],
    "tutoring": ["補習", "补习", "tutor", "course", "課程", "课程", "class"],
}

#: food sub-cuisines; surfaced as `preferences`/`constraints` keys plus category=restaurant
#: The "X-style" form (\u65e5\u5f0f, \u6cf0\u5f0f, ...) is how a HK user actually asks for a
#: cuisine, and only two of the rows below carried it. These are the forms added, so the
#: rows themselves stay the single source of truth.
_CUISINE_STYLE_FORMS: dict[str, tuple[str, ...]] = {
    "japanese": ("日式", "日式菜"),
    "cantonese": ("中式", "中式菜"),
    "western": ("西式", "西式菜"),
    "italian": ("意式", "意式菜"),
    "indian": ("印度菜",),
    "malaysian": ("馬来西菜", "馬來西菜",),
    "dim_sum": ("體烏菜",),
    "seafood": ("海魚菜",),
    "vegetarian": ("素菜",),
}

CUISINE_TERMS: dict[str, list[str]] = {
    "japanese": ["日料", "日本菜", "日本料理", "壽司", "寿司", "sushi", "ramen", "拉麵", "拉面",
                 "居酒屋", "izakaya", "鐵板燒", "日籍"],
    "cantonese": ["廣東", "粤菜", "粵菜", "趙潤保", "cantonese", "茶記", "碟頭飯", "燒臘", "烧腊"],
    "korean": ["韓國", "韩国", "韓式", "韩式", "korean", "BBQ", "烤肉", "参鶏湯", "參雞湯"],
    "thai": ["泰國", "泰国", "泰式", "thai", "冬蔭", "冬阴功", "凍陳功", "som tam"],
    "italian": ["意大利", "意粉", "pasta", "italian", "薄餅", "薄饼", "pizza", "披薩", "披萨"],
    "indian": ["印度", "indian", "curry", "咖哩", "咖喱", "tandoori", "naan"],
    "western": ["牛排", "steak", "西餐", "western", "burger", "漢堡", "汉堡"],
    "vegetarian": ["素食", "齋", "vegetarian", "vegan", "純素", "纯素"],
    "seafood": ["海鮮", "海鲜", "seafood", "大排檔", "大排档", "蟹", "生蠔", "生蚝"],
    "dim_sum": ["飲茶", "饮茶", "dim sum", "dimsum", "點心", "点心", "一盅兩件"],
    "malaysian": ["馬來西亞", "马来西亚", "malaysian", "檳城", "槟城", "叻沙", "laksa"],
}

# ------------------------------------------------------------------ preferences
# (key, value, patterns, polarity) — matched anywhere in the query.
PREFERENCE_RULES: list[tuple[str, str, list[str], int]] = [
    ("ambience", "quiet", ["安靜", "安静", "靜一啲", "静一啲", "静一点", "靜一點", "靜點", "quiet",
                           "silence", "唔想太嘈", "不想太嘈", "嘈"], 1),
    ("ambience", "lively", ["熱鬧", "热闹", "lively", "气氛", "氣氛", "bustling"], 1),
    ("occasion", "date", ["約會", "约会", "情侣", "情侶", "date", "anniversary", "周年",
                          "二人世界", "romantic", "浪漫", "表白"], 1),
    ("style", "ambience", ["有情調", "有情调", "情調", "情调", "有氣氛", "有气氛",
                           "atmospheric", "vibe", "氛圍", "氛围", "格调", "格調"], 1),
    ("occasion", "group", ["朋友聚會", "朋友聚会", "聚會", "聚会", "group", "開趴", "团聚", "團聚",
                           "team building", "团建", "團建", "生日會", "生日会", "party"], 1),
    ("occasion", "family", ["親子", "亲子", "家庭", "小朋友", "kids", "children", "baby",
                            "child friendly", "一家大細"], 1),
    ("occasion", "business", ["商務", "商务", "business", "宴客", "請客", "请客", "meeting"], 1),
    ("occasion", "solo", ["一個人", "一个人", "solo", "自斟", "獨食", "独食"], 1),
    ("view", "scenic", ["海景", "維港", "维港", "景觀", "景观", "view", "skyline", "山景",
                        "天台", "天臺", "rooftop"], 1),
    ("access", "mtr_near", ["地鐵", "地铁", "mtr", "港鐵", "港铁", "駅", "站邊"], 1),
    ("access", "accessible", ["輪椅", "轮椅", "無障礙", "无障碍", "accessible", "walker"], 1),
    ("access", "parking", ["停車場", "停车场", "停泊", "泊車", "泊车", "car park", "parking",
                           "有車位", "车位", "車位"], 1),
    ("access", "pet_friendly", ["寵物", "宠物", "pet friendly", "pet-friendly", "帶狗", "带狗"], 1),
    ("price_sense", "cheap", ["平", "便宜", "cheap", "廉價", "廉价", "抵", "經濟", "经济",
                              "budget"], 1),
    ("price_sense", "premium", ["貴都無所謂", "高级", "高級", "premium", "fine dining",
                                "米芝蓮", "米其林", "michelin", "奢侈"], 1),
    ("weather", "rainy_day", ["下雨", "落雨", "雨天", "rainy", "颱風", "台风", "typhoon",
                              "潮濕", "潮湿"], 1),
    ("time_pref", "open_late", ["宵夜", "夜宵", "通宵", "深夜", "夜晚", "open late",
                                "late night", "after hours", "24小時", "24小时",
                                "夜唔閉", "瞓夜晚"], 1),
    ("cuisine", "spicy", ["辣", "香辣", "spicy", "麻辣", "咖哩", "咖喱"], 1),
    ("style", "outdoor", ["戶外", "户外", "outdoor", "露臺", "露台", "al fresco", "燒烤", "烧烤"], 1),
    ("style", "indoor", ["室內", "室内", "indoor", "有蓋", "有盖", "雨淋唔到"], 1),
]

#: every preference value the lexicon can emit (intent fallback uses this)
PREFERENCE_RULE_VALUES = [canonical(v) for _k, v, _t, _p in PREFERENCE_RULES]

# The style forms join their rows, so a row read anywhere carries the whole vocabulary.
for _cuisine, _forms in _CUISINE_STYLE_FORMS.items():
    _row = CUISINE_TERMS.get(_cuisine)
    if _row is None:
        continue
    for _form in _forms:
        if _form not in _row:
            _row.append(_form)


#: The cuisine the user names -> the seeded taxonomy leaves that satisfy it.
#:
#: The lexicon speaks the user's word ("japanese") while the seed stores the venue's
#: leaf ("sushi", "ramen", "izakaya"). Without this map a cuisine preference that IS
#: satisfied by the merchant never fires, and a satisfied preference is then the same
#: as an unsatisfied one (D394). The leaves are the ones `data/seed/seed_pools.py`'s
#: `CAT_TREE` writes; a leaf not listed here is matched by its own name.
CUISINE_LEAVES: dict[str, tuple[str, ...]] = {
    "cantonese": ("cantonese",),
    "dim_sum": ("dimsum",),
    "seafood": ("seafood-grill",),
    "japanese": ("sushi", "ramen", "izakaya"),
    "korean": ("korean",),
    "thai": ("thai",),
    "indian": ("indian",),
    "italian": ("italian",),
    "western": ("western-grill",),
    "malaysian": ("singmal",),
    "vegetarian": ("vegetarian",),
    "specialty-coffee": ("specialty-coffee",),
}


def cuisine_leaves(cuisine: str) -> tuple[str, ...]:
    """The seeded leaves that satisfy a named cuisine (D394).

    An unknown cuisine is matched by its own name, which is the right default: a cuisine the
    taxonomy does not know is still a word a merchant may carry in its tags.
    """
    key = (cuisine or "").strip().lower()
    return CUISINE_LEAVES.get(key, (key,) if key else ())


def cuisine_matches(cuisine: str, category: str, tags: list[str]) -> bool:
    """Whether a merchant's taxonomy carries a named cuisine (D394).

    Both sides are normalized (case, and the separators `_`/`-`/space) so "dim_sum" and
    "dimsum" are the same word, and the comparison is by leaf rather than by substring:
    a cuisine name must not match a merchant whose tag merely contains the letters.
    """
    leaves = cuisine_leaves(cuisine)
    if not leaves:
        return False
    norm_cat = _normalize_token(category)
    norm_tags = {_normalize_token(str(t)) for t in tags}
    for leaf in leaves:
        norm_leaf = _normalize_token(leaf)
        if not norm_leaf:
            continue
        if norm_leaf in norm_tags:
            return True
        if norm_leaf in norm_cat:
            return True
    return False


def _normalize_token(value: str) -> str:
    """Case-fold a taxonomy token and drop the separators, so "dim_sum", "dim-sum" and
    "dimsum" are one word (D394)."""
    out = []
    for ch in (value or "").lower():
        if ch.isalnum():
            out.append(ch)
    return "".join(out)

# ------------------------------------------------------------------ constraints (negated)
CONSTRAINT_RULES: list[tuple[str, list[str], list[str]]] = [
    # (key, negation cues, value patterns)
    ("cuisine_avoid", ["唔食", "不吃", "不吃", "唔想", "不想", "不要", "唔要", "別", "别", "避免",
                       "no ", "not ", "without", "avoid", "少"], ["辣", "spicy", "curry"]),
    ("diet_avoid", ["唔食", "不吃", "不要", "唔想", "不想", "避免", "no ", "without", "avoid"],
     ["豬", "猪", "pork", "牛", "beef", "海鮮", "海鲜", "seafood", "香菜", "cilantro",
      "花生", "peanut", "蔥", "葱", "onion", "蒜", "garlic", "奶", "dairy", "gluten", "麩"]),
    ("smoking_avoid", ["唔想", "不想", "不要", "no ", "avoid"], ["煙", "烟", "smoking", "二手煙"]),
    ("noise_avoid", ["唔想", "不想", "不要", "避免", "no ", "avoid"], ["嘈", "吵", "noise", "吵鬧"]),
    ("feature_avoid", ["唔想", "不想", "不要", "避免", "no ", "avoid"],
     ["排隊", "排队", "queue", "長龍", "长龙"]),
]

# D417: the derived lists are derived in the CANONICAL spelling, so they agree with
# the tables they are derived from (which are canonicalised at import, below).
NEGATION_CUES = [canonical(c) for row in CONSTRAINT_RULES for c in row[1]]

# ------------------------------------------------------------------ urgency
URGENCY_NOW = ["而家", "现在", "現正", "立刻", "马上", "馬上", "now", "asap", "急", "今晚", "今日"]
URGENCY_FLEXIBLE = ["得閒", "得闲", "有空", "隨時", "随时", "anytime", "next week", "下週",
                    "下周", "来週", "月底"]

# ------------------------------------------------------------------ sorting hints
SORT_RULES: list[tuple[str, list[str]]] = [
    ("distance", ["近", "closest", "nearest", "距離", "距离", "nearby", "少行", "行幾耐"]),
    ("price_low", ["平", "cheap", "最平", "便宜", "low price", "under", "以下", "以內", "以内"]),
    ("rating", ["好評", "好评", "最佳", "rating", "頂尖", "顶尖", "最受歡迎", "评分", "評分", "最高分"]),
    ("trending", ["熱門", "热门", "trending", "人气", "人氣", "最受歡迎", "最受欢迎的"]),
]

# ------------------------------------------------------------------ entity hints
COMPARE_CUES = ["比較", "比较", "対比", "对比", "contrast", "compare", "邊個", "边个", "邊間",
                "边间", "which", "vs", "versus", "同", "好過"]
RESERVE_CUES = ["預約", "预约", "book", "reserve", "订", "訂", "留位", "劃位", "reservation",
                "make a table", "a table", "table for", "取飛", "排位", "訂枱", "订台"]
PURCHASE_CUES = ["買", "买", "purchase", "buy", "want to get", "想入手", "入手", "訂購", "订购",
                 "下單", "下单", "order"]
ASK_MERCHANT_CUES = ["開唔開", "营业吗", "營業嗎", "有無", "有无", "有冇", "幾點", "几点",
                     "幾時", "几时", "how much", "多少錢", "多少钱", "question",
                     "問", "问", "可唔可以", "能不能", "支唔支持", "支持嗎", "退不退",
                     "有停泊", "泊车", "泊車", "wifi", "Wi-Fi", "收唔收到"]
PLAN_CUES = ["行程", "一日", "半日", "itinerary", "plan", "路線", "路线", "安排", "play day",
             "一整日", "玩成日", "budget a day", "點玩", "点玩"]
DISCOVER_CUES = ["搵", "找", "推荐", "推薦", "建議", "建议", "find", "recommend", "suggest",
                 "有冇", "有無", "where", "边度", "哪裡", "哪里", "any", "place", "地方", "去邊"]

ASSUMED_TOKENS = {"the", "a", "an", "for", "to", "of", "in", "at", "i", "want", "me", "please"}


def detect_language(text: str) -> str:
    """zh-HK (traditional, default), zh-CN (simplified) or en — AGENT_CONTRACT §12."""
    if not text:
        return "zh-HK"
    cjk = re.findall(r"[㐀-鿿]", text)
    if not cjk:
        return "en"
    simp = sum(1 for ch in cjk if ch in SIMPLIFIED_MARKERS)
    trad = sum(1 for ch in cjk if ch in TRADITIONAL_MARKERS)
    if simp == trad == 0:
        return "zh-HK"                      # market default
    if simp > trad:
        return "zh-CN"
    if trad > 0:
        return "zh-HK"
    return "zh-CN" if simp > 0 else "zh-HK"


#: Traditional vs simplified markers, built from explicit differing pairs so a
#: shared character (餐/吃/情) can never vote for the wrong locale.
_TRAD_SIMP_PAIRS: tuple[tuple[str, str], ...] = (
    ("場", "场"),
    ("館", "馆"),
    ("臺", "台"),
    ("樓", "楼"),
    ("層", "层"),
    ("號", "号"),
    ("們", "们"),
    ("讓", "让"),
    ("說", "说"),
    ("話", "话"),
    ("請", "请"),
    ("還", "还"),
    ("遠", "远"),
    ("臨", "临"),
    ("複", "复"),
    ("雜", "杂"),
    ("簡", "简"),
    ("單", "单"),
    ("價", "价"),
    ("優", "优"),
    ("預", "预"),
    ("約", "约"),
    ("際", "际"),
    ("標", "标"),
    ("準", "准"),
    ("網", "网"),
    ("絡", "络"),
    ("設", "设"),
    ("備", "备"),
    ("車", "车"),
    ("輛", "辆"),
    ("動", "动"),
    ("產", "产"),
    ("東", "东"),
    ("灣", "湾"),
    ("樂", "乐"),
    ("發", "发"),
    ("電", "电"),
    ("腦", "脑"),
    ("體", "体"),
    ("國", "国"),
    ("學", "学"),
    ("問", "问"),
    ("務", "务"),
    ("實", "实"),
    ("員", "员"),
    ("區", "区"),
    ("間", "间"),
    ("會", "会"),
    ("為", "为"),
    ("於", "于"),
    ("來", "来"),
    ("對", "对"),
    ("廳", "厅"),
    ("飲", "饮"),
    ("飯", "饭"),
    ("湯", "汤"),
    ("雞", "鸡"),
    ("麵", "面"),
    ("線", "线"),
    ("積", "积"),
    ("幫", "帮"),
    ("適", "适"),
    ("侶", "侣"),
    ("靜", "静"),
    ("圖", "图"),
    ("書", "书"),
    ("馬", "马"),
    ("鳥", "鸟"),
    ("魚", "鱼"),
    ("鴨", "鸭"),
    ("協", "协"),
    ("佔", "占"),
    ("廣", "广"),
    ("莊", "庄"),
    ("術", "术"),
    ("極", "极"),
    ("構", "构"),
    ("靈", "灵"),
    ("點", "点"),
    ("風", "风"),
    ("雲", "云"),
    ("龍", "龙"),
    ("鳳", "凤"),
    ("門", "门"),
    ("飛", "飞"),
    ("時", "时"),
    ("邊", "边"),
    ("個", "个"),
    ("與", "与"),
    ("開", "开"),
    ("關", "关"),
    ("機", "机"),
    ("覺", "觉"),
    ("愛", "爱"),
    ("義", "义"),
    ("禮", "礼"),
    ("質", "质"),
    ("則", "则"),
    ("計", "计"),
    ("劃", "划"),
    ("飾", "饰"),
    ("騎", "骑"),
    ("證", "证"),
    ("驚", "惊"),
    ("顯", "显"),
    ("藝", "艺"),
    ("節", "节"),
    ("範", "范"),
    ("築", "筑"),
    ("尋", "寻"),
    ("亞", "亚"),
    ("葉", "叶"),
    ("張", "张"),
    ("強", "强"),
    ("漢", "汉"),
    ("溝", "沟"),
    ("塗", "涂"),
    ("漲", "涨"),
    ("潤", "润"),
    ("燈", "灯"),
    ("爐", "炉"),
    ("爛", "烂"),
    ("頁", "页"),
    ("頂", "顶"),
    ("須", "须"),
    ("順", "顺"),
    ("頌", "颂"),
    ("頰", "颊"),
    ("題", "题"),
    ("顏", "颜"),
    ("額", "额"),
    ("飯", "饭"),
    ("飾", "饰"),
    ("騙", "骗"),
    ("醫", "医"),
    ("華", "华"),
    ("幣", "币"),
    ("帥", "帅"),
    ("師", "师"),
    ("帳", "帐"),
    ("幹", "干"),
    ("紀", "纪"),
    ("並", "并"),
)

SIMPLIFIED_MARKERS = frozenset(s for _t, s in _TRAD_SIMP_PAIRS)
TRADITIONAL_MARKERS = frozenset(t for t, _s in _TRAD_SIMP_PAIRS)


def match_district(text: str) -> tuple[str, dict[str, Any]] | None:
    from nexus_ai.nlu.canonical import canonical

    low = canonical(text).lower()
    best: tuple[int, str, dict[str, Any]] | None = None
    for name, spec in DISTRICTS.items():
        for alias in [name, *spec["aliases"]]:
            a = alias.lower()
            if a and a in low:
                if best is None or len(a) > best[0]:
                    best = (len(a), name, spec)
    return (best[1], best[2]) if best else None


def match_category(text: str) -> tuple[str, float] | None:
    """Return (category, confidence). Confidence 0.95 for a direct hit, lower for the
    generic `retail`/`attraction` fallbacks so the model never over-claims.

    CJK puts the head noun last ("可带宠物**的餐厅**"), so when several categories match the
    **rightmost** one wins; ties break on term length (more specific) and then alphabetically
    for determinism. Without this, a preference token such as 宠物 would hijack the category.
    """
    from nexus_ai.nlu.canonical import canonical

    low = canonical(text).lower()
    hits: list[tuple[int, int, str]] = []
    for cat, terms in CATEGORY_SYNONYMS.items():
        longest = 0
        rightmost = -1
        for term in terms:
            t = term.lower().strip()
            idx = low.rfind(t) if t and t in low else -1
            if idx >= 0:
                longest = max(longest, len(t))
                rightmost = max(rightmost, idx + len(t))
        if longest:
            hits.append((rightmost, longest, cat))
    if not hits:
        return None
    hits.sort(key=lambda x: (-x[0], -x[1], x[2]))
    specific = [h for h in hits if h[2] not in ("retail", "attraction", "restaurant")
                and h[1] >= 2]
    rightmost, best_len, best_cat = (specific or hits)[0]
    generic = best_cat in ("retail", "attraction", "restaurant")
    return best_cat, (0.7 if generic and best_len <= 2 else 0.95)


def match_cuisines(text: str) -> list[str]:
    from nexus_ai.nlu.canonical import canonical

    low = canonical(text).lower()
    return [c for c, terms in CUISINE_TERMS.items() if any(t.lower() in low for t in terms)]


def normalize_query(text: str) -> str:
    """Lowercase ASCII, collapse whitespace, strip light punctuation but keep CJK + digits.

    A colon between digits is kept: "7:30pm" is a clock time, not punctuation.

    D420: this does NOT canonicalise the spelling, and that is the point. The locale
    detection works by looking for the simplified and the traditional MARKERS, so a
    canonicalised text would arrive at the detector without them: a user who writes
    Simplified Chinese would be answered in the Traditional locale (measured: 预算三百元
    detected zh-CN on the raw text and zh-HK on the canonical one). The canonicalisation
    is applied where the VOCABULARY is compared - the matchers and the cue matching - and
    the text that goes to SQL keeps the user's own spelling.
    """
    cleaned = re.sub(r"(?<!\d)[:：](?!\d)", " ", text or "")
    cleaned = re.sub(r"[，。！？；、,.!?;~（）()\[\]{}<>《》]+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


MONEY_RE = re.compile(
    r"(?:HK\$|HKD|港币|港幣|\$|￥|人民币)?\s*(\d{2,5})(?:\.\d{1,2})?\s*"
    r"(?:港?幣|币|dollar|dollars|HKD)?",
    re.IGNORECASE,
)


# ------------------------------------------------------------------ entity hints
#: constraint surface forms -> canonical ascii value, so "唔食辣" and "no spicy" merge
CONSTRAINT_CANON = {
    "辣": "spicy", "spicy": "spicy", "curry": "curry", "咖哩": "curry", "咖喱": "curry",
    "豬": "pork", "猪": "pork", "pork": "pork", "牛": "beef", "beef": "beef",
    "海鮮": "seafood", "海鲜": "seafood", "seafood": "seafood", "香菜": "coriander",
    "cilantro": "coriander", "coriander": "coriander", "花生": "peanut", "peanut": "peanut",
    "蔥": "onion", "葱": "onion", "onion": "onion", "蒜": "garlic", "garlic": "garlic",
    "奶": "dairy", "dairy": "dairy", "gluten": "gluten", "煙": "smoking", "烟": "smoking",
    "smoking": "smoking", "排隊": "queue", "排队": "queue", "queue": "queue",
}


def canon_constraint(value: str) -> str:
    v = (value or "").strip()
    return CONSTRAINT_CANON.get(v, CONSTRAINT_CANON.get(v.lower(), v.lower() or v))


def quoted_entities(text: str) -> list[str]:
    """「名字」 / "name" — an entity the user pointed at explicitly."""
    return re.findall(r"[「」\"']([^」\"'，。]{2,40})[」\"']", text or "")


def proper_nouns(text: str) -> list[str]:
    """Capitalised latin runs — the naming convention the seeded demo data follows (§109)."""
    stop = {"the", "what", "where", "which", "compare", "vs", "and", "find", "recommend",
            "hk", "hkd", "i"}
    out: list[str] = []
    for m in re.finditer(r"[A-Z][A-Za-z&'’.\-]{2,28}(?:[A-Za-z)][A-Z][A-Za-z&'’.\-]*)?",
                         text or ""):
        cand = m.group(0).strip(" .,-")
        if len(cand) < 3 or cand.lower() in stop:
            continue
        out.append(cand)
    return out


# --------------------------------------------------------------------------- D417
#: The vocabulary's tables, canonicalised at import. A term written in either spelling is
#: the same term, so the matchers answer to both. The tables are REBOUND (not edited in
#: place) so that the canonicalisation is visible in one place and the tables above stay
#: readable.
_CANONICALISED_TABLES = (
    "CATEGORY_SYNONYMS", "CUISINE_TERMS", "SORT_RULES", "CONSTRAINT_RULES", "DISTRICTS",
    "PREFERENCE_RULES", "PREFERENCE_CUES", "PREFERENCE_RULE_VALUES", "COMPARE_CUES",
    "DISCOVER_CUES", "RESERVE_CUES", "PURCHASE_CUES", "ASK_MERCHANT_CUES", "PLAN_CUES",
    "NEARBY_TERMS", "OPEN_PRICE_WORDS", "CONSTRAINT_CANON",
)


def _canonical_node(node):
    """Canonicalise every string in a table, and drop the duplicates it creates."""
    from nexus_ai.nlu.canonical import canonical

    if isinstance(node, str):
        return canonical(node)
    if isinstance(node, list):
        # The canonicalisation changes the SPELLING, not the structure: a list that held
        # the same cue twice still holds it twice, so every derived list and every test
        # that compares them still compares the same shape.
        return [_canonical_node(item) for item in node]
    if isinstance(node, tuple):
        return tuple(_canonical_node(item) for item in node)
    if isinstance(node, dict):
        return {_canonical_node(k): _canonical_node(v) for k, v in node.items()}
    return node


def _canonicalise_vocabulary() -> None:
    """Put every vocabulary term in the canonical spelling (D417)."""
    import sys

    module = sys.modules[__name__]
    for name in _CANONICALISED_TABLES:
        table = getattr(module, name, None)
        if table is None:
            continue
        setattr(module, name, _canonical_node(table))
    # The DERIVED lists (NEGATION_CUES, PREFERENCE_RULE_VALUES) are built in the
    # canonical spelling where they are defined, so they agree with the tables they come
    # from - a list built from the pre-canonicalisation rows would keep the old
    # spelling, and a test that compares the two would be comparing two vocabularies.


_canonicalise_vocabulary()
