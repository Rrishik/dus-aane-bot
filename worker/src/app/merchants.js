// Canonical merchant normalizer, brand/corporate dictionary, CC-bill card
// detector, and deterministic per-category quick-chip suggestions.
import { TAG_MAX_LEN } from "./constants.js";

// Built-in canonical brands & corporate legal names (tier below personal and
// crowd-promoted D1 `merchant_rules`). Ordered longest-pattern-first at module
// load so specific sub-brands ("swiggy instamart", "amazon pay") win over
// broader parent patterns ("swiggy", "amazon").
const RAW_BRAND_RULES = [
  // Food
  ["swiggy instamart", "Instamart", "Groceries"],
  ["instamart", "Instamart", "Groceries"],
  ["bundl tech", "Swiggy", "Food"],
  ["scootsy", "Swiggy", "Food"],
  ["swiggy", "Swiggy", "Food"],
  ["eternal ltd", "Zomato", "Food"],
  ["zomato", "Zomato", "Food"],
  ["eazydiner", "EazyDiner", "Food"],
  ["rebel foods", "EatSure", "Food"],
  ["eatsure", "EatSure", "Food"],
  ["tata starbucks", "Starbucks", "Food"],
  ["starbucks", "Starbucks", "Food"],
  ["hardcastle", "McDonald's", "Food"],
  ["mcdonald", "McDonald's", "Food"],
  ["jubilant food", "Domino's", "Food"],
  ["domino", "Domino's", "Food"],
  ["burger king", "Burger King", "Food"],
  ["pizza hut", "Pizza Hut", "Food"],
  ["barbeque nation", "Barbeque Nation", "Food"],
  ["third wave coffee", "Third Wave Coffee", "Food"],
  ["third wave", "Third Wave Coffee", "Food"],
  ["blue tokai", "Blue Tokai", "Food"],
  ["theobroma", "Theobroma", "Food"],
  ["haldiram", "Haldiram's", "Food"],
  ["chaayos", "Chaayos", "Food"],
  ["kfc", "KFC", "Food"],
  ["subway", "Subway", "Food"],

  // Groceries
  ["blink commerce", "Blinkit", "Groceries"],
  ["grofers", "Blinkit", "Groceries"],
  ["blinkit", "Blinkit", "Groceries"],
  ["kirana kart", "Zepto", "Groceries"],
  ["kiranakart", "Zepto", "Groceries"],
  ["zepto", "Zepto", "Groceries"],
  ["innovative retail", "BigBasket", "Groceries"],
  ["supermarket grocery", "BigBasket", "Groceries"],
  ["bigbasket", "BigBasket", "Groceries"],
  ["avenue supermart", "DMart", "Groceries"],
  ["avenue e-commerce", "DMart", "Groceries"],
  ["avenue e commerce", "DMart", "Groceries"],
  ["avenue ecommerce", "DMart", "Groceries"],
  ["d-mart", "DMart", "Groceries"],
  ["dmart", "DMart", "Groceries"],
  ["trent hypermarket", "Star Bazaar", "Groceries"],
  ["star bazaar", "Star Bazaar", "Groceries"],
  ["jiomart", "JioMart", "Groceries"],
  ["country delight", "Country Delight", "Groceries"],
  ["nature's basket", "Nature's Basket", "Groceries"],
  ["natures basket", "Nature's Basket", "Groceries"],
  ["ratnadeep", "Ratnadeep", "Groceries"],
  ["licious", "Licious", "Groceries"],
  ["retail groceries", "Groceries", "Groceries"],

  // Shopping
  ["amazon pay", "Amazon Pay", "Shopping"],
  ["amazon", "Amazon", "Shopping"],
  ["flipkart", "Flipkart", "Shopping"],
  ["myntra", "Myntra", "Shopping"],
  ["ajio", "Ajio", "Shopping"],
  ["meesho", "Meesho", "Shopping"],
  ["fsn e-commerce", "Nykaa", "Shopping"],
  ["fsn ecommerce", "Nykaa", "Shopping"],
  ["nykaa", "Nykaa", "Shopping"],
  ["tata cliq", "Tata Cliq", "Shopping"],
  ["reliance digital", "Reliance Digital", "Shopping"],
  ["infiniti retail", "Croma", "Shopping"],
  ["croma", "Croma", "Shopping"],
  ["decathlon", "Decathlon", "Shopping"],
  ["ikea", "IKEA", "Shopping"],
  ["uniqlo", "Uniqlo", "Shopping"],
  ["westside", "Westside", "Shopping"],
  ["trent", "Westside", "Shopping"],
  ["zudio", "Zudio", "Shopping"],
  ["firstcry", "FirstCry", "Shopping"],
  ["lenskart", "Lenskart", "Shopping"],
  ["h&m", "H&M", "Shopping"],
  ["zara", "Zara", "Shopping"],

  // Travel
  ["uber", "Uber", "Travel"],
  ["ola cabs", "Ola", "Travel"],
  ["ani technologies", "Ola", "Travel"],
  ["roppen", "Rapido", "Travel"],
  ["rapido", "Rapido", "Travel"],
  ["blusmart", "BluSmart", "Travel"],
  ["namma yatri", "Namma Yatri", "Travel"],
  ["irctc", "IRCTC", "Travel"],
  ["interglobe", "IndiGo", "Travel"],
  ["indigo", "IndiGo", "Travel"],
  ["tata sia", "Air India", "Travel"],
  ["vistara", "Air India", "Travel"],
  ["air india", "Air India", "Travel"],
  ["akasa", "Akasa Air", "Travel"],
  ["spicejet", "SpiceJet", "Travel"],
  ["makemytrip", "MakeMyTrip", "Travel"],
  ["goibibo", "Goibibo", "Travel"],
  ["cleartrip", "Cleartrip", "Travel"],
  ["ixigo", "Ixigo", "Travel"],
  ["redbus", "RedBus", "Travel"],
  ["booking.com", "Booking.com", "Travel"],
  ["agoda", "Agoda", "Travel"],
  ["airbnb", "Airbnb", "Travel"],
  ["indian oil", "IndianOil", "Travel"],
  ["indianoil", "IndianOil", "Travel"],
  ["iocl", "IndianOil", "Travel"],
  ["hindustan petroleum", "HP Petrol", "Travel"],
  ["hpcl", "HP Petrol", "Travel"],
  ["bharat petroleum", "Bharat Petroleum", "Travel"],
  ["bpcl", "Bharat Petroleum", "Travel"],
  ["fastag", "FASTag", "Travel"],

  // Bills & Subscriptions
  ["urbanclap", "Urban Company", "Bills"],
  ["urban company", "Urban Company", "Bills"],
  ["mygate", "MyGate", "Bills"],
  ["nobroker", "NoBroker", "Bills"],
  ["act fibernet", "ACT Fibernet", "Bills"],
  ["airtel", "Airtel", "Bills"],
  ["jio", "Jio", "Bills"],
  ["vodafone", "Vi", "Bills"],
  ["bescom", "BESCOM", "Bills"],
  ["tsspdcl", "TSSPDCL", "Bills"],
  ["tata power", "Tata Power", "Bills"],
  ["adani electricity", "Adani Electricity", "Bills"],
  ["netflix", "Netflix", "Bills"],
  ["spotify", "Spotify", "Bills"],
  ["youtube", "YouTube", "Bills"],
  ["icloud", "Apple", "Bills"],
  ["apple.com", "Apple", "Bills"],
  ["google play", "Google Play", "Bills"],
  ["google one", "Google One", "Bills"],
  ["prime video", "Prime Video", "Bills"],
  ["jiohotstar", "Hotstar", "Bills"],
  ["hotstar", "Hotstar", "Bills"],
  ["sonyliv", "SonyLIV", "Bills"],
  ["chatgpt", "ChatGPT", "Bills"],
  ["openai", "OpenAI", "Bills"],

  // Health
  ["apollo pharm", "Apollo Pharmacy", "Health"],
  ["medplus", "MedPlus", "Health"],
  ["pharmeasy", "PharmEasy", "Health"],
  ["tata 1mg", "1mg", "Health"],
  ["1mg", "1mg", "Health"],
  ["practo", "Practo", "Health"],
  ["cult.fit", "Cult.fit", "Health"],
  ["cultfit", "Cult.fit", "Health"],
  ["curefit", "Cult.fit", "Health"],
  ["healthians", "Healthians", "Health"],
  ["thyrocare", "Thyrocare", "Health"],

  // Fun
  ["bigtree", "BookMyShow", "Fun"],
  ["bookmyshow", "BookMyShow", "Fun"],
  ["pvr inox", "PVR INOX", "Fun"],
  ["playstation", "PlayStation", "Fun"],
  ["xbox", "Xbox", "Fun"],
  ["steamgames", "Steam", "Fun"],
  ["playo", "Playo", "Fun"],
  ["hudle", "Hudle", "Fun"],

  // Invest
  ["indian clearing", "Mutual Funds", "Invest", "investment"],
  ["bse star", "Mutual Funds", "Invest", "investment"],
  ["nse clearing", "Mutual Funds", "Invest", "investment"],
  ["iccl", "Mutual Funds", "Invest", "investment"],
  ["mf central", "MF Central", "Invest", "investment"],
  ["zerodha", "Zerodha", "Invest", "investment"],
  ["groww", "Groww", "Invest", "investment"],
  ["upstox", "Upstox", "Invest", "investment"],
  ["kuvera", "Kuvera", "Invest", "investment"],
  ["indmoney", "INDmoney", "Invest", "investment"],
  ["smallcase", "Smallcase", "Invest", "investment"],
  ["wint wealth", "Wint Wealth", "Invest", "investment"],
  ["goldenpi", "GoldenPi", "Invest", "investment"],

  // Credit-card bill gateways
  ["dreamplug", "CC Bill", "Transfer", "transfer"],
  ["cred club", "CC Bill", "Transfer", "transfer"],
  ["billdesk cc", "CC Bill", "Transfer", "transfer"],
  ["cheq", "CC Bill", "Transfer", "transfer"],
  ["sbi card", "CC Bill", "Transfer", "transfer"]
];

