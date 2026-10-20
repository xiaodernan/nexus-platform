#!/usr/bin/env python3
# SYNTHETIC DEMO DATA - NOT REAL BUSINESSES
"""Domain content pools for the NEXUS seed generator (pure data, stdlib only).

Everything in here is invented.  Brand names, streets, dishes and review sentences are
generated from these pools by generate.py; they must never be presented as real Hong Kong
business information (spec §109, §155 / DECISIONS.md D6).
"""
from __future__ import annotations

DISCLAIMER = "SYNTHETIC DEMO DATA - NOT REAL BUSINESSES"
DISCLAIMER_UNI = "SYNTHETIC DEMO DATA — NOT REAL BUSINESSES"
DEMO_URI = "demo://seed"
PASSWORD_HASH_PLACEHOLDER = "!!DEMO-PLACEHOLDER-NOT-A-PASSWORD-HASH!!"

# --------------------------------------------------------------------------- honesty blocklist
# Real, well-known HK chains / venues.  A generated name that contains any of these aborts the
# build, and quality.sql re-checks the loaded rows against the same list.
REAL_HK_BLOCKLIST = [
    "美心", "翠華", "翠华", "大快活", "大家樂", "大家乐", "太興", "太兴", "聖安娜", "奇趣坊",
    "許留山", "许留山", "滿記", "满记", "元谷", "大元茶餐厅", "八珍", "蓮香", "莲香", "陸羽",
    "蘭芳園", "兰芳园", "澳洲牛奶公司", "鎅記", "潘祥記", "奇華", "大班麵包", "半島酒店",
    "利苑", "金鳳茶餐延", "維多利亞", "太平館", "城門河", "荷里活廣場", "又一城", "新城市廣場",
    "海底撈", "海底捞", "Starbucks", "McDonald", "KFC", "Pizza Hut", "PizzaExpress", "成本屋",
    "藏壽司", "Sushi Rakuzo", "8度海逸", "帝京", "半島", "群記", "佔記", "安格斯", "王仔西餅",
    "蓮香樓", "天花酒", "富臨", "百國", "稻香", "東江", "泰昌", "鉅記", "咀香", "沙嗲",
    "添好運", "Tim Ho Wan", "Cafe de Coral", "Fairwood", "Maxim", "Pacific Coffee",
    "Zusso", "%Arabica", "Shake Shack", "Häagen", "Mama", "Wyllie", "Vina", "Granville",
    "The Pawn", "Headlines", "Laff", "Barachi", "Belon", "Ici", "Arbor", "Rosewood",
]

# --------------------------------------------------------------------------- geography
# (slug, en, zh, area, lat, lng, mtr_en, mtr_zh, scatter_m, weight)
# Centroids are real district/MTR coordinates — used so "near me" geography behaves sensibly.
# All street addresses built on top of them are invented.  Sha Tin + Tai Wai carry ~65% of the
# weight so the §94 cold-start rule (one dense geography: >=300 merchants within 3km) always holds.
DISTRICTS = [
    ("sha-tin", "Sha Tin", "沙田", "NT", 22.3831, 114.1876, "Sha Tin", "沙田", 380, 560),
    ("tai-wai", "Tai Wai", "大圍", "NT", 22.3696, 114.1784, "Tai Wai", "大圍", 360, 360),
    ("ma-on-shan", "Ma On Shan", "馬鞍山", "NT", 22.4085, 114.2264, "Ma On Shan", "馬鞍山", 500, 80),
    ("tsuen-wan", "Tsuen Wan", "荃灣", "NT", 22.3641, 114.1100, "Tsuen Wan", "荃灣", 450, 35),
    ("tai-po", "Tai Po", "大埔", "NT", 22.4512, 114.1634, "Tai Po Market", "大埔墟", 500, 30),
    ("tuen-mun", "Tuen Mun", "屯門", "NT", 22.3968, 113.9764, "Tuen Mun", "屯門", 550, 25),
    ("sheung-shui", "Sheung Shui", "上水", "NT", 22.5040, 114.1290, "Sheung Shui", "上水", 500, 15),
    ("kowloon-bay", "Kowloon Bay", "九龍灣", "KLN", 22.3228, 114.2098, "Kowloon Bay", "九龍灣", 450, 40),
    ("kwun-tong", "Kwun Tong", "觀塘", "KLN", 22.3125, 114.2271, "Kwun Tong", "觀塘", 450, 45),
    ("tsim-sha-tsui", "Tsim Sha Tsui", "尖沙咀", "KLN", 22.2941, 114.1711, "Tsim Sha Tsui", "尖沙咀", 400, 55),
    ("mong-kok", "Mong Kok", "旺角", "KLN", 22.3193, 114.1694, "Mong Kok", "旺角", 380, 50),
    ("central", "Central", "中環", "HKI", 22.2815, 114.1582, "Central", "中環", 380, 45),
    ("wan-chai", "Wan Chai", "灣仔", "HKI", 22.2775, 114.1723, "Wan Chai", "灣仔", 380, 25),
    ("causeway-bay", "Causeway Bay", "銅鑼灣", "HKI", 22.2805, 114.1851, "Causeway Bay", "銅鑼灣", 380, 35),
    ("stanley", "Stanley", "赤柱", "HKI", 22.2180, 114.1750, "Central (bus 6/6X)", "中環(巴士6/6X)", 400, 20),
]
DIST_BY_SLUG = {d[0]: d for d in DISTRICTS}
SHA_TIN_CENTROID = (22.3831, 114.1876)   # cold-start density anchor, spec §94

ADJACENT = {
    "sha-tin": ["tai-wai", "ma-on-shan", "sha-tin", "sha-tin"],
    "tai-wai": ["sha-tin", "ma-on-shan", "tai-wai", "tai-wai"],
    "ma-on-shan": ["tai-wai", "sha-tin", "ma-on-shan"],
    "tsuen-wan": ["tsuen-wan", "tsuen-wan", "tai-po"],
    "tai-po": ["ma-on-shan", "sheung-shui", "tai-po"],
    "tuen-mun": ["tuen-mun"],
    "sheung-shui": ["tai-po", "sheung-shui"],
    "kowloon-bay": ["kwun-tong", "kowloon-bay", "kowloon-bay"],
    "kwun-tong": ["kowloon-bay", "kwun-tong"],
    "tsim-sha-tsui": ["mong-kok", "tsim-sha-tsui", "tsim-sha-tsui"],
    "mong-kok": ["tsim-sha-tsui", "mong-kok"],
    "central": ["wan-chai", "central", "central"],
    "wan-chai": ["causeway-bay", "central", "wan-chai"],
    "causeway-bay": ["wan-chai", "causeway-bay"],
    "stanley": ["stanley", "central"],
}

STREET_EN_HEAD = ["Po", "Ning", "Tai", "Chuk", "Luk", "Hom", "Tin", "Wong", "Shek", "Nam",
                  "Kwai", "Kam", "On", "Yee", "Lok", "Shing", "Hing", "Wah", "Mei", "Chun",
                  "Lai", "Fu", "Kwong", "Sing", "Yuen", "Tung", "Kok", "Man", "Heung", "Sze"]
STREET_EN_SUF = ["Street", "Road", "Lane", "Avenue", "Way", "Circuit"]
STREET_ZH_HEAD = ["寶", "寧", "大", "竹", "陸", "漢", "田", "黃", "石", "南", "奎", "甘", "安",
                  "宜", "樂", "成", "興", "華", "美", "春", "利", "富", "光", "園", "東", "角",
                  "文", "鄉", "翠", "瑞"]
STREET_ZH_SUF = ["道", "街", "里", "徑", "圍", "巷"]
BLDG_EN = ["Centre", "Building", "Commercial Building", "Plaza", "Industrial Centre",
           "House", "Court", "Terrace", "Gallery", "Workshop"]
BLDG_ZH = ["中心", "大廈", "商業大廈", "廣場", "工業中心", "大廈", "雅苑", "豪庭", "藝軒", "工場"]

NAME_ZH_1 = ["金", "玉", "翠", "海", "星", "月", "龍", "鳳", "南", "喜", "樂", "雅", "御", "福",
             "祥", "百", "千", "小", "大", "東", "西", "雲", "竹", "松", "蓮", "杏", "晴", "朗",
             "悅", "暉", "誠", "嘉", "譽", "彩", "華", "富", "貴", "瑞", "尚", "漫", "拾", "半",
             "老", "新", "沙", "田", "威", "景", "曉", "天", "明", "昌", "盛", "豐", "和", "春",
             "秋", "初", "映", "望", "知", "守", "味", "香", "鍋", "城", "灣", "山", "林", "園",
             "谷", "峰", "汀", "澤", "熙", "裕", "鼎", "恩", "晞", "沅", "瀚", "樺", "楓", "朗"]
NAME_ZH_2 = ["苑", "閣", "居", "軒", "堂", "記", "坊", "屋", "庭", "園", "館", "莊", "味", "香",
             "灶", "棧", "季", "集", "里", "町", "廚", "舫", "堤", "舍", "嶺", "澗", "埔", "甬",
             "薈", "峰", "海", "光", "薈", "軒"]
NAME_EN_1 = ["Amber", "Copper", "Jade", "Crimson", "Paper", "Lantern", "Banyan", "Saltbush",
             "Harbour", "Mint", "Marble", "Saffron", "Tamarind", "Pomelo", "Ginger", "Clay",
             "Ember", "Mistral", "Cove", "Orchid", "Cinder", "Alder", "Bramble", "Quartz",
             "Willow", "Cardamom", "Basil", "Nori", "Sable", "Verdant", "Kiln", "Meridian",
             "Pine", "Rocky", "Silver", "Umber", "Vertex", "Wisteria", "Zenith", "Cedar"]
NAME_EN_2 = ["Kitchen", "Table", "House", "Room", "Fire", "Pot", "Spoon", "Grill", "Bowl",
             "Still", "Foundry", "Pantry", "Corner", "Stop", "Bar", "Studio", "Works", "Lab",
             "Den", "Gate", "Leaf", "Stone", "Bay", "Ridge", "Spring", "Veranda"]
