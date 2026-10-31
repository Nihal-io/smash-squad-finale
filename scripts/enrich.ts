// Builds the final candidate pool: 2,000 tech/data resumes from the public dataset, enriched deterministically
// (seed 42) with name, gender, college tier and two role-specific project lines, plus the planted set on top.
// Gender and college are drawn independently of skills. No LLM calls.
import { parquetReadObjects } from "hyparquet";
import { readFileSync, writeFileSync } from "node:fs";
import { redactProfile } from "../src/lib/redact";
import { mulberry32, FIRST_F, FIRST_M, FIRST_NB, LAST, TIER1, TIER2, TIER3, WOMENS_COLLEGE, ALL_COLLEGES, pronouns, type Gender, type Tier } from "../src/lib/synth";

const POOL_SIZE = Number(process.env.POOL_SIZE || 2000);
const TECH_ROLES = new Set(["Backend Engineer", "Software Engineer", "Full Stack Engineer", "Data Analyst", "BI Analyst", "Business Analyst", "Technical Product Manager", "Technical Support Specialist"]);

const rand = mulberry32(42);
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const shuffle = <T>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Synonym banks for template slots.
const VERB = ["Built", "Shipped", "Delivered", "Designed", "Led the rollout of", "Rebuilt", "Owned"];
const IMPROVED = ["cut", "reduced", "brought down", "trimmed"];
const GREW = ["lifted", "raised", "improved", "grew"];
const TEAM = ["a four-person squad", "two product teams", "the platform group", "a cross-functional pod", "an internal tools team"];
const PCT = () => `${[18, 22, 27, 31, 35, 40, 45, 52, 60][Math.floor(rand() * 9)]}%`;

type Tmpl = (s: string, s2: string) => string;
const BANK: Record<string, Tmpl[]> = {
  "Backend Engineer": [
    (s, s2) => `${pick(VERB)} a billing service in ${s} with ${s2}, and ${pick(IMPROVED)} p95 latency by ${PCT()}.`,
    (s, s2) => `${pick(VERB)} an event ingestion pipeline using ${s} and ${s2} for ${pick(TEAM)}.`,
    (s) => `Migrated a monolith's order module to a standalone ${s} service with zero-downtime cutover.`,
    (s, s2) => `Wrote the ${s} integration layer and its ${s2} test harness for a partner API.`,
  ],
  "Software Engineer": [
    (s, s2) => `${pick(VERB)} a scheduling feature end to end in ${s}, with ${s2} covering the edge cases.`,
    (s) => `${pick(VERB)} a CLI in ${s} that ${pick(IMPROVED)} release prep from a day to an hour.`,
    (s, s2) => `Refactored a legacy ${s} codebase and introduced ${s2} across ${pick(TEAM)}.`,
    (s) => `Fixed a long-standing memory leak in a ${s} worker and documented the root cause.`,
  ],
  "Full Stack Engineer": [
    (s, s2) => `${pick(VERB)} a customer portal with ${s} on the front and ${s2} behind it.`,
    (s, s2) => `${pick(VERB)} the onboarding flow in ${s}, which ${pick(GREW)} activation by ${PCT()}; data in ${s2}.`,
    (s) => `Added real-time notifications using ${s} and a small websocket gateway.`,
    (s, s2) => `Set up ${s2} checks and a ${s} component library shared by ${pick(TEAM)}.`,
  ],
  "Data Analyst": [
    (s, s2) => `${pick(VERB)} a churn dashboard in ${s} on top of ${s2} models, used weekly by leadership.`,
    (s) => `Wrote ${s} queries that reconciled finance and product numbers and found a ${PCT()} reporting gap.`,
    (s, s2) => `Ran a funnel analysis with ${s} and ${s2} that ${pick(GREW)} trial conversion by ${PCT()}.`,
    (s) => `Automated a monthly reporting pack in ${s}, saving ${pick(TEAM)} two days a month.`,
  ],
  "BI Analyst": [
    (s, s2) => `${pick(VERB)} a self-serve ${s} reporting layer over a ${s2} warehouse for ${pick(TEAM)}.`,
    (s) => `Defined KPI logic in ${s} so three departments stopped arguing about revenue numbers.`,
    (s, s2) => `Modelled a star schema in ${s2} and rebuilt the executive ${s} dashboards on it.`,
    (s) => `${pick(IMPROVED).replace(/^./, (c) => c.toUpperCase())} dashboard load time by ${PCT()} by tuning ${s} extracts.`,
  ],
  "Business Analyst": [
    (s, s2) => `Mapped the claims process with ${s}, then specified a ${s2} fix that ${pick(IMPROVED)} handling time by ${PCT()}.`,
    (s) => `Wrote requirements and acceptance criteria in ${s} for a payments integration.`,
    (s, s2) => `Ran stakeholder workshops and turned them into a ${s} backlog, tracked in ${s2}.`,
    (s) => `Built a ${s} model that sized the business case for a new pricing tier.`,
  ],
  "Technical Product Manager": [
    (s, s2) => `Owned the roadmap for an internal ${s} platform; shipped ${s2} support that ${pick(GREW)} adoption by ${PCT()}.`,
    (s) => `Wrote PRDs and ${s} specs for a developer-facing API and ran its beta program.`,
    (s, s2) => `Prioritised a ${s} migration with ${pick(TEAM)} and reported progress with ${s2}.`,
    (s) => `Defined success metrics for a ${s} feature and killed it when the numbers said so.`,
  ],
  "Technical Support Specialist": [
    (s, s2) => `Resolved tier-2 ${s} tickets and wrote ${s2} runbooks that ${pick(IMPROVED)} repeat issues by ${PCT()}.`,
    (s) => `Built a ${s} diagnostics script that support agents run before escalating.`,
    (s, s2) => `Handled ${s} incidents for enterprise customers and tracked them in ${s2}.`,
    (s) => `Trained new hires on ${s} troubleshooting and kept the knowledge base current.`,
  ],
};