export const CANONICAL_BRAND_RULES = RAW_BRAND_RULES.map(([pattern, name, category, kind = null]) => ({
  pattern,
  name,
  category,
  kind,
  personal: false
})).sort((a, b) => b.pattern.length - a.pattern.length);

// Exact shorthand/generic labels -> canonical casing + category.
export const CANONICAL_GENERIC_LABELS = {
  sip: { name: "Mutual Funds", category: "Invest" },
  sips: { name: "Mutual Funds", category: "Invest" },
  mf: { name: "Mutual Funds", category: "Invest" },
  "mutual fund": { name: "Mutual Funds", category: "Invest" },
  "mutual funds": { name: "Mutual Funds", category: "Invest" },
  stocks: { name: "Stocks", category: "Invest" },
  gold: { name: "Gold", category: "Invest" },
  fd: { name: "FD / NPS", category: "Invest" },
  nps: { name: "FD / NPS", category: "Invest" },
  ppf: { name: "FD / NPS", category: "Invest" },
  "cc bill": { name: "CC Bill", category: "Transfer" },
  "card bill": { name: "CC Bill", category: "Transfer" },
  "cc bill payment": { name: "CC Bill", category: "Transfer" },
  "credit card bill": { name: "CC Bill", category: "Transfer" },
  cred: { name: "CC Bill", category: "Transfer" },
  "self transfer": { name: "Self Transfer", category: "Transfer" },
  emi: { name: "EMI", category: "Transfer" },
  salary: { name: "Salary", category: "Income" },
  dividend: { name: "Dividend", category: "Income" },
  dividends: { name: "Dividend", category: "Income" },
  interest: { name: "Interest", category: "Income" },
  cashback: { name: "Cashback", category: "Refund" },
  refund: { name: "Refund", category: "Refund" },
  reimburse: { name: "Reimbursement", category: "Refund" },
  reimbursement: { name: "Reimbursement", category: "Refund" },
  rent: { name: "Rent", category: "Bills" },
  maintenance: { name: "Maintenance", category: "Bills" },
  electricity: { name: "Electricity", category: "Bills" },
  maid: { name: "Househelp", category: "Bills" },
  cook: { name: "Househelp", category: "Bills" },
  househelp: { name: "Househelp", category: "Bills" },
  wifi: { name: "Broadband", category: "Bills" },
  broadband: { name: "Broadband", category: "Bills" },
  subs: { name: "Subscription", category: "Bills" },
  subscription: { name: "Subscription", category: "Bills" },
  subscriptions: { name: "Subscription", category: "Bills" },
  petrol: { name: "Fuel", category: "Travel" },
  diesel: { name: "Fuel", category: "Travel" },
  fuel: { name: "Fuel", category: "Travel" },
  cab: { name: "Cab", category: "Travel" },
  auto: { name: "Auto", category: "Travel" },
  metro: { name: "Metro", category: "Travel" },
  flight: { name: "Flight", category: "Travel" },
  pharmacy: { name: "Pharmacy", category: "Health" },
  medicine: { name: "Pharmacy", category: "Health" },
  doctor: { name: "Doctor", category: "Health" },
  "lab test": { name: "Lab Test", category: "Health" },
  fitness: { name: "Fitness", category: "Health" },
  gym: { name: "Fitness", category: "Health" },
  movies: { name: "Movies", category: "Fun" },
  kirana: { name: "Kirana", category: "Groceries" },
  avenue: { name: "DMart", category: "Groceries" },
  "d mart": { name: "DMart", category: "Groceries" },
  veggies: { name: "Fruits & Veggies", category: "Groceries" },
  "fruits & veggies": { name: "Fruits & Veggies", category: "Groceries" },
  supermarket: { name: "Supermarket", category: "Groceries" },
  dining: { name: "Dining", category: "Food" },
  cafe: { name: "Cafe", category: "Food" }
};

