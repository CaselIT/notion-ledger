import {
  parseBoolean,
  parseFilenameStrategy,
  parseRootPageIds,
  resolveOutputDirectory,
  type FilenameStrategy,
} from "./inputs";
import { runMirror, type MirrorLogger, type MirrorResult } from "./lib";

export interface CliMirrorInputs {
  notionToken: string;
  rootPageIds: string[];
  outputDir: string;
  addFrontmatter: boolean;
  deleteOrphans: boolean;
  fullExport: boolean;
  filenameStrategy: FilenameStrategy;
}

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function readCliInputs(
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory: string = process.cwd(),
): CliMirrorInputs {
  const workspace = environment.BUILD_SOURCESDIRECTORY || currentDirectory;
  return {
    notionToken: requiredEnvironmentValue(environment, "NOTION_TOKEN"),
    rootPageIds: parseRootPageIds(requiredEnvironmentValue(environment, "ROOT_PAGES")),
    outputDir: resolveOutputDirectory(
      workspace,
      environment.OUTPUT_DIR || "docs/notion",
    ),
    addFrontmatter: parseBoolean(
      environment.ADD_FRONTMATTER || "true",
      "ADD_FRONTMATTER",
    ),
    deleteOrphans: parseBoolean(
      environment.DELETE_ORPHANS || "true",
      "DELETE_ORPHANS",
    ),
    fullExport: parseBoolean(
      environment.FULL_EXPORT || "false",
      "FULL_EXPORT",
    ),
    filenameStrategy: parseFilenameStrategy(
      environment.FILENAME_STRATEGY || "slug-and-id",
    ),
  };
}

function environmentFlag(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

const isAzurePipelines = environmentFlag("TF_BUILD");
const debugEnabled = environmentFlag("NOTION_LEDGER_DEBUG")
  || environmentFlag("SYSTEM_DEBUG");

const logger: MirrorLogger = {
  debug: (message) => {
    if (debugEnabled) {
      console.log(isAzurePipelines ? `##[debug]${message}` : `DEBUG ${message}`);
    }
  },
  info: console.log,
  warn: (message) => {
    console.warn(isAzurePipelines ? `##[warning]${message}` : message);
  },
};

function setAzureOutputs(result: MirrorResult): void {
  if (!isAzurePipelines) {
    return;
  }
  const outputs = {
    "pages-exported": result.pagesExported,
    "pages-changed": result.pagesChanged,
    "pages-deleted": result.pagesDeleted,
  };
  for (const [name, value] of Object.entries(outputs)) {
    console.log(`##vso[task.setvariable variable=${name};isOutput=true]${value}`);
  }
}

export async function runCli(): Promise<void> {
  const result = await runMirror({
    ...readCliInputs(),
    logger,
  });
  setAzureOutputs(result);
}

export function reportCliFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(isAzurePipelines ? `##[error]${message}` : message);
  process.exitCode = 1;
}