NAME_SUFFIX_ZH = {
    "restaurant": ["酒家", "廚房", "餐室", "小廚", "麵家", "冰室", "食館", "火鍋間"],
    "cafe": ["咖啡", "烘焙", "茶室", "甜品", "咖啡室"],
    "bar": ["酒吧", "酒館", "清吧", "小酒館"],
    "fitness": ["健身會所", "體適能中心", "瑜伽室", "運動空間"],
    "beauty": ["美髮屋", "美甲工作室", "養生館", "美容護理", "理髮室"],
    "activity": ["娛樂中心", "康樂會", "遊戲天地", "運動館"],
    "hotel": ["酒店", "客棧", "服務式住宅", "渡假屋"],
    "experience": ["工作室", "體驗館", "導賞社", "學堂"],
    "shopping": ["手信", "小舖", "選物店", "茶莊", "糕餅"],
    "service": ["洗衣店", "護理坊", "維修站", "服務中心", "相廊"],
}

# --------------------------------------------------------------------------- category tree
# (top slug, en, zh, [(leaf slug, en, zh)])
CAT_TREE = [
    ("restaurant", "Restaurants", "餐延", [
        ("cantonese", "Cantonese", "粵菜"), ("dimsum", "Dim Sum", "點心"),
        ("cha-chan-teng", "Cha Chaan Teng", "茶餐延"), ("siu-mei", "Roast Meats", "燒味"),
        ("hotpot", "Hot Pot", "火鍋"), ("seafood-grill", "Seafood & BBQ", "海鮮燒烤"),
        ("sushi", "Sushi & Sashimi", "壽司刺身"), ("ramen", "Ramen & Noodles", "拉麵粉麵"),
        ("izakaya", "Izakaya", "居酒屋"), ("korean", "Korean", "韓國菜"),
        ("thai", "Thai", "泰國菜"), ("vietnamese", "Vietnamese", "越南菜"),
        ("indian", "Indian", "印度菜"), ("western-grill", "Steakhouse", "西式扒房"),
        ("italian", "Italian", "意大利菜"), ("euro", "European Bistro", "歐陸菜"),
        ("singmal", "Malaysian & Singaporean", "星馬菜"), ("vegetarian", "Vegetarian", "素食"),
        ("homey", "Noodle & Rice Diner", "粉麵飯家"), ("fusion", "Fusion", "融合菜"),
    ]),
    ("cafe", "Cafes & Tea", "咖啡茶座", [
        ("specialty-coffee", "Specialty Coffee", "特式咖啡"),
        ("bakery-dessert", "Bakery & Dessert", "烘焙甜品"),
        ("tea-house", "Tea House", "茶室"), ("bubble-tea", "Bubble Tea", "手搖飲品"),
    ]),
    ("bar", "Bars & Nightlife", "酒吧夜生活", [
        ("cocktail-bar", "Cocktail Bar", "鸡尾酒廊"), ("sports-pub", "Sports Pub", "運動酒吧"),
        ("wine-bar", "Wine Bar", "紅酒酒吧"), ("live-music", "Live Music Bar", "音樂酒吧"),
    ]),
    ("fitness", "Fitness", "運動健身", [
        ("gym-club", "Gym Club", "健身會所"), ("yoga-pilates", "Yoga & Pilates", "瑜伽普拉提"),
        ("climbing", "Climbing Gym", "攀石館"), ("swimming", "Swimming Centre", "游泳會"),
        ("martial-arts", "Martial Arts", "武術班"), ("personal-training", "Personal Training", "私人教練"),
    ]),
    ("beauty", "Beauty & Wellness", "美容護理", [
        ("hair-salon", "Hair Salon", "髮型屋"), ("barber", "Barber", "理髮師"),
        ("nail-salon", "Nail Salon", "美甲店"), ("spa-massage", "Spa & Massage", "水療按摩"),
        ("skin-clinic", "Skin Care Studio", "皮膚護理"), ("lash-brow", "Lash & Brow", "睫毛紋眉"),
    ]),
    ("activity", "Activities", "康樂活動", [
        ("bowling", "Bowling", "保齡球"), ("board-game", "Board Game Cafe", "桌遊咖啡"),
        ("escape-room", "Escape Room", "密室逃脫"), ("karaoke", "Karaoke", "K歌房間"),
        ("badminton", "Badminton Centre", "羽球場"), ("paint-sip", "Art & Wine Class", "繪畫工作坊"),
    ]),
    ("hotel", "Hotels & Stays", "酒店住宿", [
        ("boutique-hotel", "Boutique Hotel", "精品酒店"),
        ("serviced-apartment", "Serviced Apartment", "服務式住宅"),
        ("hostel", "Hostel", "青年旅舍"), ("resort", "Resort", "渡假村"),
    ]),
    ("experience", "Experiences", "探索體驗", [
        ("culture-tour", "Heritage Tour", "文化導賞"), ("hiking-tour", "Hiking Tour", "行山團"),
        ("food-tour", "Food Tour", "美食導覽"), ("craft-workshop", "Craft Workshop", "手作工作坊"),
        ("photo-tour", "Photo Walk", "攝影團"), ("sailing", "Sailing & Kayak", "帆船獨木舟"),
    ]),
    ("shopping", "Shopping", "特色購物", [
        ("local-snacks", "Local Snacks", "在地餅食"), ("design-store", "Design Store", "設計選物"),
        ("bookshop", "Bookshop", "書店"), ("tea-shop", "Tea & Herbs", "茶葉參茸"),
        ("wet-market", "Market Specialty", "街市專賣"),
    ]),
    ("service", "Local Services", "生活服務", [
        ("laundry", "Laundry", "洗衣乾洗"), ("pet-grooming", "Pet Grooming", "寵物美容"),
        ("phone-repair", "Phone Repair", "手機維修"), ("photo-studio", "Photo Studio", "相館"),
        ("tailor", "Tailor", "裁縫改衫"), ("home-cleaning", "Home Cleaning", "居家清潔"),
    ]),
]
CAT_LEAVES = {leaf[0]: (top[0], leaf) for top in CAT_TREE for leaf in top[3]}
TOP_NAMES = {t[0]: (t[1], t[2]) for t in CAT_TREE}
LEAF_CUISINE_EN = {leaf[0]: leaf[1] for top in CAT_TREE for leaf in top[3]}
LEAF_CUISINE_ZH = {leaf[0]: leaf[2] for top in CAT_TREE for leaf in top[3]}

# --------------------------------------------------------------------------- opening hours profiles
# blocks of (open_h, open_m, close_h, close_m); close >= 24 means it crosses midnight.
HOURS_PROFILES = {
    "rest": [(11, 30, 15, 0), (18, 0, 22, 30)],
    "rest-late": [(12, 0, 15, 0), (18, 0, 23, 30)],
    "cct": [(7, 0, 23, 0)],
    "cafe": [(7, 30, 18, 30)],
    "tea": [(10, 0, 20, 0)],
    "bar": [(18, 0, 26, 0)],
    "gym": [(6, 30, 22, 30)],
    "class": [(9, 0, 21, 0)],
    "salon": [(10, 0, 20, 0)],
    "spa": [(11, 0, 21, 0)],
    "hotel": [(0, 0, 23, 59)],
    "act": [(10, 0, 22, 0)],
    "exp": [(9, 0, 18, 0)],
    "shop": [(11, 0, 20, 0)],
    "svc": [(9, 0, 19, 0)],
}

# --------------------------------------------------------------------------- catalogue behaviour
# items: offerings per merchant, ticket: typical HKD per head/session, band: price multiplier tier,
# pool: (resource kind, cap lo, cap hi), slots: (session label, [times]) per open day.
LEAF_SPEC: dict[str, dict] = {}

_COMMON = dict(book=False, pool=(), slots=(), price_model="fixed", unit=None)


def _spec(leaves, top, **kw):
    for s in leaves:
        d = dict(_COMMON)
        d["top"] = top
        d.update(kw)
        LEAF_SPEC[s] = d


_TABLE_SLOTS = (("lunch", ["11:30", "12:00", "12:30", "13:00"]),
                ("dinner", ["18:00", "18:30", "19:00", "19:30", "20:00"]))

_spec(["cantonese", "dimsum", "seafood-grill", "homey"], "restaurant",
      items=(9, 15), ticket=(48, 260), hours="rest", book=True, pool=("table", 2, 12),
      slots=_TABLE_SLOTS, band=2)
_spec(["cha-chan-teng", "siu-mei"], "restaurant",
      items=(10, 16), ticket=(20, 78), hours="cct", pool=("table", 2, 8),
      slots=(("lunch", ["12:00", "12:30"]), ("dinner", ["18:30", "19:00"])), band=1)
_spec(["hotpot"], "restaurant", items=(11, 17), ticket=(68, 320), hours="rest-late", book=True,
      pool=("table", 4, 10), price_model="from_price", band=3,
      slots=(("dinner", ["18:00", "18:30", "19:00", "19:30", "20:00"]), ("lunch", ["12:00", "12:30"])))
_spec(["sushi", "izakaya"], "restaurant", items=(10, 16), ticket=(38, 258), hours="rest-late",
      book=True, pool=("table", 2, 10), band=3,
      slots=(("dinner", ["18:30", "19:00", "19:30", "20:00"]), ("lunch", ["12:00"])))
_spec(["ramen", "korean", "thai", "vietnamese", "indian", "singmal", "fusion", "vegetarian"],
      "restaurant", items=(8, 14), ticket=(48, 198), hours="rest", book=True,
      pool=("table", 2, 10), band=2,
      slots=(("lunch", ["12:00", "12:30", "13:00"]), ("dinner", ["18:30", "19:00", "19:30", "20:00"])))
_spec(["western-grill", "euro", "italian"], "restaurant", items=(8, 13), ticket=(88, 420),
      hours="rest-late", book=True, pool=("table", 2, 8), band=4,
      slots=(("dinner", ["18:00", "18:30", "19:00", "19:30", "20:00"]),))
