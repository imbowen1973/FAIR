// Making a library that does not exist yet.
//
// Opening a repo assumed a repo. Every path into the workbench did:
// there was no way to start, only ways to continue. So the first library
// somebody makes had to be assembled by hand from the format docs, which
// is a poor introduction to a tool whose whole claim is that content
// lives in git without ceremony.
//
// What a new library needs is small and completely determined:
//
//   course.yaml                  what the course is, and its sessions
//   competencies/framework.yaml  the threads that build across sessions
//   outcomes.yaml                what it claims to teach
//   template.pptx                the deck's brand
//   layout-map.yaml              which layout each region binds to
//   layout-geometry.json         where those placeholders are
//   attribution.yaml             the funder credit, burnt into slides
//   blocks/<id>/block.yaml       the first session
//   blocks/<id>/slides.md        its deck, opening on title and outcomes
//   blocks/<id>/lessonplan.md    how it is taught
//
// The four that cannot be written as text -- the template and the files
// derived from it -- are fetched from this site's own /seed/. Not out of
// git: provisioning would then depend on this repository's name, and
// would break the day it is renamed.

/** A repo name GitHub will take, from whatever the author typed. */
export function repoNameFrom(title) {
  const slug = String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return slug || "new-library";
}

/** A block id: ordered, so the folder listing is the running order. */
export function blockIdFrom(title, index = 1) {
  const number = String(index).padStart(2, "0");
  return `${number}-${repoNameFrom(title).slice(0, 60)}`;
}

/** What GitHub will refuse, said before the request rather than after. */
export function checkName(name) {
  if (!name) return "Give the library a name.";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    return "A repository name can only hold letters, numbers, dot, dash and underscore.";
  }
  if (name.length > 100) return "That name is too long for GitHub.";
  if (name === "." || name === "..") return "That name is not allowed.";
  return null;
}

const q = (value) => JSON.stringify(String(value ?? ""));

/**
 * The text files a new library starts with.
 *
 * Written out here rather than kept as a fixture, because each one is
 * the shape the format documents describe and a fixture drifts from the
 * documentation without anything saying so.
 */
export function seedFiles({ title, description = "", blockTitle, blockId, author = "" }) {
  const course = [
    `title: ${q(title)}`,
    `description: ${q(description || `The ${title} module.`)}`,
    "structure:",
    `  - block: ${blockId}`,
    "",
  ].join("\n");

  const framework = [
    "# Competencies build across sessions: what a learner can do by the",
    "# end of the module, not by the end of any one session.",
    "competencies:",
    "  C1:",
    `    label: ${q(`Core practice in ${title}`)}`,
    "    description: >-",
    "      Replace this with what somebody can do after the whole module.",
    "",
  ].join("\n");

  // Outcomes belong to a session. The catalogue is where they are
  // stored, not where they are authored.
  const outcomes = [
    "# Learning outcomes, one per session, each developing competencies.",
    "# Authored in the session; stored here because slides and questions",
    "# reference them by id and ids have to be unique.",
    "outcomes:",
    "  O1:",
    `    statement: ${q(`Describe what ${blockTitle} is for.`)}`,
    `    block: ${blockId}`,
    "    develops: [C1]",
    "",
  ].join("\n");

  const block = [
    `title: ${q(blockTitle)}`,
    "duration_minutes: 45",
    "outcomes: [O1]",
    "resources: []",
    "",
  ].join("\n");

  // The deck opens on the two slides filled from the library rather than
  // typed, so a title cannot drift from block.yaml.
  const slides = [
    "---",
    "session: '01'",
    `title: ${q(blockTitle)}`,
    "version: 0.1.0",
    ...(author ? ["dc:", `  creator: ${q(author)}`] : []),
    "---",
    "",
    "--- slide",
    "id: s-01",
    "layout: Title",
    "role: title",
    "---",
    "",
    "--- slide",
    "id: s-02",
    "layout: Full",
    "role: outcomes",
    "---",
    "",
  ].join("\n");

  const lessonplan = [
    `# ${blockTitle}`,
    "",
    "## What this session is for",
    "",
    "The problem behind it: what do these people currently do that this",
    "session should change?",
    "",
    "## Learning outcomes",
    "",
    "- O1 - describe what this session is for",
    "",
    "## Running order",
    "",
    "| Minutes | What happens |",
    "|---|---|",
    "| 5 | Opening, and why this matters here |",
    "| 30 | The content, broken by an activity |",
    "| 10 | Debrief, and what to do differently |",
    "",
    "Timings that do not add up are the commonest fault. Check them.",
    "",
    "## What to prepare",
    "",
    "-",
    "",
  ].join("\n");

  const readme = [
    `# ${title}`,
    "",
    description || `The ${title} module.`,
    "",
    "This is an **eduFAIR library**: teaching content as markdown in git,",
    "rendered into PowerPoint, Word and Moodle XML by a deterministic",
    "renderer. The commit is the fact; rendered files are derived.",
    "",
    "Edit it in the workbench - nothing to install:",
    "",
    "<https://imbowen1973.github.io/FAIR/workbench/>",
    "",
    "## What is here",
    "",
    "| Path | What it is |",
    "|---|---|",
    "| `course.yaml` | The course, and its sessions in order |",
    "| `outcomes.yaml` | What it claims to teach |",
    "| `competencies/framework.yaml` | The threads that build across sessions |",
    "| `blocks/` | One folder per session |",
    "| `template.pptx` | The deck's brand |",
    "| `layout-map.yaml` | Which layout and placeholder each region binds to |",
    "| `layout-geometry.json` | Where those placeholders are, so the canvas is true |",
    "",
  ].join("\n");

  return [
    { path: "README.md", content: readme },
    { path: "course.yaml", content: course },
    { path: "competencies/framework.yaml", content: framework },
    { path: "outcomes.yaml", content: outcomes },
    { path: `blocks/${blockId}/block.yaml`, content: block },
    { path: `blocks/${blockId}/slides.md`, content: slides },
    { path: `blocks/${blockId}/lessonplan.md`, content: lessonplan },
  ];
}