function pickGender(): Gender {
  const r = rand();
  return r < 0.42 ? "female" : r < 0.94 ? "male" : "non-binary";
}
function pickCollege(gender: Gender): { college: string; tier: Tier } {
  const r = rand();
  const t: Tier = r < 0.25 ? 1 : r < 0.6 ? 2 : 3;
  let pool = t === 1 ? TIER1 : t === 2 ? TIER2 : TIER3;
  if (t === 2 && gender !== "female") pool = pool.filter((c) => c !== WOMENS_COLLEGE);
  return { college: pick(pool), tier: t };
}
function proxy(g: Gender): string {
  if (g === "female" && rand() < 0.3) return pick(["Active in the Women Who Code chapter.", "Mentors women in tech through a campus program.", "Former sorority treasurer."]);
  if (g === "male" && rand() < 0.15) return pick(["Former fraternity chapter lead.", "Plays on the men's cricket team at work."]);
  return "";
}

interface HfResume { resume_id: string; role: string; seniority: string; years_experience: number | bigint; industry: string; education: string; skills: string[]; summary: string; experience_bullets: string[] }

const buf = readFileSync("data/hf/resumes.parquet");
const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const all = (await parquetReadObjects({ file })) as HfResume[];
const tech = all.filter((r) => TECH_ROLES.has(r.role)).sort((a, b) => a.resume_id.localeCompare(b.resume_id));
const sample = shuffle(tech).slice(0, POOL_SIZE).sort((a, b) => a.resume_id.localeCompare(b.resume_id));

const pool = sample.map((r) => {
  const gender = pickGender(); // independent of skills
  const { college, tier } = pickCollege(gender); // independent of skills
  const first = gender === "female" ? pick(FIRST_F) : gender === "male" ? pick(FIRST_M) : pick(FIRST_NB);
  const name = `${first} ${pick(LAST)}`;
  const skills = r.skills.length ? r.skills : ["general tooling"];
  const s1 = pick(skills), s2 = pick(skills.filter((x) => x !== s1).concat(skills.length < 2 ? [s1] : []));
  const bank = BANK[r.role];
  const [t1, t2] = shuffle(bank).slice(0, 2);
  const projects = [t1(s1, s2), t2(s2, s1)];
  const yoe = Number(r.years_experience);
  const pr = pronouns(gender);
  const S = pr.s[0].toUpperCase() + pr.s.slice(1);
  const bio = `${r.summary} ${proxy(gender)}`.trim();
  const visible_text = [
    `${name}. ${bio}`,
    `${first} holds a ${r.education} from ${college}. ${S} would describe ${pr.p} strengths as: ${skills.join(", ")}.`,
    `Projects: ${projects.join(" ")}`,
    `Experience: ${r.experience_bullets.join(". ")}.`,
  ].join("\n");
  const redacted_text = redactProfile({ text: visible_text, names: [name, first, name.split(" ")[1]], colleges: ALL_COLLEGES });
  return {
    id: r.resume_id, source: "hf", name, gender, college, tier, yoe, role: r.role, seniority: r.seniority.toLowerCase(), industry: r.industry, education: r.education,
    skills, projects, bio, visible_text, redacted_text, archetype: r.role.toLowerCase().replace(/\s+/g, "-"), planted: "pool", planted_for: null, flags: [] as string[],
  };
});

const planted = JSON.parse(readFileSync("data/planted.json", "utf8")) as any[];
const candidates = [...planted, ...pool];
writeFileSync("data/candidates.json", JSON.stringify(candidates, null, 0));
const byTier = [1, 2, 3].map((t) => candidates.filter((c) => c.tier === t).length);
const byGender = ["female", "male", "non-binary"].map((g) => candidates.filter((c) => c.gender === g).length);
console.log(`pool: ${pool.length} public + ${planted.length} planted = ${candidates.length}; tiers=${byTier.join("/")} gender(f/m/nb)=${byGender.join("/")}`);
console.log("sample:\n" + pool[0].visible_text);