_spec(["specialty-coffee", "bakery-dessert"], "cafe", items=(6, 11), ticket=(28, 98), hours="cafe",
      pool=("seat", 2, 6), band=1, slots=(("lunch", ["10:00", "15:00"]),))
_spec(["tea-house", "bubble-tea"], "cafe", items=(5, 9), ticket=(18, 68), hours="tea",
      pool=("seat", 2, 6), band=1)
_spec(["cocktail-bar", "live-music", "wine-bar"], "bar", items=(7, 12), ticket=(68, 188),
      hours="bar", book=True, pool=("table", 2, 8), band=3,
      slots=(("dinner", ["20:00", "21:00", "21:30"]),))
_spec(["sports-pub"], "bar", items=(6, 10), ticket=(48, 148), hours="bar", book=True,
      pool=("table", 4, 10), band=2, slots=(("dinner", ["19:00", "19:30", "20:00"]),))
_spec(["gym-club"], "fitness", items=(5, 9), ticket=(280, 980), hours="gym", book=True,
      pool=("class_slot", 8, 20), price_model="per_person", band=3, unit="month",
      slots=(("class", ["07:00", "09:30", "18:00", "19:30"]),))
_spec(["yoga-pilates", "martial-arts", "personal-training", "swimming", "climbing"], "fitness",
      items=(5, 10), ticket=(150, 780), hours="class", book=True, pool=("class_slot", 4, 14),
      price_model="per_person", band=3,
      slots=(("class", ["09:00", "11:00", "14:00", "19:00", "20:30"]),))
_spec(["hair-salon", "barber", "lash-brow", "skin-clinic"], "beauty", items=(6, 11),
      ticket=(150, 1280), hours="salon", book=True, pool=("chair", 1, 4),
      price_model="from_price", band=3,
      slots=(("appt", ["11:00", "13:00", "15:00", "17:00", "19:00"]),))
_spec(["nail-salon"], "beauty", items=(6, 10), ticket=(180, 880), hours="salon", book=True,
      pool=("chair", 1, 4), price_model="from_price", band=2,
      slots=(("appt", ["12:00", "15:00", "18:00"]),))
_spec(["spa-massage"], "beauty", items=(6, 11), ticket=(380, 1380), hours="spa", book=True,
      pool=("treatment_room", 1, 5), band=4,
      slots=(("appt", ["12:00", "14:00", "16:00", "18:00", "20:00"]),))
_spec(["bowling", "board-game", "escape-room", "karaoke", "badminton", "paint-sip"], "activity",
      items=(5, 9), ticket=(80, 480), hours="act", book=True, pool=("lane", 2, 12),
      price_model="per_person", band=2,
      slots=(("play", ["13:00", "15:00", "17:00", "19:00", "20:30"]),))
_spec(["boutique-hotel", "resort"], "hotel", items=(5, 9), ticket=(780, 2880), hours="hotel",
      book=True, pool=("room", 3, 18), price_model="per_person", band=4, unit="night",
      slots=(("stay", ["15:00"]),))
_spec(["serviced-apartment", "hostel"], "hotel", items=(4, 8), ticket=(380, 1580), hours="hotel",
      book=True, pool=("room", 2, 12), price_model="per_person", band=3, unit="night",
      slots=(("stay", ["15:00"]),))
_spec(["culture-tour", "hiking-tour", "food-tour", "craft-workshop", "photo-tour", "sailing"],
      "experience", items=(4, 8), ticket=(220, 980), hours="exp", book=True, pool=("seat", 6, 16),
      price_model="per_person", band=3, slots=(("session", ["09:30", "14:00", "16:30"]),))
_spec(["local-snacks", "design-store", "bookshop", "tea-shop", "wet-market"], "shopping",
      items=(6, 12), ticket=(38, 680), hours="shop", band=2)
_spec(["laundry", "pet-grooming", "phone-repair", "photo-studio", "tailor", "home-cleaning"],
      "service", items=(4, 8), ticket=(80, 1280), hours="svc", book=True, pool=("station", 1, 3),
      band=2, slots=(("appt", ["10:00", "12:00", "14:00", "16:00"]),))

LEAF_TOP = {leaf: spec["top"] for leaf, spec in LEAF_SPEC.items()}