/** The binary and derived files, from this site's own /seed/. */
export const SEED_ASSETS = [
  { path: "template.pptx", from: "../seed/template.pptx", binary: true },
  { path: "layout-map.yaml", from: "../seed/layout-map.yaml" },
  { path: "layout-geometry.json", from: "../seed/layout-geometry.json" },
  { path: "attribution.yaml", from: "../seed/attribution.yaml" },
];

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000; // argument limits, not memory, decide this
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Fetch the seed assets, ready to commit. */
export async function fetchSeedAssets(assets = SEED_ASSETS, fetcher = fetch) {
  const out = [];
  for (const asset of assets) {
    const res = await fetcher(asset.from);
    if (!res.ok) {
      throw new Error(
        `cannot read the starting ${asset.path} (${res.status}). ` +
          "The workbench needs its own seed files to make a library."
      );
    }
    out.push(
      asset.binary
        ? {
            path: asset.path,
            base64: bytesToBase64(new Uint8Array(await res.arrayBuffer())),
          }
        : { path: asset.path, content: await res.text() }
    );
  }
  return out;
}

/**
 * Create the repository and fill it, in one commit.
 *
 * One commit rather than several: a half-seeded library is not a
 * library, and a failure part way through would leave a repository the
 * workbench itself would refuse to open.
 *
 * The seed assets are fetched *before* the repository is created, so a
 * missing one fails while there is still nothing to clean up.
 */
export async function provisionLibrary(
  gh,
  { login, name, title, description = "", blockTitle, isPrivate = true, status = () => {} }
) {
  const problem = checkName(name);
  if (problem) throw new Error(problem);

  status(`Checking ${login}/${name}...`);
  if (await gh.repoExists(login, name)) {
    throw new Error(`${login}/${name} already exists. Pick another name.`);
  }

  status("Fetching the starting template...");
  const assets = await fetchSeedAssets();

  status(`Creating ${login}/${name}...`);
  const repo = await gh.createRepo({ name, description, private: isPrivate });
  const branch = repo.default_branch || "main";

  const blockId = blockIdFrom(blockTitle, 1);
  const files = [
    ...seedFiles({ title, description, blockTitle, blockId, author: login }),
    ...assets,
  ];

  status(`Filling it: ${files.length} files...`);
  await gh.commit(login, name, branch, `Start the ${title} library`, files);

  return { owner: login, repo: name, branch, blockId, files: files.map((f) => f.path) };
}
