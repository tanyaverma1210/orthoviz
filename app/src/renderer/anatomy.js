// Plain-language names, groups and default colours for TotalSegmentator structures.

export const GROUPS = [
  { id: "spine", title: "Spine" },
  { id: "cord", title: "Spinal cord" },
  { id: "bones", title: "Other bones" },
  { id: "vessels", title: "Blood vessels" },
  { id: "organs", title: "Organs" },
  { id: "muscles", title: "Muscles" },
];

const BONE = 0xe9dfc9;

const REGIONS = {
  C: { word: "neck", latin: "cervical" },
  T: { word: "upper-back", latin: "thoracic" },
  L: { word: "lower-back", latin: "lumbar" },
};

const SPECIAL_VERTEBRAE = { C1: "the atlas", C2: "the axis" };

// Plain words for anatomical terms; anything not listed is humanized from the label.
const PLAIN = {
  skull: "Skull",
  sternum: "Breastbone",
  costal_cartilages: "Rib cartilage",
  clavicula: "collarbone",
  scapula: "shoulder blade",
  humerus: "upper arm bone",
  femur: "thigh bone",
  hip: "hip bone",
  sacrum: "Sacrum (tailbone base)",
  spinal_cord: "Spinal cord",
  trachea: "Windpipe (trachea)",
  esophagus: "Food pipe (esophagus)",
  thyroid_gland: "Thyroid gland",
  brain: "Brain",
  heart: "Heart",
  aorta: "Aorta (main artery)",
  brachiocephalic_trunk: "Brachiocephalic artery",
  superior_vena_cava: "Superior vena cava (main vein)",
  common_carotid_artery: "carotid artery",
  subclavian_artery: "subclavian artery",
  brachiocephalic_vein: "brachiocephalic vein",
  autochthon: "deep back muscles",
  iliopsoas: "hip flexor muscle",
  gluteus_maximus: "buttock muscle (large)",
  gluteus_medius: "buttock muscle (middle)",
  gluteus_minimus: "buttock muscle (small)",
  lung_upper_lobe: "lung, upper lobe",
  lung_middle_lobe: "lung, middle lobe",
  lung_lower_lobe: "lung, lower lobe",
};

const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th"];

/** Details for a vertebra label such as "vertebrae_C3", or null for anything else. */
export function vertebraInfo(name) {
  const m = name.match(/^vertebrae_([CTL])(\d+)$/);
  if (!m) return null;
  const [, region, num] = m;
  const code = `${region}${num}`;
  const r = REGIONS[region];
  const special = SPECIAL_VERTEBRAE[code];
  return {
    code,
    order: "CTL".indexOf(region) * 100 + Number(num),
    description: `${ORDINALS[Number(num)]} ${r.word} vertebra (${r.latin})${special ? `, ${special}` : ""}`,
  };
}

function humanize(base) {
  return base.replace(/_/g, " ");
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Splits e.g. "rib_left_3" -> {base: "rib", side: "left", index: "3"}. */
function parseName(name) {
  const m = name.match(/^(.*?)_(left|right)(?:_(\d+))?$/);
  return m ? { base: m[1], side: m[2], index: m[3] } : { base: name };
}

function displayName(name) {
  const v = vertebraInfo(name);
  if (v) return `${v.code} vertebra`;
  if (name === "vertebrae_S1") return "S1 vertebra";

  const rib = name.match(/^rib_(left|right)_(\d+)$/);
  if (rib) return `${capitalize(rib[1])} rib ${rib[2]}`;

  const { base, side } = parseName(name);
  const plain = PLAIN[base] ?? humanize(base);
  return side ? `${capitalize(side)} ${plain}` : capitalize(plain);
}

function groupAndStyle(name) {
  if (/^vertebrae_|^sacrum$/.test(name)) return { group: "spine", color: BONE };
  if (name === "spinal_cord") return { group: "cord", color: 0xf2c14e };
  if (name === "costal_cartilages") return { group: "bones", color: 0xc9d6df };
  if (/^(skull|rib_|sternum|clavicula|scapula|humerus|hip|femur)/.test(name)) return { group: "bones", color: BONE };
  if (/artery|aorta|brachiocephalic_trunk|iliac_artery/.test(name)) return { group: "vessels", color: 0xd0453a, opacity: 0.55 };
  if (/vein|vena_cava/.test(name)) return { group: "vessels", color: 0x4a7fc9, opacity: 0.55 };
  if (/autochthon|iliopsoas|gluteus/.test(name)) return { group: "muscles", color: 0xb0645a, opacity: 0.22 };
  if (/lung/.test(name)) return { group: "organs", color: 0xe8a0a8, opacity: 0.1 };
  return { group: "organs", color: 0xc49a6c, opacity: 0.3 };
}

/**
 * Everything the UI needs to know about a structure.
 * `sortKey` orders the spine top-to-bottom and pairs left/right structures elsewhere.
 */
export function describe(name) {
  const style = groupAndStyle(name);
  const v = vertebraInfo(name);
  const display = displayName(name);
  const { base, side, index } = parseName(name);
  const sortKey = v
    ? String(v.order).padStart(4, "0")
    : `${base}|${String(index ?? 0).padStart(3, "0")}|${side ?? ""}`;
  return {
    name,
    display,
    // Short label shown on the 3D view when selected: "C3" for vertebrae, the display name otherwise.
    tag: v ? v.code : display,
    detail: v ? v.description : null,
    isVertebra: Boolean(v),
    sortKey,
    ...style,
  };
}