# --------------------------------------------------------------------------- menu / catalogue content
# (zh, en, reference price HKD, allergens, tag)  — tag drives price model + copy flavour.
DISH_POOL: dict[str, list[tuple]] = {
    "cantonese": [
        ("蜜汁叉燒", "Honey Glazed Char Siu", 128, "gluten,soy", "signature"),
        ("白切雞配薑蔥飯", "Poached Chicken with Ginger Scallion Rice", 148, "soy", "classic"),
        ("脆皮燒肉", "Crispy Roast Pork Belly", 138, "-", "classic"),
        ("上湯蒜茸蒸大白菜", "Chinese Cabbage in Superior Stock", 92, "soy", "veg"),
        ("避風塘炒蝦", "Typhoon Shelter Prawns", 218, "shellfish,garlic,soy", "signature"),
        ("梅菜扣肉", "Braised Pork Belly with Preserved Greens", 122, "soy", "classic"),
        ("乾瑤柱蛋白炒飯", "Fried Rice with Dried Scallop", 98, "egg,shellfish,soy,gluten", "classic"),
        ("豉椒炒蟶子", "Razor Clams with Black Bean Chili", 178, "shellfish,soy,chili", "wok"),
        ("楊枝甘露", "Mango Pomelo Sago", 48, "dairy,nuts", "dessert"),
        ("薑汁撞奶", "Ginger Milk Curd", 30, "dairy", "dessert"),
        ("絲襪奶茶(熱)", "Silk Stocking Milk Tea, Hot", 26, "dairy", "drink"),
        ("蜂陳檸茶(凍)", "Honey Lemon Tea, Iced", 32, "-", "drink"),
        ("位上生果茶", "Seasonal Fruit Tea, per Pot", 58, "-", "drink"),
    ],
    "dimsum": [
        ("蝦餃皇(4件)", "Har Gow, 4 pcs", 48, "shellfish,gluten", "signature"),
        ("乾蒸燒賣(4件)", "Siu Mai with Crab Roe", 42, "shellfish,pork,gluten", "classic"),
        ("蜜汁叉燒包(3件)", "Barbecue Pork Buns, 3 pcs", 32, "gluten,soy", "classic"),
        ("豉汁鳳爪", "Chicken Feet in Black Bean Sauce", 42, "soy", "classic"),
        ("牛肉腸粉", "Beef Rice Roll", 48, "soy,fish", "signature"),
        ("酥皮蛋撻(2件)", "Flaky Egg Tarts, 2 pcs", 18, "gluten,egg,dairy", "dessert"),
        ("蓮蓉芝麻球(2件)", "Lotus Paste Sesame Balls", 22, "gluten,sesame", "dessert"),
        ("臘味蘿蔔糕", "Turnip Cake with Cured Meats", 38, "fish", "classic"),
        ("鮮竹牛肉卷", "Steamed Beef Rolls in Bean Curd Skin", 44, "soy,gluten", "wok"),
        ("北菇滑雞飯", "Chicken & Mushroom Claypot Rice", 68, "soy", "classic"),
        ("即炸鮮魷", "Deep-fried Fresh Squid", 58, "mollusc,gluten", "wok"),
        ("茶位(每位)", "Tea Cover, per Person", 12, "-", "per_person"),
    ],
    "cha-chan-teng": [
        ("鮮油芝士豬仔包", "Buttered Cheese Piggy Bun", 28, "gluten,dairy", "signature"),
        ("瑞士雞翼飯", "Swiss Chicken Wing Rice", 46, "gluten,soy,egg", "classic"),
        ("乾免治牛肉飯", "Hamburger Steak Rice", 45, "gluten,egg,soy", "classic"),
        ("蜜汁雞髀飯", "Honey Chicken Drumstick Rice", 52, "soy,gluten", "classic"),
        ("餐肉太陽蛋三文治", "Luncheon Meat Egg Sandwich", 32, "gluten,egg,dairy", "classic"),
        ("菠蘿油", "Pineapple Bun with Cold Butter", 24, "gluten,dairy", "signature"),
        ("雲吞撈麵", "Dry Wonton Noodles", 38, "gluten,egg,shellfish,soy", "classic"),
        ("粟米肉羹飯", "Sweetcorn Pork Soup Rice", 42, "soy,egg", "classic"),
        ("紅茶走(熱)", "Warm Milk Tea, No Ice", 20, "dairy", "drink"),
        ("凍檸茶少甜", "Iced Lemon Tea, Less Sugar", 22, "-", "drink"),
        ("西米布甸", "Sago Pudding", 22, "dairy", "dessert"),
        ("即煎午餐肉蛋飯", "Fried Spam & Egg Rice", 44, "gluten,egg", "classic"),
    ],
    "siu-mei": [
        ("上湯叉燒飯", "Char Siu Rice with Soup", 58, "gluten,soy", "signature"),
        ("雙餸白飯", "Two-Meat Plain Rice", 68, "soy,gluten", "classic"),
        ("脆皮燒鵝(半隻)", "Crispy Roast Goose, Half", 328, "-", "signature"),
        ("豉油雞飯", "Soy Sauce Chicken Rice", 56, "soy,gluten", "classic"),
        ("燒肉叉燒雙拼飯", "Roast Pork & Char Siu Combo Rice", 66, "gluten,soy", "classic"),
        ("例湯(每位)", "Daily Soup, per Person", 12, "soy", "per_person"),
        ("凍檸七", "Iced Lemon Soda", 14, "-", "drink"),
        ("滷味拼盤", "Braised Assortment Plate", 52, "soy,gluten", "wok"),
        ("蒜茸回鍋肉飯", "Twice-Cooked Pork Rice", 62, "soy,garlic,gluten", "classic"),
    ],
    "hotpot": [
        ("海皇湯底", "Seafood Broth Base", 128, "shellfish,soy", "signature"),
        ("花膠雞煲湯底", "Fish Maw Chicken Pot Base", 188, "fish,soy", "premium"),
        ("澳門豬骨煲湯底", "Macau Pork Bone Pot Base", 158, "pork,soy", "classic"),
        ("手切肥牛", "Hand-sliced Beef Collar", 138, "-", "signature"),
        ("安格斯牛小排", "Angus Short Rib Slices", 198, "-", "premium"),
        ("鮮蝦滑", "Hand-beaten Prawn Paste", 98, "shellfish", "classic"),
        ("手打墨魚滑", "Squid Ball Paste", 88, "mollusc", "classic"),
        ("時蔬拼盤", "Seasonal Vegetable Platter", 78, "-", "veg"),
        ("瀨尿牛丸", "Hand-beaten Beef Meatballs", 88, "-", "wok"),
        ("凍豆腐", "Frozen Tofu", 28, "soy", "veg"),
        ("麵線", "Fine Noodle Nets", 32, "gluten,egg", "classic"),
        ("羔羊肉卷", "Lamb Shoulder Rolls", 148, "-", "premium"),
        ("位上甜品", "Per-seat Dessert", 38, "dairy", "dessert"),
    ],
    "seafood-grill": [
        ("蒜茸蒸大蝦", "Steamed Prawns with Garlic", 168, "shellfish,garlic", "signature"),
        ("椒鹽瀨尿蝦", "Salt & Pepper Mantis Shrimp", 218, "shellfish,gluten", "wok"),
        ("薑蔥炒蟹", "Crab with Ginger Scallion", 328, "shellfish,soy", "premium"),
        ("炭烤生蠔(6隻)", "Charcoal Grilled Oysters, 6 pcs", 148, "mollusc,garlic", "signature"),
        ("蒜蓉蒸扇貝(5隻)", "Steamed Scallops with Garlic", 128, "mollusc,garlic", "classic"),
        ("烤大隻魷魚", "Grilled Whole Squid", 98, "mollusc", "classic"),
        ("豉椒炒花甲", "Clams with Black Bean Chili", 88, "mollusc,soy,chili", "wok"),
        ("椒鹽魚皮", "Salt & Pepper Fish Skin", 48, "fish", "snack"),
        ("蒜蓉蒸龍蝦", "Steamed Lobster with Garlic", 288, "shellfish,garlic", "premium"),
        ("冰鎮啤酒(支裝)", "Chilled Bottle Beer", 42, "gluten", "drink"),
    ],
    "sushi": [
        ("三文魚握壽司(2件)", "Salmon Nigiri, 2 pcs", 58, "fish,soy", "signature"),
        ("吞拿魚大腹", "Toro Nigiri", 128, "fish,soy", "premium"),
        ("海膽軍艦(2件)", "Uni Gunkan", 98, "fish,mollusc", "premium"),
        ("鰻魚壽司", "Unagi Nigiri", 68, "fish,soy,gluten", "classic"),
        ("玉子燒", "Tamago", 38, "egg,gluten,soy", "classic"),
        ("加州卷", "California Roll", 68, "fish,sesame,soy", "classic"),
        ("壽司盛合(10件)", "Chef's Sushi Assortment", 268, "fish,soy", "signature"),
        ("枝豆", "Edamame", 28, "soy", "veg"),
        ("茶碗蒸", "Chawanmushi", 58, "egg,fish,soy", "classic"),
        ("赤出汁", "Miso Soup", 22, "soy,fish", "classic"),
        ("麻辣醉蟹鉗", "Drunken Crab Claws", 118, "shellfish,chili,soy", "wok"),
        ("清酒(1合)", "Sake, 1 Go", 98, "sulphite", "drink"),
    ],
    "ramen": [
        ("豚骨拉麵", "Tonkotsu Ramen", 88, "gluten,egg,pork,soy", "signature"),
        ("味噌玉米拉麵", "Miso Corn Ramen", 92, "gluten,soy,dairy", "classic"),
        ("鹽味雞湯拉麵", "Shio Chicken Ramen", 88, "gluten,egg,soy", "classic"),
        ("麻辣擔擔麵", "Spicy Dan Dan Noodles", 96, "gluten,sesame,nuts,soy,chili", "wok"),
        ("餃子(6件)", "Pork Dumplings, 6 pcs", 48, "gluten,pork,soy", "classic"),
        ("唐揚雞", "Fried Chicken Karage", 58, "gluten,egg,soy", "classic"),
        ("叉燒飯", "Char Siu Rice Bowl", 38, "gluten,soy", "classic"),
        ("味玉", "Marinated Soft Egg", 18, "egg,soy", "classic"),
        ("可樂(罐)", "Canned Cola", 18, "-", "drink"),
        ("黑蒜油加碼", "Extra Black Garlic Oil", 12, "soy", "addon"),
    ],
    "izakaya": [
        ("串燒盛合(8支)", "Yakitori Platter, 8 Skewers", 148, "soy,gluten", "signature"),
        ("炭烤魷魚", "Grilled Squid", 78, "mollusc,gluten", "classic"),
        ("唐揚雞", "Chicken Karage", 68, "egg,gluten,soy", "classic"),
        ("海鹽毛豆", "Edamame with Sea Salt", 28, "soy", "veg"),
        ("出汁玉子燒", "Dashimaki Tamago", 42, "egg,soy", "classic"),
        ("生啤", "Draft Beer", 48, "gluten", "drink"),
        ("高球(2杯)", "Whisky Highball, 2 glasses", 158, "-", "drink"),
        ("本釀造清酒(1合)", "Sake, 1 Go", 98, "sulphite", "drink"),
        ("醬油雪糕", "Soy Sauce Ice Cream", 38, "dairy,soy", "dessert"),
        ("磯燒芝士年糕", "Grilled Mochi with Seaweed Cheese", 46, "dairy,gluten", "snack"),
    ],
    "korean": [
        ("韓式炸雞(半隻)", "Korean Fried Chicken, Half", 128, "gluten,egg,soy", "signature"),
        ("部隊鍋(2人份)", "Budae Jjigae for 2", 188, "gluten,soy,dairy,pork", "classic"),
        ("石鍋拌飯", "Dolsot Bibimbap", 92, "egg,sesame,soy", "classic"),
        ("人參雞湯", "Ginseng Chicken Soup", 138, "-", "premium"),
        ("烤肉拼盤(2人份)", "BBQ Platter for 2", 268, "soy,sesame", "signature"),
        ("泡菜", "Kimchi", 22, "chili,soy", "veg"),
        ("韓國燒酒", "Soju", 42, "-", "drink"),
        ("芝士辣炒雞", "Cheese Tteokbokki Chicken", 128, "dairy,chili,soy", "wok"),
        ("大醬湯飯", "Doenjang Rice Soup", 62, "soy,gluten", "classic"),
    ],
    "thai": [
        ("冬蔭功湯", "Tom Yum Goong", 88, "shellfish,fish,soy,chili", "signature"),
        ("綠咖哩雞", "Green Curry Chicken", 108, "dairy,nuts,soy,chili", "classic"),
        ("泰式炒金邊粉", "Pad Thai", 92, "nuts,egg,shellfish,soy", "classic"),
        ("炭燒豬頸肉", "Grilled Pork Neck", 98, "soy,gluten", "signature"),
        ("黃咖哩牛", "Yellow Beef Curry", 118, "dairy,soy", "classic"),
        ("羅勒葉炒雞", "Holy Basil Chicken", 105, "chili,soy,gluten", "wok"),
        ("芒果糯米飯", "Mango Sticky Rice", 58, "dairy", "dessert"),
        ("泰式奶茶", "Thai Iced Tea", 32, "dairy", "drink"),
        ("青木瓜沙律", "Som Tam", 68, "nuts,fish,chili", "veg"),
    ],
    "vietnamese": [
        ("牛肉河粉", "Beef Pho", 88, "fish,soy", "signature"),
        ("蝦醬炒通菜", "Water Spinach with Shrimp Paste", 78, "mollusc,garlic", "wok"),
        ("越南扎肉法包", "Pork Banh Mi", 48, "gluten,pork,soy", "classic"),
        ("鮮蝦春捲(4件)", "Fresh Spring Rolls, 4 pcs", 42, "shellfish,soy", "classic"),
        ("咖哩雞飯", "Chicken Curry Rice", 78, "dairy,fish", "classic"),
        ("滴濾咖啡加煉乳", "Phin Coffee with Condensed Milk", 32, "dairy", "drink"),
        ("猪肉手卷", "Pork Hand Roll", 52, "soy,pork", "classic"),
        ("椰子冰淇淋", "Coconut Ice Cream", 38, "dairy,nuts", "dessert"),
    ],
    "indian": [
        ("牛油雞", "Butter Chicken", 128, "dairy,nuts,soy,chili", "signature"),
        ("羊腿瑪莎拉", "Lamb Rogan Josh", 148, "dairy,soy,chili", "classic"),
        ("達爾扁豆", "Dal Makhani", 88, "dairy,nuts", "veg"),
        ("牛油烤餅", "Butter Naan", 22, "gluten,dairy", "classic"),
        ("咖哩蝦", "Prawn Korma", 138, "shellfish,dairy", "wok"),
        ("印度香飯", "Hyderabadi Biryani", 118, "dairy,shellfish", "signature"),
        ("甜乳蓋茶", "Sweet Lassi", 42, "dairy", "drink"),
        ("素食咖哩拼盤", "Vegetable Curry Platter", 108, "dairy,soy", "veg"),
        ("香料茶", "Masala Chai", 28, "dairy", "drink"),
    ],
    "western-grill": [
        ("澳洲西冷牛排300g", "Australian Sirloin 300g", 328, "dairy,pepper", "signature"),
        ("安格斯肉眼350g", "Angus Ribeye 350g", 418, "dairy", "premium"),
        ("香煎海鱸魚", "Pan-seared Sea Bass", 248, "fish,dairy", "classic"),
        ("凱撒沙律", "Caesar Salad", 98, "gluten,dairy,egg,fish", "classic"),
        ("野菌濃湯", "Wild Mushroom Soup", 72, "dairy,gluten", "classic"),
        ("海鹽薯條", "Sea Salt Fries", 48, "-", "snack"),
        ("朱古力心太軟", "Molten Chocolate Cake", 68, "gluten,dairy,egg,nuts", "dessert"),
        ("藍芝士汁加碼", "Extra Blue Cheese Dressing", 32, "dairy", "addon"),
        ("杯中紅酒", "Glass of House Red", 98, "sulphite", "drink"),
    ],
    "euro": [
        ("油封鴨脾", "Confit de Canard", 258, "dairy,sulphite", "signature"),
        ("勃艮第焗田螺(6隻)", "Escargots de Bourgogne", 148, "dairy,gluten,sulphite", "classic"),
        ("尼斯沙律", "Salade Niçoise", 128, "fish,egg", "veg"),
        ("法式洋蔥湯", "French Onion Soup", 88, "gluten,dairy,sulphite", "classic"),
        ("燉牛頰肉", "Braised Beef Cheek", 268, "dairy,sulphite", "premium"),
        ("焦糖布甸", "Crème Brûlée", 62, "dairy,egg", "dessert"),
        ("氣泡水(支裝)", "Sparkling Water", 48, "-", "drink"),
        ("香檳(杯裝)", "Champagne by the Glass", 148, "sulphite", "drink"),
    ],
    "italian": [
        ("闊條麵配野肉醬", "Pappardelle with Wild Boar Ragu", 168, "gluten,egg,sulphite", "signature"),
        ("瑪格麗特薄餅", "Margherita Pizza", 118, "gluten,dairy", "classic"),
        ("卡邦尼意粉", "Spaghetti Carbonara", 138, "gluten,egg,dairy", "classic"),
        ("白酒蛤蜊意粉", "Linguine Vongole", 158, "gluten,mollusc,sulphite", "signature"),
        ("野菌燴飯", "Mushroom Risotto", 148, "dairy,sulphite", "veg"),
        ("提拉米蘇", "Tiramisu", 68, "dairy,egg,gluten", "dessert"),
        ("氣泡水", "Sparkling Water", 28, "-", "drink"),
        ("意式濃縮", "Espresso", 30, "-", "drink"),
        ("帕馬火腿拼盤", "Prosciutto Board", 158, "-", "premium"),
    ],
    "singmal": [
        ("海南雞飯", "Hainanese Chicken Rice", 78, "soy,gluten", "signature"),
        ("肉骨茶", "Bak Kut Teh", 98, "soy,gluten,herb", "classic"),
        ("椰漿飯", "Nasi Lemak with Ikan Bilis", 82, "fish,peanut,egg,coconut", "classic"),
        ("炒粿條", "Fried Kway Teow", 88, "shellfish,soy,gluten", "wok"),
        ("咖哩叻沙", "Curry Laksa", 92, "shellfish,coconut,gluten,soy", "signature"),
        ("白咖啡", "Ipoh White Coffee", 28, "dairy", "drink"),
        ("拉茶", "Teh Tarik", 26, "dairy", "drink"),
        ("咖椰吐司套餐", "Kaya Toast Set", 32, "gluten,dairy,egg", "classic"),
    ],
    "vegetarian": [
        ("素食麻婆豆腐", "Vegetarian Mapo Tofu", 88, "soy,chili,gluten", "signature"),
        ("松露野菌飯", "Truffle Mushroom Rice", 118, "soy", "premium"),
        ("素叉燒", "Vegetarian Char Siu", 98, "soy,gluten", "classic"),
        ("藜麥核桃沙律", "Quinoa Walnut Salad", 88, "nuts", "veg"),
        ("素雲吞湯麵", "Vegetarian Wonton Noodle Soup", 62, "gluten,soy", "classic"),
        ("抹茶豆花", "Matcha Soya Bean Curd", 42, "soy", "dessert"),
        ("鮮椰子水", "Fresh Coconut Water", 32, "coconut", "drink"),
        ("五穀飯", "Multigrain Rice", 18, "-", "veg"),
    ],
    "homey": [
        ("雲吞蝦麵", "Prawn Wonton Noodle Soup", 68, "gluten,shellfish,egg,soy", "signature"),
        ("牛腩撈麵", "Dry Braised Beef Noodles", 62, "gluten,soy,sesame", "classic"),
        ("薑蔥撈雞飯", "Ginger Scallion Chicken Rice", 62, "soy,gluten", "classic"),
        ("滑蛋叉燒飯", "Scrambled Egg Char Siu Rice", 58, "egg,gluten,soy", "classic"),
        ("碗仔翅", "Faux Shark Fin Soup Cup", 42, "egg,soy,shellfish", "snack"),
        ("豬潤湯飯", "Pork Liver Rice Soup", 48, "soy,gluten", "classic"),
        ("凍檸水", "Iced Lemon Water", 18, "-", "drink"),
        ("加餸選擇", "Extra Topping Choice", 22, "soy,gluten", "addon"),
    ],
    "fusion": [
        ("味噌蛋黃醬脆皮雞翼", "Crispy Wings, Miso Yolk Aioli", 88, "egg,gluten,soy", "signature"),
        ("黑松露叉燒撈麵", "Char Siu Noodles with Black Truffle", 128, "gluten,soy,egg", "premium"),
        ("泰式蝦沙律", "Chilli Prawn Salad", 118, "shellfish,fish,chili", "veg"),
        ("柚子醋鯖魚", "Mackerel with Yuzu Ponzu", 98, "fish,soy", "classic"),
        ("松露野菌忌廉意粉", "Truffle Mushroom Linguine", 158, "gluten,dairy", "classic"),
        ("咖哩蝦球飯", "Curry Prawn Rice Bowl", 108, "shellfish,dairy,soy", "wok"),
        ("氣泡芭樂特飲", "Sparkling Guava Cooler", 42, "-", "drink"),
    ],
    "specialty-coffee": [
        ("Flat White(熱)", "Flat White, Hot", 38, "dairy", "signature"),
        ("Dirty(凍)", "Iced Dirty", 42, "dairy", "signature"),
        ("手沖單品", "Hand Drip, Single Origin", 58, "-", "classic"),
        ("巴斯克芝士蛋糕", "Basque Cheesecake", 52, "dairy,egg,gluten", "dessert"),
        ("牛油可頌", "Butter Croissant", 26, "gluten,dairy", "classic"),
        ("歐式早餐套餐", "Breakfast Set", 78, "gluten,egg,dairy", "classic"),
        ("豆奶Flat White", "Soy Flat White", 42, "soy", "veg"),
        ("烘焙豆(250g)", "Roasted Beans, 250g", 138, "-", "retail"),
    ],
    "bakery-dessert": [
        ("法式長棍", "Baguette", 22, "gluten", "classic"),
        ("朱古力熔岩蛋糕", "Chocolate Lava Cake", 48, "gluten,dairy,egg", "signature"),
        ("奶油泡芙(3件)", "Cream Puffs, 3 pcs", 42, "gluten,dairy,egg", "classic"),
        ("肉鬆小貝", "Pork Floss Pastry", 12, "gluten,egg,pork", "snack"),
        ("慶祝蛋糕(6吋)", "Celebration Cake, 6 inch", 288, "gluten,dairy,egg,nuts", "premium"),
        ("檸檬塔", "Lemon Tart", 42, "gluten,dairy,egg", "classic"),
        ("外賣咖啡", "Takeaway Coffee", 28, "dairy", "drink"),
    ],
    "tea-house": [
        ("普洱壺茶(2人)", "Pu Erh Pot for 2", 98, "-", "signature"),
        ("鐵蓋碗茶", "Tieguanyin Gaiwan Set", 88, "-", "classic"),
        ("茶點套餐", "Tea & Bite Pairing", 168, "gluten,soy,shellfish", "premium"),
        ("茶葉禮盒", "Tea Gift Box", 328, "-", "retail"),
        ("冷泡茶", "Cold Brew Tea", 42, "-", "drink"),
        ("茶味雪糕", "Tea Soft Serve", 38, "dairy", "dessert"),
    ],
    "bubble-tea": [
        ("黑糖珍珠奶茶", "Brown Sugar Bubble Milk Tea", 32, "dairy", "signature"),
        ("鮮檸茶", "Fresh Lemon Tea", 28, "-", "classic"),
        ("芋頭西米露", "Taro Sago", 36, "dairy,coconut", "classic"),
        ("加珍珠", "Extra Pearls", 6, "-", "addon"),
        ("四季春無糖", "Four Seasons Oolong, Unsweetened", 24, "-", "veg"),
        ("芝士奶蓋", "Cheese Foam Cap", 12, "dairy", "addon"),
    ],
    "cocktail-bar": [
        ("招牌調酒", "Signature Cocktail", 108, "-", "signature"),
        ("經典馬天尼", "Classic Martini", 118, "-", "classic"),
        ("Highball 兩杯", "Two Highballs", 158, "-", "classic"),
        ("芝士拼盤", "Cheese Board", 188, "dairy,nuts", "premium"),
        ("炸魷片", "Fried Squid Chips", 68, "mollusc,gluten", "snack"),
        ("無酒精調飲", "Zero-Proof Cocktail", 78, "-", "veg"),
        ("瓶裝水", "Still Water", 38, "-", "drink"),
    ],
    "sports-pub": [
        ("精釀啤酒(杯裝)", "Craft Beer Pint", 68, "gluten", "signature"),
        ("分享拼盤(3人)", "Share Platter for 3", 268, "gluten,dairy,shellfish", "classic"),
        ("牛肉漢堡", "Beef Burger", 118, "gluten,dairy,egg,soy", "signature"),
        ("雞翼(12件)", "Chicken Wings, 12 pcs", 138, "soy,gluten", "classic"),
        ("芝士肉汁薯條", "Loaded Fries", 78, "dairy", "snack"),
        ("遊戲機時租", "Arcade Hour", 88, "-", "per_person"),
    ],
    "wine-bar": [
        ("杯中酒選", "Wine by the Glass", 128, "sulphite", "signature"),
        ("紅酒配餐(2人)", "Wine Pairing for 2", 588, "sulphite,nuts", "premium"),
        ("雪芳丹尼拼盤", "Charcuterie Board", 228, "-", "classic"),
        ("芝士三件", "Three Cheese Plate", 198, "dairy", "classic"),
        ("盲選酒瓶", "Blind Bottle Deal", 328, "sulphite", "classic"),
    ],
    "live-music": [
        ("入場門票", "Cover Charge", 128, "-", "per_person"),
        ("時段飲品套餐", "Showtime Drink Set", 158, "gluten", "classic"),
        ("啤酒桶", "Beer Bucket", 228, "gluten", "signature"),
        ("小食拼盤", "Snack Board", 148, "gluten,peanut", "classic"),
    ],
    "gym-club": [
        ("月費會籍", "Monthly Membership", 780, "-", "signature"),
        ("年度會籍", "Annual Membership", 7800, "-", "premium"),
        ("私人教練(1堂60分鐘)", "Personal Training, 60 min", 580, "-", "signature"),
        ("體適能評估", "Fitness Assessment", 250, "-", "classic"),
        ("團體課(按次)", "Group Class, Drop-in", 180, "-", "per_person"),
        ("日間離峰會籍", "Off-peak Membership", 380, "-", "classic"),
        ("储物柜(月租)", "Locker Rental, Monthly", 90, "-", "classic"),
    ],
    "yoga-pilates": [
        ("恆常班(按次)", "Drop-in Class", 180, "-", "classic"),
        ("8堂證(3個月)", "8-Class Pass, 3 Months", 1280, "-", "signature"),
        ("普拉提床(1對1)", "Reformer 1-to-1", 580, "-", "premium"),
        ("空中瑜珈(按次)", "Aerial Yoga, Drop-in", 250, "-", "classic"),
        ("產後修復課程(6週)", "Postnatal Course, 6 Weeks", 2380, "-", "premium"),
        ("晨間班月票", "Morning Class Monthly Pass", 780, "-", "classic"),
    ],
    "climbing": [
        ("日票連租鞋", "Day Pass with Shoe Rental", 150, "-", "classic"),
        ("月票", "Monthly Pass", 780, "-", "signature"),
        ("領攀課程", "Lead Climbing Course", 980, "-", "premium"),
        ("兒童班(8堂)", "Kids Course, 8 Sessions", 1580, "-", "classic"),
        ("包場(每小時)", "Venue Hire, per Hour", 480, "-", "hourly"),
    ],
    "swimming": [
        ("季票(3個月)", "Season Ticket", 2380, "-", "signature"),
        ("教練課(1對1)", "Private Lesson", 480, "-", "classic"),
        ("長者月票", "Senior Monthly Pass", 380, "-", "classic"),
        ("泳道預訂(每小時)", "Lane Booking, per Hour", 120, "-", "hourly"),
    ],
    "martial-arts": [
        ("體驗堂", "Trial Class", 120, "-", "classic"),
        ("月費班", "Monthly Tuition", 680, "-", "signature"),
        ("兒童功夫班(12週)", "Kids Kung Fu, 12 Weeks", 1980, "-", "premium"),
        ("私教(60分鐘)", "Private Session, 60 min", 560, "-", "classic"),
    ],
    "personal-training": [
        ("12堂減脂方案", "12-Session Fat Loss Program", 5880, "-", "premium"),
        ("體態評估", "Posture Assessment", 320, "-", "classic"),
        ("線上指導(月費)", "Online Coaching, Monthly", 980, "-", "signature"),
        ("雙人訓練(60分鐘)", "Duo Training, 60 min", 780, "-", "classic"),
    ],
    "hair-salon": [
        ("女髮剪髮連吹靚", "Ladies Cut & Blowdry", 380, "-", "signature"),
        ("全頭染髮", "Full Head Colour", 780, "-", "classic"),
        ("燙髮連護理", "Perm with Treatment", 980, "-", "premium"),
        ("深層髮膜", "Deep Hair Mask", 320, "-", "classic"),
        ("兒童剪髮", "Kids Cut", 150, "-", "classic"),
        ("頭皮護理疗程(6次)", "Scalp Course, 6 Visits", 2280, "-", "premium"),
    ],
    "barber": [
        ("男士剪髮", "Men's Cut", 180, "-", "signature"),
        ("剪髮連熱毛巾刮面", "Cut with Hot Towel Shave", 260, "-", "classic"),
        ("漸層髮型", "Skin Fade", 220, "-", "classic"),
        ("鬍鬚修整", "Beard Trim", 120, "-", "classic"),
    ],
    "nail-salon": [
        ("基礎護甲", "Basic Manicure", 220, "-", "classic"),
        ("凝膠美甲", "Gel Nails", 420, "-", "signature"),
        ("足部護理", "Spa Pedicure", 380, "-", "classic"),
        ("卸甲連修型", "Soak-off & Reshape", 120, "-", "classic"),
        ("手部按摩(30分鐘)", "Hand Massage, 30 min", 180, "-", "classic"),
        ("美甲雕花(每指)", "Nail Art per Nail", 48, "-", "addon"),
    ],
    "spa-massage": [
        ("全身按摩60分鐘", "Full Body Massage, 60 min", 480, "-", "signature"),
        ("深層組織90分鐘", "Deep Tissue, 90 min", 680, "-", "classic"),
        ("足部反射治療", "Reflexology, 60 min", 380, "-", "classic"),
        ("精油推拿", "Aroma Oil Massage", 580, "-", "premium"),
        ("熱石療法", "Hot Stone Therapy", 780, "-", "premium"),
        ("雙人房(90分鐘)", "Couples Room, 90 min", 1280, "-", "premium"),
        ("產後調理按摩", "Postnatal Massage", 880, "-", "classic"),
    ],
    "skin-clinic": [
        ("皮膚分析諮詢", "Skin Analysis Consult", 250, "-", "classic"),
        ("水光疗程", "Hydra Glow Course", 1880, "-", "premium"),
        ("深層清潔facial", "Deep Cleansing Facial", 580, "-", "signature"),
        ("淡斑激光(按次)", "Pigmentation Laser, per Session", 1280, "-", "premium"),
        ("敏感肌修護facial", "Barrier Repair Facial", 680, "-", "classic"),
    ],
    "lash-brow": [
        ("種植睫毛(經典)", "Classic Lash Extensions", 580, "-", "signature"),
        ("粉霧眉連補色", "Powder Brow with Touch-up", 2380, "-", "premium"),
        ("睫毛燙翹", "Lash Lift & Tint", 420, "-", "classic"),
        ("眉型修整", "Brow Shaping", 180, "-", "classic"),
    ],
    "bowling": [
        ("場租(每線每小時)", "Lane Hire, per Hour", 180, "-", "hourly"),
        ("按局收費", "Game Rate", 60, "-", "classic"),
        ("包場套餐(2小時)", "Party Package, 2 Hours", 1480, "-", "premium"),
        ("波鞋租借", "Shoe Rental", 25, "-", "classic"),
        ("小食飲品套票", "Snack & Drink Bundle", 78, "-", "classic"),
    ],
    "board-game": [
        ("枱位費(每位2小時)", "Table Fee, 2 Hours per Person", 88, "-", "signature"),
        ("全日通行證", "All-day Pass", 148, "-", "classic"),
        ("飲品無限加購", "Bottomless Drinks Add-on", 48, "-", "addon"),
        ("私人房間(3小時)", "Private Room, 3 Hours", 480, "-", "premium"),
    ],
    "escape-room": [
        ("主題房(2人)", "Themed Room for 2", 440, "-", "signature"),
        ("主題房(6人)", "Themed Room for 6", 1080, "-", "premium"),
        ("夜場困難模式", "Night Hard Mode", 220, "-", "classic"),
        ("企業團建場", "Corporate Session", 3200, "-", "premium"),
    ],
    "karaoke": [
        ("房費(每小時)", "Room Hire, per Hour", 280, "-", "hourly"),
        ("下午茶時段(4小時)", "Afternoon Slot, 4 Hours", 480, "-", "classic"),
        ("通宵房", "Overnight Room", 1180, "-", "premium"),
        ("生果飲品盤", "Fruit & Drink Platter", 268, "-", "classic"),
    ],
    "badminton": [
        ("場租(每小時)", "Court Hire, per Hour", 180, "-", "hourly"),
        ("長租月費", "Monthly Court Membership", 1280, "-", "signature"),
        ("教練課(60分鐘)", "Coaching, 60 min", 420, "-", "classic"),
        ("羽毛球裝", "Shuttlecock Pack", 78, "-", "retail"),
    ],
    "paint-sip": [
        ("兩小時工作坊", "2-Hour Workshop", 420, "-", "signature"),
        ("情侶雙人位", "Date-Night Pair Seat", 780, "-", "premium"),
        ("兒童繪畫班", "Kids Art Class", 280, "-", "classic"),
        ("作品燒製加購", "Kiln Firing Add-on", 120, "-", "addon"),
    ],
    "boutique-hotel": [
        ("標準雙人房", "Standard Double Room", 980, "-", "classic"),
        ("高級城景房", "Deluxe City View", 1280, "-", "signature"),
        ("家庭連通房", "Family Interconnecting", 1680, "-", "premium"),
        ("行政套房", "Executive Suite", 2380, "-", "premium"),
        ("延遲退房", "Late Check-out", 280, "-", "addon"),
        ("機場接駁", "Airport Transfer", 480, "-", "classic"),
    ],
    "serviced-apartment": [
        ("一房(月租)", "1-Bedroom, Monthly", 12800, "-", "signature"),
        ("兩房(月租)", "2-Bedroom, Monthly", 17800, "-", "premium"),
        ("短住(每晚)", "Short Stay, per Night", 780, "-", "classic"),
        ("清潔服務(按次)", "Housekeeping, per Visit", 220, "-", "classic"),
    ],
    "hostel": [
        ("八人床位(連稅)", "8-Bed Dorm, per Night", 380, "-", "signature"),
        ("私人雙人間", "Private Twin, per Night", 720, "-", "classic"),
        ("储物柜鎖", "Locker Padlock", 40, "-", "retail"),
        ("早餐加購", "Breakfast Add-on", 58, "-", "addon"),
    ],
    "resort": [
        ("園景客房連早餐", "Garden Room with Breakfast", 1580, "-", "signature"),
        ("海灣小屋", "Cove Cottage", 2180, "-", "premium"),
        ("親子套餐(2大1小)", "Family Package, 2 Adults 1 Child", 2680, "-", "premium"),
        ("日間會籍", "Day Pass", 480, "-", "classic"),
        ("水上活動半日", "Half-day Water Sports", 680, "-", "per_person"),
    ],
    "culture-tour": [
        ("舊區導賞(3小時)", "Heritage Walk, 3 Hours", 380, "-", "signature"),
        ("九龍夜遊導賞", "Kowloon Night Walk", 420, "-", "classic"),
        ("私人團(至多8人)", "Private Group, up to 8", 2680, "-", "premium"),
        ("英文導賞加購", "English Guiding Add-on", 120, "-", "addon"),
    ],
    "hiking-tour": [
        ("麥理浩徑二段半日", "MacLehose Section 2, Half-day", 280, "-", "signature"),
        ("龍脊遠足", "Dragon's Back Hike", 320, "-", "classic"),
        ("日出攝影行山", "Sunrise Photo Hike", 480, "-", "premium"),
        ("裝備租借", "Gear Rental", 90, "-", "classic"),
    ],
    "food-tour": [
        ("老字號美食團(4小時)", "Old-shop Food Crawl, 4 Hours", 580, "-", "signature"),
        ("街市煮食團(5小時)", "Wet Market & Cook, 5 Hours", 780, "-", "premium"),
        ("夜市小食團", "Night Market Tasting", 420, "-", "classic"),
        ("素食美食團", "Vegetarian Food Walk", 480, "-", "veg"),
    ],
    "craft-workshop": [
        ("陶藝拉坯(2小時)", "Wheel Throwing, 2 Hours", 420, "-", "signature"),
        ("藍染方巾", "Indigo Dye Bandana", 320, "-", "classic"),
        ("金工戒指工作坊", "Silver Ring Making", 680, "-", "premium"),
        ("香薰蠟燭製作", "Scented Candle Workshop", 380, "-", "classic"),
    ],
    "photo-tour": [
        ("夜景攝影團(3小時)", "Night Photo Walk, 3 Hours", 480, "-", "signature"),
        ("婚禮預攝體驗", "Pre-wedding Shoot Trial", 1280, "-", "premium"),
        ("相機租借(按日)", "Camera Rental, Daily", 280, "-", "classic"),
    ],
    "sailing": [
        ("帆船體驗(2小時)", "Sailing Taster, 2 Hours", 680, "-", "signature"),
        ("獨木舟半日", "Kayak Half-day", 380, "-", "classic"),
        ("操帆訓練", "Sailing Training Session", 980, "-", "premium"),
        ("私人包艇(4小時)", "Private Charter, 4 Hours", 4800, "-", "premium"),
    ],
    "local-snacks": [
        ("手工曲奇(12件)", "Handmade Cookies, 12 pcs", 98, "gluten,dairy,egg,nuts", "signature"),
        ("涼果禮盒", "Preserved Fruit Gift Set", 148, "-", "classic"),
        ("蛋卷(9條裝)", "Egg Rolls, 9 pcs", 118, "egg,gluten,dairy", "classic"),
        ("肉鬆(罐裝)", "Pork Floss, Tin", 138, "pork,soy", "retail"),
        ("過年糖缸", "CNY Candy Tin", 88, "nuts", "retail"),
    ],
    "design-store": [
        ("本地設計師T恤", "Local Designer Tee", 280, "-", "signature"),
        ("陶瓷餐具", "Ceramic Tableware", 420, "-", "classic"),
        ("帆布環保袋", "Canvas Tote", 158, "-", "veg"),
        ("策展盲盒", "Curated Blind Box", 198, "-", "classic"),
    ],
    "bookshop": [
        ("港版繁體小說", "Local Traditional Chinese Novel", 128, "-", "classic"),
        ("英文藝術書", "Art Book, English Edition", 280, "-", "premium"),
        ("二手書區通行", "Second-hand Section Pass", 45, "-", "classic"),
        ("讀書會門票", "Book Club Ticket", 88, "-", "per_person"),
    ],
    "tea-shop": [
        ("陳年普洱餅", "Aged Pu Erh Cake", 680, "-", "premium"),
        ("茶葉(50g罐)", "Loose Tea, 50g Tin", 250, "-", "signature"),
        ("中藥材茶包", "Herbal Tea Pack", 148, "herb", "classic"),
        ("茶具套裝", "Tea Ware Set", 480, "-", "classic"),
    ],
    "wet-market": [
        ("鮮乾貨禮盒", "Dried Seafood Gift Box", 388, "shellfish,fish", "signature"),
        ("臘腸(每磅)", "Chinese Sausage, per Catty", 158, "pork,soy", "classic"),
        ("瑤柱(每兩)", "Dried Scallop, per Tael", 268, "shellfish", "premium"),
        ("煲湯料包", "Soup Herb Bundle", 88, "herb", "veg"),
    ],
    "laundry": [
        ("水洗連烘乾(每公斤)", "Wash & Fold, per kg", 22, "-", "classic"),
        ("西裝乾洗", "Suit Dry Cleaning", 78, "-", "signature"),
        ("床品大件洗", "Bedding Bulky Wash", 128, "-", "classic"),
        ("即日件加急", "Same-day Service, per Piece", 15, "-", "addon"),
        ("上門收送", "Pickup & Delivery", 40, "-", "addon"),
    ],
    "pet-grooming": [
        ("小型犬美容", "Small Dog Groom", 380, "-", "signature"),
        ("大型犬洗澡", "Large Dog Bath", 680, "-", "classic"),
        ("貓部修剪", "Cat Groom Session", 880, "-", "premium"),
        ("藥浴加購", "Medicated Bath Add-on", 120, "-", "addon"),
        ("半日託管", "Half-day Boarding", 220, "-", "classic"),
    ],
    "phone-repair": [
        ("螢幕更換(常見型號)", "Screen Replacement, Common Model", 780, "-", "signature"),
        ("電池更換", "Battery Replacement", 380, "-", "classic"),
        ("進水檢測清潔", "Liquid Damage Diagnosis", 200, "-", "classic"),
        ("鏡頭貼膜", "Lens Film Install", 60, "-", "addon"),
    ],
    "photo-studio": [
        ("證件照(即取)", "ID Photo, Same-day", 90, "-", "classic"),
        ("家庭寫真(1小時)", "Family Portrait, 1 Hour", 980, "-", "signature"),
        ("產品照(每件)", "Product Shoot, per Item", 180, "-", "classic"),
        ("精裝相簿(20頁)", "Hardcover Album, 20 Pages", 680, "-", "premium"),
    ],
    "tailor": [
        ("褲長修改", "Hem Trousers", 90, "-", "classic"),
        ("西裝改尺寸", "Suit Alteration", 480, "-", "signature"),
        ("拉鏈更換", "Zipper Replacement", 180, "-", "classic"),
        ("恤衫收身", "Shirt Waisting", 150, "-", "classic"),
    ],
    "home-cleaning": [
        ("居家清潔(每小時)", "Home Cleaning, per Hour", 180, "-", "hourly"),
        ("廚房深層去油", "Deep Kitchen Degrease", 880, "-", "classic"),
        ("床褥除蟎", "Mattress Mite Treatment", 680, "-", "signature"),
        ("搬前搬後清潔", "Move-in/out Clean", 2380, "-", "premium"),
    ],
}

