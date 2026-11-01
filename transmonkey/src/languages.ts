import { ToolError } from "./errors";

export interface DetectionAlternative {
  language: string;
  language_name: string;
  confidence: number;
}

export interface DetectionResult {
  language: string;
  language_name: string;
  confidence: number;
  is_reliable: boolean;
  method: string;
  alternatives: DetectionAlternative[];
  script: string;
  letter_count: number;
}

const LANGUAGE_NAMES: Record<string, string> = {
  af: "Afrikaans",
  am: "Amharic",
  ar: "Arabic",
  az: "Azerbaijani",
  be: "Belarusian",
  bg: "Bulgarian",
  bn: "Bengali",
  bo: "Tibetan",
  bs: "Bosnian",
  ca: "Catalan",
  cht: "Chinese (Traditional)",
  cs: "Czech",
  cy: "Welsh",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  et: "Estonian",
  fa: "Persian",
  fi: "Finnish",
  fil: "Filipino",
  fr: "French",
  ga: "Irish",
  gl: "Galician",
  gu: "Gujarati",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  hy: "Armenian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  ka: "Georgian",
  kk: "Kazakh",
  km: "Khmer",
  kn: "Kannada",
  ko: "Korean",
  lo: "Lao",
  lt: "Lithuanian",
  lv: "Latvian",
  mk: "Macedonian",
  ml: "Malayalam",
  mn: "Mongolian",
  mr: "Marathi",
  ms: "Malay",
  mt: "Maltese",
  my: "Burmese",
  ne: "Nepali",
  nl: "Dutch",
  no: "Norwegian",
  pa: "Punjabi",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  si: "Sinhala",
  sk: "Slovak",
  sl: "Slovenian",
  sq: "Albanian",
  sr: "Serbian",
  sv: "Swedish",
  sw: "Swahili",
  ta: "Tamil",
  te: "Telugu",
  th: "Thai",
  ti: "Tigrinya",
  tr: "Turkish",
  uk: "Ukrainian",
  ur: "Urdu",
  uz: "Uzbek",
  vi: "Vietnamese",
  yue: "Cantonese",
  zh: "Chinese (Simplified)",
  und: "Undetermined",
};

const NAME_TO_CODE: Record<string, string> = {
  afrikaans: "af",
  amharic: "am",
  arabic: "ar",
  armenian: "hy",
  azerbaijani: "az",
  belarusian: "be",
  bengali: "bn",
  bosnian: "bs",
  bulgarian: "bg",
  burmese: "my",
  catalan: "ca",
  chinese: "zh",
  "chinese simplified": "zh",
  "chinese traditional": "cht",
  cantonese: "yue",
  croatian: "hr",
  czech: "cs",
  danish: "da",
  dutch: "nl",
  english: "en",
  estonian: "et",
  filipino: "fil",
  finnish: "fi",
  french: "fr",
  galician: "gl",
  georgian: "ka",
  german: "de",
  greek: "el",
  gujarati: "gu",
  hebrew: "he",
  hindi: "hi",
  hungarian: "hu",
  icelandic: "is",
  indonesian: "id",
  irish: "ga",
  italian: "it",
  japanese: "ja",
  kannada: "kn",
  kazakh: "kk",
  khmer: "km",
  korean: "ko",
  lao: "lo",
  latvian: "lv",
  lithuanian: "lt",
  macedonian: "mk",
  malay: "ms",
  malayalam: "ml",
  maltese: "mt",
  marathi: "mr",
  mongolian: "mn",
  nepali: "ne",
  norwegian: "no",
  persian: "fa",
  polish: "pl",
  portuguese: "pt",
  punjabi: "pa",
  romanian: "ro",
  russian: "ru",
  serbian: "sr",
  sinhala: "si",
  slovak: "sk",
  slovenian: "sl",
  spanish: "es",
  swahili: "sw",
  swedish: "sv",
  tamil: "ta",
  telugu: "te",
  thai: "th",
  tibetan: "bo",
  tigrinya: "ti",
  turkish: "tr",
  ukrainian: "uk",
  urdu: "ur",
  uzbek: "uz",
  vietnamese: "vi",
  welsh: "cy",
};

