import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPageId = "8fe4a1b2123434567890abcdefabcdef";

const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => (
    !name.startsWith("INPUT_")
    && ![
      "ADD_FRONTMATTER",
      "BUILD_SOURCESDIRECTORY",
      "DELETE_ORPHANS",
      "FILENAME_STRATEGY",
      "FULL_EXPORT",
      "GITHUB_OUTPUT",
      "GITHUB_STEP_SUMMARY",
      "GITHUB_WORKSPACE",
      "NOTION_LEDGER_DEBUG",
      "NOTION_TOKEN",
      "OUTPUT_DIR",
      "ROOT_PAGES",
      "SYSTEM_DEBUG",
      "TF_BUILD",
    ].includes(name)
  )),
);

async function createAdapterDirectory(
  adapterName: "action" | "cli",
  librarySource: string,
): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notion-ledger-adapter-"));
  await copyFile(
    path.join(repositoryRoot, "dist", `${adapterName}.cjs`),
    path.join(directory, `${adapterName}.cjs`),
  );
  await writeFile(path.join(directory, "lib.cjs"), librarySource, "utf8");
  return directory;
}

function runAdapter(
  directory: string,
  adapterName: "action" | "cli",
  environment: NodeJS.ProcessEnv,
) {
  const result = spawnSync(process.execPath, [path.join(directory, `${adapterName}.cjs`)], {
    cwd: directory,
    encoding: "utf8",
    env: { ...inheritedEnvironment, ...environment },
  });
  assert.ifError(result.error);
  return result;
}

const successfulLibrary = `
exports.runMirror = async (options) => {
  options.logger.debug("adapter debug");
  options.logger.info("adapter info");
  options.logger.warn("adapter warning");
  return {
    rootsMirrored: 2,
    pagesExported: 3,
    pagesChanged: 2,
    pagesDeleted: 1,
  };
};
`;

test("GitHub Action bundle maps logs, outputs, and the job summary", async () => {
  const directory = await createAdapterDirectory("action", successfulLibrary);
  try {
    const outputFile = path.join(directory, "github-output.txt");
    const summaryFile = path.join(directory, "github-summary.md");
    await writeFile(outputFile, "", "utf8");
    await writeFile(summaryFile, "", "utf8");

    const result = runAdapter(directory, "action", {
      "INPUT_NOTION-TOKEN": "test-token",
      "INPUT_ROOT-PAGES": rootPageId,
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_WORKSPACE: directory,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::debug::adapter debug/);
    assert.match(result.stdout, /adapter info/);
    assert.match(result.stdout, /::warning::adapter warning/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /test-token/);

    const outputs = await readFile(outputFile, "utf8");
    assert.match(outputs, /pages-exported/);
    assert.match(outputs, /pages-changed/);
    assert.match(outputs, /pages-deleted/);
    assert.match(outputs, /(?:^|\r?\n)3(?:\r?\n|$)/);
    assert.match(outputs, /(?:^|\r?\n)2(?:\r?\n|$)/);
    assert.match(outputs, /(?:^|\r?\n)1(?:\r?\n|$)/);

    const summary = await readFile(summaryFile, "utf8");
    assert.match(summary, /<h1>Notion mirror<\/h1>/);
    assert.match(summary, /Roots mirrored/);
    assert.match(summary, /Pages exported/);
    assert.match(summary, /Pages changed/);
    assert.match(summary, /Pages deleted/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CLI bundle emits Azure-native logs and output variables", async () => {
  const directory = await createAdapterDirectory("cli", successfulLibrary);
  try {
    const result = runAdapter(directory, "cli", {
      BUILD_SOURCESDIRECTORY: directory,
      NOTION_TOKEN: "test-token",
      ROOT_PAGES: rootPageId,
      SYSTEM_DEBUG: "true",
      TF_BUILD: "true",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /##\[debug\]adapter debug/);
    assert.match(result.stdout, /adapter info/);
    assert.match(result.stderr, /##\[warning\]adapter warning/);
    assert.match(
      result.stdout,
      /##vso\[task\.setvariable variable=pages-exported;isOutput=true\]3/,
    );
    assert.match(
      result.stdout,
      /##vso\[task\.setvariable variable=pages-changed;isOutput=true\]2/,
    );
    assert.match(
      result.stdout,
      /##vso\[task\.setvariable variable=pages-deleted;isOutput=true\]1/,
    );
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /test-token/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("CLI bundle reports Azure failures and exits unsuccessfully", async () => {
  const directory = await createAdapterDirectory(
    "cli",
    "exports.runMirror = async () => { throw new Error('mirror failed'); };",
  );
  try {
    const result = runAdapter(directory, "cli", {
      BUILD_SOURCESDIRECTORY: directory,
      NOTION_TOKEN: "test-token",
      ROOT_PAGES: rootPageId,
      TF_BUILD: "true",
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /##\[error\]mirror failed/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /test-token/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});