ALLERGEN_NOTES = [
    "所有餸菜可走蔥、走蒜、減鹽；對上述致敏物過敏請落單時告知。",
    "如有食物敏感（花生、shellfish、乳製品），請於落單前講清楚。",
    "Kitchen also handles nuts, sesame and shellfish; cross-contact is possible.",
    "含致敏物之菜式恕不能更改成分，歡迎選擇其他菜式。",
]

DEMO_STATEMENT_DOC = [
    "【數據聲明】本菜單為 NEXUS 合成示範內容 (SYNTHETIC DEMO DATA)，店名、地址、電話、價格、",
    "評價與供求均為虛構，並非任何真實香港商戶；僅供產品與搜尋/AI 功能演示，不可作實時參考。",
]

# --------------------------------------------------------------------------- policies
# (key, label_zh, zh template, en template, (min, max) value)
POLICY_LINES = [
    ("minimum_spend", "低消", "每位低消 HK${n}，只收現金及電子支付，暫不收信用卡。",
     "Minimum spend HK${n} per person; cash and e-wallet only, no credit cards.", (0, 60)),
    ("corkage", "自備酒類", "自備酒類每支收 HK${n} 開瓶費，每枱限兩支。",
     "Corkage HK${n} per bottle, capped at two bottles per table.", (80, 250)),
    ("children", "小童", "六歲以下免費，六至十二歲半價，備有BB 椅。",
     "Under 6 free, 6-12 half price, baby seats available on request.", (0, 0)),
    ("group", "團體", "{n}人以上請提前48小時預約，12人以上另加一服務費。",
     "Parties of {n}+ need 48 hours notice; 12+ incur a 10% service charge.", (6, 10)),
    ("peak", "繁忙時段", "星期六、日午市及晚市可能需等位{n}至60分鐘，接受到店取飛，不接受電話留位。",
     "Weekend service may involve a {n}-60 minute wait; queue cards only, no phone holds.", (15, 40)),
    ("allergy", "致敏", "菜式已標示致敏物，最終處理以廚房當日為準。",
     "Allergens are listed per dish; final call rests with the kitchen on the day.", (0, 0)),
    ("payment", "付款", "支援 PayMe、AlipayHK、八達通及Visa；不接受港鐵電子券。",
     "PayMe, AlipayHK, Octopus and Visa accepted.", (0, 0)),
    ("booking", "預約", "AI 助手可代為查詢及預約，實際確認仍由店員回覆為準。",
     "The AI agent may answer and hold requests; final confirmation comes from staff.", (0, 0)),
]