export const QUICK_MERCHANT_CHIPS = {
  debit: {
    Food: ["Dining", "Cafe", "Chai"],
    Groceries: ["Kirana", "Fruits & Veggies", "Supermarket"],
    Shopping: ["Apparel", "Electronics", "Gifts"],
    Travel: ["Cab", "Auto", "Fuel"],
    Bills: ["Rent", "Maintenance", "Electricity", "Househelp"],
    Health: ["Pharmacy", "Doctor", "Lab Test"],
    Fun: ["Movies", "Events", "Sports"],
    Invest: ["Mutual Funds", "Stocks", "Gold"],
    Transfer: ["CC Bill", "Self Transfer", "Family"]
  },
  credit: {
    Income: ["Salary", "Dividend", "Interest"],
    Refund: ["Refund", "Cashback", "Reimbursement"],
    Transfer: ["Self Transfer", "Settlement"]
  }
};

const UPPER_ACRONYMS = new Set([
  "CC",
  "EMI",
  "ATM",
  "UPI",
  "NEFT",
  "IMPS",
  "RTGS",
  "FD",
  "RD",
  "NPS",
  "PPF",
  "MF",
  "PVR",
  "INOX",
  "IRCTC",
  "HDFC",
  "ICICI",
  "SBI",
  "AXIS",
  "HSBC",
  "AMEX",
  "BESCOM",
  "TSSPDCL",
  "ACT",
  "KFC",
  "IKEA",
  "H&M",
  "HP",
  "VI"
]);