/** ISO-639-3 / legacy codes seen in the ImgKits demo files. */
const CODE_ALIASES: Record<string, string> = {
  ara: "ar",
  bel: "be",
  ben: "bn",
  chi_sim: "zh",
  chi_tra: "cht",
  ces: "cs",
  cht: "cht",
  dan: "da",
  deu: "de",
  ell: "el",
  eng: "en",
  fas: "fa",
  fil: "fil",
  fin: "fi",
  fra: "fr",
  heb: "he",
  hin: "hi",
  hun: "hu",
  hye: "hy",
  ind: "id",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  msa: "ms",
  nld: "nl",
  nor: "no",
  pol: "pl",
  por: "pt",
  ron: "ro",
  rus: "ru",
  slk: "sk",
  spa: "es",
  srp: "sr",
  swe: "sv",
  tam: "ta",
  tha: "th",
  tur: "tr",
  ukr: "uk",
  urd: "ur",
  vie: "vi",
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

/**
 * Normalise a caller-supplied language name or code into a short code the
 * upstream endpoints understand. Throws on malformed input so validation
 * happens before any credit charge.
 */
export function normalizeLanguageCode(value: string, allowAuto = false): string {
  const rawInput = value.trim().toLowerCase();
  if (!rawInput) throw new ToolError("Language code must not be empty.", "invalid_language");

  if (rawInput === "auto" || rawInput === "automatic" || rawInput === "detect") {
    if (allowAuto) return "auto";
    throw new ToolError("Target language cannot be 'auto'.", "invalid_language");
  }

  // Legacy OCR codes use underscores (chi_sim, chi_tra). Check them before
  // converting separators.
  const underscoreAlias = CODE_ALIASES[rawInput];
  if (underscoreAlias) return underscoreAlias;

  const raw = rawInput.replace(/_/g, "-").replace(/\s+/g, " ");
  const nameKey = raw.replace(/[^a-z0-9]+/g, " ").trim();
  const nameHit = NAME_TO_CODE[raw] ?? NAME_TO_CODE[nameKey];
  if (nameHit) return nameHit;

  const aliasHit = CODE_ALIASES[raw];
  if (aliasHit) return aliasHit;

  const base = raw.split("-")[0];
  const baseAlias = CODE_ALIASES[base];
  if (baseAlias) return baseAlias;
  const baseName = NAME_TO_CODE[base];
  if (baseName) return baseName;

  if (base === "zh") {
    if (raw.includes("tw") || raw.includes("hk") || raw.includes("hant")) return "cht";
    return "zh";
  }

  if (/^[a-z]{2,3}$/.test(base)) return base;

  throw new ToolError(
    `Unrecognised language '${value}'. Pass a short code such as en, zh, ja, ko, fr, de, es, ru, ar, or a common English name.`,
    "invalid_language",
  );
}

const SCRIPT_PATTERNS: Array<{ script: string; re: RegExp }> = [
  { script: "Han", re: /\p{Script=Han}/gu },
  { script: "Hiragana", re: /\p{Script=Hiragana}/gu },
  { script: "Katakana", re: /\p{Script=Katakana}/gu },
  { script: "Hangul", re: /\p{Script=Hangul}/gu },
  { script: "Cyrillic", re: /\p{Script=Cyrillic}/gu },
  { script: "Arabic", re: /\p{Script=Arabic}/gu },
  { script: "Hebrew", re: /\p{Script=Hebrew}/gu },
  { script: "Greek", re: /\p{Script=Greek}/gu },
  { script: "Devanagari", re: /\p{Script=Devanagari}/gu },
  { script: "Bengali", re: /\p{Script=Bengali}/gu },
  { script: "Tamil", re: /\p{Script=Tamil}/gu },
  { script: "Telugu", re: /\p{Script=Telugu}/gu },
  { script: "Kannada", re: /\p{Script=Kannada}/gu },
  { script: "Malayalam", re: /\p{Script=Malayalam}/gu },
  { script: "Gujarati", re: /\p{Script=Gujarati}/gu },
  { script: "Gurmukhi", re: /\p{Script=Gurmukhi}/gu },
  { script: "Thai", re: /\p{Script=Thai}/gu },
  { script: "Lao", re: /\p{Script=Lao}/gu },
  { script: "Khmer", re: /\p{Script=Khmer}/gu },
  { script: "Myanmar", re: /\p{Script=Myanmar}/gu },
  { script: "Sinhala", re: /\p{Script=Sinhala}/gu },
  { script: "Tibetan", re: /\p{Script=Tibetan}/gu },
  { script: "Georgian", re: /\p{Script=Georgian}/gu },
  { script: "Armenian", re: /\p{Script=Armenian}/gu },
  { script: "Ethiopic", re: /\p{Script=Ethiopic}/gu },
  { script: "Latin", re: /\p{Script=Latin}/gu },
];

const SCRIPT_LANGUAGE: Record<string, string> = {
  Arabic: "ar",
  Armenian: "hy",
  Bengali: "bn",
  Devanagari: "hi",
  Ethiopic: "am",
  Georgian: "ka",
  Greek: "el",
  Gujarati: "gu",
  Gurmukhi: "pa",
  Hangul: "ko",
  Hebrew: "he",
  Hiragana: "ja",
  Kannada: "kn",
  Katakana: "ja",
  Khmer: "km",
  Lao: "lo",
  Malayalam: "ml",
  Myanmar: "my",
  Sinhala: "si",
  Tamil: "ta",
  Telugu: "te",
  Thai: "th",
  Tibetan: "bo",
};

// Compact function-word lists. They only need to distinguish common
// languages; the result is explicitly reported as heuristic and unreliable
// for very short strings.
const STOPWORDS: Record<string, string[]> = {
  en: "the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were has had should would could can not this that these those".split(" "),
  es: "el la de que y a en un ser se no haber por con su para como estar tener le lo todo pero mas hacer o poder decir este ir otro ese si me ya ver porque dar cuando el muy sin vez mucho saber que sobre mi alguno mismo yo tambien hasta ano dos querer entre asi primero desde grande eso ni nos llegar pasar tiempo ella dia uno bien poco deber entonces poner cosa tanto hombre parecer nuestro tan donde ahora parte despues vida quedar siempre creer hablar llevar dejar nada cada seguir menos nuevo encontrar los las del al es son esta estan fue han ha habia estos esas esos".split(" "),
  fr: "le la de et les des en un une du est que pour qui dans pas au sur se ce il elle nous vous ils elles avec ne plus par son sa ses mais ou comme etre avoir faire tout cette ces leur leurs y a ou donc si bien deux meme aussi peu tres sans sous entre encore alors toujours jamais rien autre chaque depuis pendant avant apres".split(" "),
  de: "der die und in den von zu das mit sich des auf fur ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem uber einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei welche ihre ihr wir ich du ja nein sehr kann muss soll will".split(" "),
  pt: "o a de que e do da em um para com nao uma os no se na por mais as dos como mas foi ao ele das tem a seu sua ou ser quando muito ha nos ja esta eu tambem so pelo pela ate isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estao voce tinha foram essa num nem suas meu as minha tem numa pelos elas havia seja qual sera nos tenho lhe deles essas esses pelas este fosse dele".split(" "),
  it: "il di che e la a un in per non una mi sono ho con si da come ma io piu al anche se del alla della dei sul nella tra era essere ha ai dalle degli o quindi perche quando molto senza dopo prima ogni ancora sempre gia due tre suo sua loro questo questa questi queste quello quella".split(" "),
  nl: "de het een en van in is dat op te zijn voor met niet aan er om ook als dan maar bij nog door naar uit zich over hij zij wij jullie ik je dit die deze was waren wordt worden kan kunnen moet moeten wil hebben heeft had geen wel veel meer meest zo hoe wat waar wanneer waarom wie omdat tussen tegen zonder na tijdens".split(" "),
  id: "yang dan di ini itu dengan untuk tidak dari dalam akan pada juga saya kamu dia kami kita mereka ada bisa sudah belum karena sebagai oleh ke saat setelah sebelum tentang banyak lebih paling satu dua orang tahun hari waktu baru lagi harus ingin tahu lihat buat jadi".split(" "),
  vi: "va la cua co khong trong duoc cho mot nguoi nhung cac da nay khi voi de ra den tu ve nhu nhung hay thi ma neu vi nen rat cung chi con dang se day do toi ban anh chi em chung ho ai gi sao nao o tren duoi sau truoc".split(" "),
  tr: "ve bir bu da de icin ile cok daha en gibi kadar sonra once ama ancak veya ya eger cunku olarak olan var yok degil ben sen o biz siz onlar ne nasil neden nerede zaman gun yil kisi sey iyi yeni buyuk kucuk".split(" "),
  pl: "i w na z do nie ze sie jest to o a jak ale po dla od za przez sa tak tylko jeszcze juz moze byc ma mial bylo byly ten ta te jego jej ich nas was mnie ciebie go nam wam im ktory ktora ktore kiedy gdzie dlaczego bo wiec oraz lub czy bardzo wiecej naj tez takze tam tutaj".split(" "),
  sv: "och att det som en ett pa ar av for med till den har de inte om men var jag du han hon vi ni mig dig sig oss er dem min din hans hennes var deras detta dessa da nar dar har hur varfor vem vad eftersom ocksa bara mycket mer mest kan ska vill maste hade blev bli vara finns".split(" "),
  da: "og at det som en et pa er af for med til den har de ikke om men var jeg du han hun vi mig dig sig os jer dem min din hans hendes vores deres dette disse da nar hvor her hvordan hvorfor hvem hvad fordi ogsa kun meget mere mest kan skal vil ma havde blev blive vaere findes".split(" "),
  no: "og at det som en et pa er av for med til den har de ikke om men var jeg du han hun vi dere meg deg seg oss deres dette disse da nar hvor her hvordan hvorfor hvem hva fordi ogsa bare mye mer mest kan skal vil ma hadde ble bli vaere finnes".split(" "),
  fi: "ja on ei se etta han oli joka mutta niin kun myos tai jos sen siita tama nama ne me te he mina sina meidan teidan heidan minun sinun hanen mita kuka missa milloin miksi kuinka koska vain paljon enemman eniten voi taytyy haluaa olivat tulee mukaan".split(" "),
  cs: "a v se na je ze do to s z jako ale po pro od za jsou tak jen jeste uz muze byt ma mel bylo byly ten ta ty jeho jeji jejich nas vas me tebe ho ji nam vam jim ktery ktera ktere kdy kde proc protoze take velmi vice nej tam tady".split(" "),
  ro: "si in de la cu pe un o care este sunt nu pentru din se mai ca dar sau daca cand unde cum foarte doar acum aici acolo eu tu el ea noi voi ei ele meu sau nostra vostra lor acest aceasta aceste acesti fi fost are au avea".split(" "),
  hu: "a az es hogy nem is egy van de meg csak mar mint meg el ki be fel le at ha vagy majd most itt ott en te o mi ti ok engem teged ot minket titeket oket ez azt ezt milyen hol mikor miert mert nagyon tobb leg lehet kell akar".split(" "),
  bg: "и в на се е не за с от по като но че да са това този тази тези той тя то ние вие те мен теб него нея нас вас тях кой коя кое кои къде кога защо как много още само сега тук там може трябва иска".split(" "),
  uk: "і в на не що з до як це за у від по але та або ще вже тільки дуже більше можна треба бути є був була були він вона воно ми ви вони мене тебе його її нас вас їх який яка яке які де коли чому тому також тепер тут там".split(" "),
  ru: "и в не на я что он с как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между".split(" "),
};

// Words shared by many languages (a, is, la, ...) carry less signal than
// distinctive words. Precompute how many languages each stopword appears in.
const WORD_LANGUAGE_COUNT = (() => {
  const counts = new Map<string, number>();
  for (const words of Object.values(STOPWORDS)) {
    for (const word of new Set(words)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
})();

const DIACRITIC_HINTS: Array<{ code: string; re: RegExp; weight: number }> = [
  { code: "vi", re: /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/giu, weight: 3 },
  { code: "tr", re: /[ğışİ]/gu, weight: 2 },
  { code: "pl", re: /[ąćęłńóśźż]/giu, weight: 2 },
  { code: "cs", re: /[ěščřžýáíéůťďň]/giu, weight: 2 },
  { code: "ro", re: /[ăâîșț]/giu, weight: 2 },
  { code: "hu", re: /[őű]/giu, weight: 2 },
  { code: "da", re: /[æøå]/giu, weight: 1 },
  { code: "no", re: /[æøå]/giu, weight: 1 },
  { code: "sv", re: /[åäö]/giu, weight: 1 },
];

const TRADITIONAL_HAN = /[們這說國學體龍後發裡為與會來時過還開關門東車馬鳥語讀寫聽]/u;

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function alt(code: string, confidence: number): DetectionAlternative {
  return {
    language: code,
    language_name: languageName(code),
    confidence: Math.round(confidence * 100) / 100,
  };
}

function scriptResult(code: string, script: string, confidence: number, letters: number): DetectionResult {
  return {
    language: code,
    language_name: languageName(code),
    confidence,
    is_reliable: confidence >= 0.55 && letters >= 2,
    method: "unicode_script",
    alternatives: [alt(code, confidence)],
    script,
    letter_count: letters,
  };
}

function detectLatin(text: string, letters: number): DetectionResult {
  const words = (text.toLowerCase().match(/\p{Script=Latin}+/gu) ?? []).filter((w) => w.length > 0);
  const scores: Record<string, number> = {};

  for (const [code, wordsList] of Object.entries(STOPWORDS)) {
    const set = new Set(wordsList);
    let score = 0;
    for (const word of words) {
      if (!set.has(word)) continue;
      const uniqueness = 1 / Math.sqrt(WORD_LANGUAGE_COUNT.get(word) ?? 1);
      score += (word.length >= 4 ? 1.5 : 1) * uniqueness;
    }
    if (score > 0) scores[code] = score;
  }

  for (const hint of DIACRITIC_HINTS) {
    const hits = countMatches(text, hint.re);
    if (hits > 0) scores[hint.code] = (scores[hint.code] ?? 0) + hits * hint.weight;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const alternatives = ranked.slice(0, 3).map(([code, score]) => alt(code, total ? score / total : 0));

  if (ranked.length === 0) {
    // Pure Latin text with no function words: English is the least-bad guess,
    // but mark it unreliable.
    const confidence = words.length >= 3 ? 0.2 : 0.1;
    return {
      language: "en",
      language_name: languageName("en"),
      confidence,
      is_reliable: false,
      method: "latin_heuristic_default",
      alternatives: [alt("en", confidence)],
      script: "Latin",
      letter_count: letters,
    };
  }

  const [code, topScore] = ranked[0];
  const rawConfidence = total > 0 ? topScore / total : 0;
  const lengthFactor = Math.min(1, Math.max(0.25, (words.length || 1) / 10));
  const confidence = Math.round(Math.min(0.99, rawConfidence * (0.55 + 0.45 * lengthFactor)) * 100) / 100;

  return {
    language: code,
    language_name: languageName(code),
    confidence,
    is_reliable: confidence >= 0.5 && words.length >= 3,
    method: "stopwords+diacritics",
    alternatives,
    script: "Latin",
    letter_count: letters,
  };
}

/**
 * Local language detection. No upstream call, no credit charge.
 *
 * It is intentionally a heuristic: Unicode script detection is very reliable
 * for non-Latin scripts; Latin-script languages use function words and
 * diacritics and are marked unreliable for short inputs.
 */
export function detectLanguage(text: string): DetectionResult {
  const trimmed = text.trim();
  if (!trimmed) throw new ToolError("Text must not be empty.", "invalid_text");

  const counts: Record<string, number> = {};
  for (const { script, re } of SCRIPT_PATTERNS) counts[script] = countMatches(trimmed, re);

  const letters = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (letters === 0) {
    return {
      language: "und",
      language_name: languageName("und"),
      confidence: 0,
      is_reliable: false,
      method: "unicode_script",
      alternatives: [],
      script: "None",
      letter_count: 0,
    };
  }

  const kana = counts.Hiragana + counts.Katakana;
  const han = counts.Han;
  const hangul = counts.Hangul;

  if (kana > 0 && (kana + han) / letters >= 0.2) {
    return scriptResult("ja", "Hiragana/Katakana/Han", 0.99, letters);
  }
  if (hangul > 0 && hangul / letters >= 0.2) {
    return scriptResult("ko", "Hangul", 0.99, letters);
  }
  if (han > 0 && han / letters >= 0.2) {
    const code = TRADITIONAL_HAN.test(trimmed) ? "cht" : "zh";
    return scriptResult(code, "Han", Math.min(0.99, 0.7 + (han / letters) * 0.29), letters);
  }

  if (counts.Cyrillic > 0 && counts.Cyrillic / letters >= 0.2) {
    let code = "ru";
    if (/[іїєґ]/iu.test(trimmed)) code = "uk";
    else if (/[ў]/iu.test(trimmed)) code = "be";
    else if (/[ђћџљњ]/iu.test(trimmed)) code = "sr";
    else if (/[ъ]/iu.test(trimmed)) code = "bg";
    return scriptResult(code, "Cyrillic", 0.85, letters);
  }

  const scriptOrder = [
    "Arabic",
    "Hebrew",
    "Greek",
    "Devanagari",
    "Bengali",
    "Tamil",
    "Telugu",
    "Kannada",
    "Malayalam",
    "Gujarati",
    "Gurmukhi",
    "Thai",
    "Lao",
    "Khmer",
    "Myanmar",
    "Sinhala",
    "Tibetan",
    "Georgian",
    "Armenian",
    "Ethiopic",
  ];
  let bestScript = "";
  let bestCount = 0;
  for (const script of scriptOrder) {
    if (counts[script] > bestCount) {
      bestCount = counts[script];
      bestScript = script;
    }
  }
  if (bestScript && bestCount / letters >= 0.2) {
    return scriptResult(SCRIPT_LANGUAGE[bestScript], bestScript, 0.95, letters);
  }

  return detectLatin(trimmed, Math.max(letters, counts.Latin));
}