# --------------------------------------------------------------------------- review language
ASPECTS = ["taste", "service", "waiting_time", "noise", "portion", "value",
           "cleanliness", "mtr_distance", "ambience", "seating"]
ASPECT_ZH = {"taste": "味道", "service": "服務", "waiting_time": "等位", "noise": "噪音",
             "portion": "份量", "value": "性價比", "cleanliness": "衛生",
             "mtr_distance": "交通", "ambience": "環境", "seating": "座位"}

REVIEW_TEXT: dict[str, dict[str, list[str]]] = {
    "taste": {
        "pos": [
            "{dish}真係水準之選，{dish2}火候足、唔齁鹹。",
            "湯底夠鮮，一飲就知唔係粉料沖嘅。",
            "{dish}口感穩定，第{n}次嚟都係同一水準。",
            "味道好紮實，{dish}食落有鑊氣。",
            "The {dish_en} was genuinely excellent — seasoned well and not overcooked.",
            "Flavour was deep without being salty; the stock is clearly made in-house.",
        ],
        "neg": [
            "味道偏淡，要自己加豉油先有味。",
            "{dish}凍咗先上，食落有啲淋。",
            "成餸太鹹，食完要飲兩杯水。",
            "The {dish_en} was bland, and the sauce tasted jar-made.",
            "Overall flavour fell flat; nothing made us want to order it again.",
        ],
        "mid": [
            "味道中規中矩，無特別驚喜亦無大錯。",
            "Taste is fine for the price, nothing memorable.",
        ],
    },
    "service": {
        "pos": [
            "店員記得我哋上次食咩，換餸加水都主動處理，服務好細心。",
            "落單五分鐘內有茶水小食，服務喺{district_zh}來講算快。",
            "知道我有食物敏感，逐道菜替我同廚房確認，跟得好到位。",
            "Staff remembered our usual order and checked back twice — attentive without hovering.",
        ],
        "neg": [
            "叫咗三次先有人過嚟加水，服務跟唔上。",
            "問菜式成分店員都答唔落，要自己對住單張睇。",
            "外賣同堂食分唔清楚，搞咗成半個鐘先坐低，安排混亂。",
            "Service was inattentive; nobody refilled water or cleared plates for 40 minutes.",
        ],
        "mid": [
            "服務有禮但普通，自己要開口叫先會有反應。",
            "Service was functional, neither warm nor cold.",
        ],
    },
    "waiting_time": {
        "pos": [
            "星期六晚上七點半到，等咗{wait}分鐘就入到，算快。",
            "用App 攞咗飛，到店即刻入座，完全無等。",
            "上菜好快，{wait}分鐘內全部到齊。",
            "Walked in at peak and were seated within {wait} minutes.",
        ],
        "neg": [
            "無位等咗{wait}分鐘，中途完全無提示，下次未必再嚟。",
            "等咗成個鐘先有人叫飛，最後放棄走咗。",
            "上菜慢到離譜，半個鐘先見第一碟。",
            "Waited {wait} minutes for a table we had already booked — not acceptable.",
        ],
        "mid": [
            "等咗{wait}分鐘，可以理解但都有啲長。",
            "About {wait} minutes wait, which is tolerable.",
        ],
    },
    "noise": {
        "pos": [
            "地方唔大但係靜，傾嘢完全唔使提高聲量，適合約會。",
            "工作日午市好寧靜，坐低睇書都得。",
            "Music was low enough to hold a conversation across the table.",
        ],
        "neg": [
            "太吵，食飯要對住大嗌，傾偈好辛苦。",
            "隔籬枱係旅行團，由頭吵到尾。",
            "抽氣扇同廚房聲好大，坐近吧台完全靜唔到。",
            "Extremely loud — hard to hear your own table.",
        ],
        "mid": [
            "人滿時有啲吵，但唔算聽唔到嘢。",
            "Buzzing when full but manageable.",
        ],
    },
    "portion": {
        "pos": [
            "兩個人叫三個餸一碗飯，食到好飽還有剩。",
            "{dish}份量实在，四個人加兩餸就夠食。",
            "Portion was generous — there were leftovers for lunch the next day.",
        ],
        "neg": [
            "份量偏細，兩個人要加多兩餸先飽。",
            "一碟{dish}得七八件，收HK${price}有啲兒嬉。",
            "Portion felt skimpy for what we paid.",
        ],
        "mid": [
            "份量適中，食得啱好。",
            "Portion is average for the style.",
        ],
    },
    "value": {
        "pos": [
            "人均{ticket}有湯有餸有飲品，喺區內算抵食。",
            "午市套餐HK${price}包飲品甜品，性價比高。",
            "Good value for this area — we spent about {ticket} each and left full.",
        ],
        "neg": [
            "人均{ticket}，質素同價格唔算匹配。",
            "加了一服務費變相貴咗，性價比一般。",
            "Not worth HK${price} for what actually arrived.",
        ],
        "mid": [
            "價格合理，唔算便宜亦唔算貴。",
            "Pricing is about right, neither a bargain nor a rip.",
        ],
    },
    "cleanliness": {
        "pos": [
            "枱面餐具都好乾淨，洗手間都有专人定時檢查。",
            "Everything spotless, including the restrooms.",
        ],
        "neg": [
            "枱面有油漬，餐具要用紙巾抹過先敢用。",
            "地面黏腳，枱凳腳都有污漬。",
            "Tables and floors were sticky; we wiped our own cutlery.",
        ],
        "mid": [
            "整潔程度一般，最緊要無異味。",
            "Reasonably clean, nothing special.",
        ],
    },
    "mtr_distance": {
        "pos": [
            "出咗{mtr}站{exit}出口行{mtr_min}分鐘就到，返工前食飯唔趕。",
            "離{mtr_zh}港鐵站好近，行{mtr_min}分鐘，夜返都放心。",
            "Only a {mtr_min}-minute walk from {mtr} station, very convenient.",
        ],
        "neg": [
            "無港鐵直去，行路要{mtr_min}分鐘，夜返冇車好麻煩。",
            "由{mtr_zh}站到嚟要行成段斜路，帶小朋友唔方便。",
            "Far from the MTR — budget {mtr_min} minutes each way.",
        ],
        "mid": [
            "搭地鐵去都要行十零分鐘，接受到。",
            "A fair walk from the station but workable.",
        ],
    },
    "ambience": {
        "pos": [
            "燈光偏暖，裝修簡潔，坐低食飯好舒服。",
            "位間開揚有植物，影相好睇，约会首选。",
            "Warm lighting and a calm room — nice for a slow dinner.",
        ],
        "neg": [
            "裝修舊，燈光白得刺眼，無乜氣氛。",
            "同食街排檔隔籬，油煙飄入嚟，環境唔及格。",
            "The interior is tired and the lighting is harsh.",
        ],
        "mid": [
            "環境普通，乾淨整齊就OK。",
            "Plain but tidy.",
        ],
    },
    "seating": {
        "pos": [
            "有卡位同高凳，推車都放得落，帶小朋友方便。",
            "枱距開揚，坐低傾兩粒鐘都唔辛苦。",
            "Roomy seating with space to spread out.",
        ],
        "neg": [
            "枱距太密，隔籬枱講嘢聽到一清二楚。",
            "得八張枱，超過四個人根本坐唔埋。",
            "Tables are packed together with almost no elbow room.",
        ],
        "mid": [
            "座位一般，人滿時會稍微擠。",
            "Seating is tight when busy.",
        ],
    },
}