const LOWER_PARTICLES = new Set(["and", "of", "the", "in", "on", "at", "to", "for", "by"]);

const GATEWAY_PREFIX_RE =
  /^(?:RAZORPAY|PAYTM|PHONEPE|BHARATPE|PINE\s*LABS|CASHFREE|BILLDESK|CCAVENUE|PAYU|STRIPE)\s*(?:[*_\-|/]+|\s+)(?=[A-Za-z0-9])/i;

const LEGAL_SUFFIX_RE =
  /(?:[\s,.]+(?:INDIA|IN))?[\s,.]+(?:PVT\.?\s*LTD\.?|PRIVATE\s+LIMITED|CO\.?\s*,?\s*LT(?:D\.?)?|COMPANY\s+LIMITED|LIMITED|LTD\.?|LLP|INC\.?|CORP\.?|CORPORATION|TECHNOLOGIES|TECHNOLOGY|ENTERPRISES)\s*$/i;

const TRAILING_CURRENCY_RE = /\s+(?:THB|USD|EUR|GBP|SGD|AED|INR|JPY|AUD|CAD|CHF|HKD|NZD|SAR|ZAR)$/;

function matchBuiltInBrand(str) {
  const lower = String(str || "").toLowerCase();
  if (!lower) return null;
  // Whole-word check for very short patterns (<= 4 chars like "kfc", "1mg") to avoid substring false positives.
  for (const rule of CANONICAL_BRAND_RULES) {
    if (rule.pattern.length <= 4) {
      const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("(^|[^a-z0-9])" + escaped + "($|[^a-z0-9])", "i").test(lower)) return rule;
    } else if (lower.includes(rule.pattern)) {
      return rule;
    }
  }
  return null;
}