REVIEW_OPENER = {
    "zh-HK": [
        "{dow}晚同{party}嚟{district_zh}食飯，",
        "{occasion}，揀咗{district_zh}呢間，",
        "第{n}次嚟，仲係{hh}點幾到，",
        "由{mtr_zh}站行{mtr_min}分鐘到，",
    ],
    "en": [
        "Visited on a {dow_en} with {party_en}, ",
        "Third visit for {occasion_en}; ",
        "Stopped by after work, ",
        "Came specifically for the {dish_en}, ",
    ],
}
REVIEW_CLOSER = {
    "zh-HK": ["整體{return}。", "會唔會再嚟：{return}。", "推薦畀{who}。", "結論{return}。"],
    "en": ["Overall, {return}.", "Would return: {return}.", "Recommended for {who}."],
}
VERDICT = {
    "pos_zh": ["值得再嚟", "會回轉嚟", "推薦", "幾值得", "值得一試"],
    "neg_zh": ["未必再嚟", "唔推薦", "要考慮清楚先好嚟", "只能講一般", "要有心理準備"],
    "mid_zh": ["普通", "一般", "有機會先再嚟"],
    "pos_en": ["worth a return", "would come back", "recommended", "a solid pick"],
    "neg_en": ["would not rush back", "hard to recommend", "not for me", "skip it"],
    "mid_en": ["just okay", "so-so", "fine if nothing else is open"],
}
WHO = {"zh-HK": ["鍾意安靜嘅人", "帶小朋友嘅家庭", "朋友聚會", "趕時間嘅返工族", "情侶"],
       "en": ["a quiet date", "families with kids", "a late crew", "a quick solo bite"]}
OCCASION = {"zh-HK": ["情侶約會", "家庭聚餐", "同事收工", "生日飯", "週末早午餐"],
            "en": ["a date night", "a family lunch", "a post-work catch-up", "a birthday", "brunch"]}
PARTY = {"zh-HK": ["女朋友", "屋企人", "三個朋友", "同事", "細路"],
         "en": ["my partner", "the family", "three friends", "colleagues"]}
DOW_ZH = ["一", "二", "三", "四", "五", "六", "日"]
DOW_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MIX_CONNECTORS = ["即係話", "老實講", "如題", "講真", "簡單講"]

SESSION_LABEL = {
    "lunch": ("午市", "Lunch"), "dinner": ("晚市", "Dinner"), "class": ("課堂", "Class"),
    "appt": ("預約時段", "Appointment"), "play": ("玩樂時段", "Play Slot"),
    "stay": ("入住", "Check-in"), "session": ("場次", "Session"),
}