export function smartTitleCase(str) {
  const s = String(str || "").trim();
  if (!s) return "";
  const hasLetters = /[A-Za-z]/.test(s);
  if (!hasLetters) return s;

  const isAllUpper = s === s.toUpperCase();
  const isAllLower = s === s.toLowerCase();
  // Preserve intentional mixed-case strings ("McDonald's", "Bob's", "CC Bill · Infinia").
  if (!isAllUpper && !isAllLower) return s;

  const words = s.split(/\s+/);
  return words
    .map((word, idx) => {
      const upper = word.toUpperCase();
      if (UPPER_ACRONYMS.has(upper)) return upper;
      const lower = word.toLowerCase();
      if (idx > 0 && LOWER_PARTICLES.has(lower)) return lower;
      return lower.replace(/(^|[&/'\-.])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
    })
    .join(" ");
}

// Clean & canonicalize a raw or user-supplied merchant string.
// Returns `{ merchant, category, kind }` where `merchant` is null if `raw` is
// empty, "Unknown", or an opaque non-brand UPI VPA handle (e.g. "ox...@pty").
export function canonicalizeMerchant(raw, personalAndSharedRules = []) {
  const orig = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!orig) return { merchant: null, category: null, kind: null };
  const lowerOrig = orig.toLowerCase();
  if (lowerOrig === "unknown" || lowerOrig === "untagged") {
    return { merchant: null, category: null, kind: null };
  }

  // Exact generic alias match ("sip" -> "Mutual Funds", "cc bill" -> "CC Bill").
  const exactGeneric = CANONICAL_GENERIC_LABELS[lowerOrig];
  if (exactGeneric) {
    return { merchant: exactGeneric.name, category: exactGeneric.category, kind: null };
  }

  // Handle UPI VPA strings (`handle@bank`): keep brand if recognizable (`swiggy@ybl`), drop opaque QR handles.
  if (/^[\w.\-+]+@[\w.\-]+$/.test(orig) || orig.includes("...@")) {
    const vpaPrefix = orig.split("@")[0].replace(/[0-9_.\-+]+$/g, "");
    for (const r of personalAndSharedRules || []) {
      if (orig.toLowerCase().includes(r.pattern) && r.name) {
        return { merchant: r.name, category: r.category || null, kind: r.kind || null };
      }
    }
    const brandFromVpa = matchBuiltInBrand(vpaPrefix);
    if (brandFromVpa) {
      return { merchant: brandFromVpa.name, category: brandFromVpa.category, kind: brandFromVpa.kind };
    }
    return { merchant: null, category: null, kind: null };
  }

  // 1. Personal & crowd-shared D1 rules take top priority.
  for (const r of personalAndSharedRules || []) {
    if (lowerOrig.includes(r.pattern) && r.name) {
      return { merchant: r.name, category: r.category || null, kind: r.kind || null };
    }
  }

  // 2. Strip gateway prefixes, trailing currency codes (on uppercase raw), and legal suffixes.
  let cleaned = orig.replace(GATEWAY_PREFIX_RE, "").trim();
  if (orig === orig.toUpperCase()) {
    cleaned = cleaned.replace(TRAILING_CURRENCY_RE, "").trim();
  }
  const strippedLegal = cleaned
    .replace(LEGAL_SUFFIX_RE, "")
    .replace(/[\s,.;:*-]+$/, "")
    .trim();
  if (strippedLegal.length >= 2) cleaned = strippedLegal;

  // Re-check generic label after stripping noise (e.g. "RAZORPAY RETAIL GROCERIES" -> "Retail Groceries").
  const afterGeneric = CANONICAL_GENERIC_LABELS[cleaned.toLowerCase()];
  if (afterGeneric) {
    return { merchant: afterGeneric.name, category: afterGeneric.category, kind: null };
  }

  // 3. Built-in canonical brand catalog.
  const brand = matchBuiltInBrand(cleaned) || matchBuiltInBrand(orig);
  if (brand) {
    return { merchant: brand.name, category: brand.category, kind: brand.kind };
  }

  // 4. Smart Title Case fallback, bounded to TAG_MAX_LEN.
  const titled = smartTitleCase(cleaned).slice(0, TAG_MAX_LEN).trim();
  return { merchant: titled || null, category: null, kind: null };
}

export function normalizeMerchantName(raw, rules = []) {
  return canonicalizeMerchant(raw, rules).merchant;
}

// Normalize an explicit user-entered merchant tag: snaps generic aliases ("sip"
// -> "Mutual Funds", "cc bill" -> "CC Bill") and exact brand spellings ("dmart"
// -> "DMart", "mygate" -> "MyGate"), otherwise applies Smart Title Case without
// rewriting arbitrary multi-word strings.
export function normalizeUserMerchantInput(raw) {
  const s = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const lower = s.toLowerCase();
  if (CANONICAL_GENERIC_LABELS[lower]) {
    return CANONICAL_GENERIC_LABELS[lower].name;
  }
  for (const r of CANONICAL_BRAND_RULES) {
    if (r.name.toLowerCase() === lower || r.pattern === lower) {
      return r.name;
    }
  }
  return smartTitleCase(s).slice(0, TAG_MAX_LEN).trim();
}

// Detect credit card bill payments that name the target credit card's last 4 digits.
const CC_BILL_CARD_PATTERNS = [
  /\b(?:payment|paid|received|credited|towards|for)\b[^.\n]{0,60}?\b(?:credit\s+)?card\s+(?:ending(?:\s+(?:in|with))?|no\.?|number|[xX*#-]+)\s*[xX*#-]*(\d{4})\b/i,
  /\bcredit\s+card\s*[xX*#-]*(\d{4})\b[^.\n]{0,40}?\b(?:payment|bill|credited|received)\b/i,
  /\b(?:bill\s+payment|cc\s+bill|card\s+payment)\b[^.\n]{0,50}?[xX*#](\d{4})\b/i,
  /\b(?:NEFT|IMPS|UPI|AUTOPAY)\b[^.\n]{0,40}?\b(?:CC|CARD)\s*[xX*#-]*(\d{4})\b/i
];

export function detectCcBillCardLast4(sourceText) {
  const s = String(sourceText || "");
  if (!s) return null;
  // Avoid matching normal POS spends ("spent on HDFC Bank Card 5678 at NETFLIX").
  if (/\bspent\s+(?:on|using)\b/i.test(s) && !/\b(?:bill|payment\s+received)\b/i.test(s)) return null;
  for (const re of CC_BILL_CARD_PATTERNS) {
    const m = re.exec(s);
    if (m && m[1]) return m[1];
  }
  return null;
}

export function formatCcBillMerchant(cardLast4, cardLabelsMap = {}) {
  const digits = cardLast4 ? String(cardLast4).trim() : "";
  if (digits && cardLabelsMap[digits]) {
    return ("CC Bill · " + cardLabelsMap[digits]).slice(0, TAG_MAX_LEN);
  }
  if (digits) return "CC Bill *" + digits;
  const allCards = Object.values(cardLabelsMap).filter(Boolean);
  if (allCards.length === 1) {
    return ("CC Bill · " + allCards[0]).slice(0, TAG_MAX_LEN);
  }
  return "CC Bill";
}

// Deterministic 3-4 quick-pick merchant chips for an unnamed transaction in `category`.
export function quickMerchantChoices({ direction = "debit", category, cardLabelsMap = {}, recentMerchants = [] }) {
  const dirKey = direction === "credit" ? "credit" : "debit";
  const defaults = (QUICK_MERCHANT_CHIPS[dirKey] && QUICK_MERCHANT_CHIPS[dirKey][category]) || [];
  const picks = [];
  const add = (label) => {
    const clean = String(label || "").trim();
    if (!clean || clean.length > TAG_MAX_LEN) return;
    if (picks.some((p) => p.toLowerCase() === clean.toLowerCase())) return;
    picks.push(clean);
  };

  if (dirKey === "debit" && category === "Transfer") {
    for (const [last4, name] of Object.entries(cardLabelsMap)) {
      add(("CC Bill · " + (name || "*" + last4)).slice(0, TAG_MAX_LEN));
      if (picks.length >= 2) break;
    }
  }

  for (const m of recentMerchants) {
    if (picks.length >= 2) break;
    add(m);
  }
  for (const d of defaults) {
    if (picks.length >= 4) break;
    add(d);
  }
  return picks.slice(0, 4);
}

// Idempotent per-tenant sweep normalizing any remaining ALL-CAPS, all-lowercase,
// or uncanonicalized historical `transactions.merchant` and `merchant_rules.name` rows.
export async function normalizeTenantMerchants(db, tenantId, rules = [], now = Date.now()) {
  const tid = String(tenantId);
  const stmts = [];

  // 1. Normalize saved `merchant_rules.name` first so stale personal rule names
  //    ("AVENUE" / "Avenue" / "sip") don't shadow canonical brand names below.
  const ruleRows = (
    await db
      .prepare("SELECT pattern, name FROM merchant_rules WHERE tenant_id = ? AND name IS NOT NULL AND TRIM(name) <> ''")
      .bind(tid)
      .all()
  ).results;
  for (const rr of ruleRows) {
    const nextName = normalizeMerchantName(rr.name, []);
    if (nextName && nextName !== rr.name) {
      stmts.push(
        db
          .prepare("UPDATE merchant_rules SET name = ?, updated_at = ? WHERE tenant_id = ? AND pattern = ?")
          .bind(nextName, now, tid, rr.pattern)
      );
    }
  }
  const normalizedRules = (rules || []).map((r) => ({
    ...r,
    name: r.name ? normalizeMerchantName(r.name, []) || r.name : r.name
  }));

  // 2. Normalize historical transaction merchants (recovering truncated raw
  //    corporate names when `merchant_raw` contains a canonical brand).
  const rows = (
    await db
      .prepare(
        "SELECT id, direction, kind, category, merchant, merchant_raw FROM transactions WHERE tenant_id = ? AND status <> 'deleted' AND merchant IS NOT NULL AND TRIM(merchant) <> ''"
      )
      .bind(tid)
      .all()
  ).results;

  for (const r of rows) {
    let canon = canonicalizeMerchant(r.merchant, normalizedRules);
    if (
      !canon.category &&
      r.merchant_raw &&
      r.merchant_raw.toLowerCase().includes(String(r.merchant || "").toLowerCase())
    ) {
      const rawCanon = canonicalizeMerchant(r.merchant_raw, normalizedRules);
      if (rawCanon.merchant && rawCanon.category) canon = rawCanon;
    }
    const next = canon.merchant;
    let nextCat = r.category || (r.direction === "debit" ? canon.category : null) || null;
    let nextKind = r.kind;
    if (r.direction === "debit" && next && /^CC Bill(?:\b|\s)/i.test(next) && r.kind === "spend") {
      nextCat = "Transfer";
      nextKind = "transfer";
    } else if (r.direction === "debit" && next === "Mutual Funds" && r.kind === "spend") {
      nextCat = "Invest";
      nextKind = "investment";
    }
    if (next !== r.merchant || nextCat !== r.category || nextKind !== r.kind) {
      stmts.push(
        db
          .prepare(
            "UPDATE transactions SET merchant = ?, category = ?, kind = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
          )
          .bind(next, nextCat, nextKind, now, r.id, tid)
      );
    }
  }
  if (stmts.length > 0) {
    for (let i = 0; i < stmts.length; i += 40) {
      await db.batch(stmts.slice(i, i + 40));
    }
  }
  return stmts.length;
}
