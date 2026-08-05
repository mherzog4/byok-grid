import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultWorkflowDirectory = resolve(repositoryRoot, '.github/workflows');
const remoteActionPattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/u;
const dockerActionPattern = /^docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/u;

export function verifyWorkflowSource(source, filename = '<workflow>') {
  const lines = source.split(/\r?\n/u);
  const issues = [];
  const policySource = lines.map(stripYamlComment).join('\n');

  if (/\bpull_request_target\b/u.test(policySource)) {
    issues.push(`${filename}: pull_request_target is forbidden.`);
  }
  if (/\bworkflow_run\b/u.test(policySource)) {
    issues.push(`${filename}: workflow_run is forbidden.`);
  }
  if (/^\s*permissions:\s*(?:write-all|read-all)\s*$/mu.test(policySource)) {
    issues.push(`${filename}: scalar permissions are forbidden.`);
  }
  if (!/^concurrency:\s*$/mu.test(policySource)) {
    issues.push(`${filename}: a top-level concurrency policy is required.`);
  }
  if (rustMatrixUsesManualBuildMode(lines)) {
    issues.push(
      `${filename}: CodeQL Rust must use build-mode none; manual mode is unsupported.`
    );
  }

  const workflowPermissions = /^permissions:\s*$/mu.test(policySource);
  const jobs = workflowJobs(lines);
  if (jobs.length === 0) issues.push(`${filename}: no jobs were found.`);
  for (const job of jobs) {
    if (
      !job.lines.some((line) =>
        /^    timeout-minutes:\s*[1-9]\d*\s*$/u.test(stripYamlComment(line))
      )
    ) {
      issues.push(
        `${filename}: job ${job.name} requires a positive timeout-minutes.`
      );
    }
    if (
      !workflowPermissions &&
      !job.lines.some((line) =>
        /^    permissions:\s*$/u.test(stripYamlComment(line))
      )
    ) {
      issues.push(
        `${filename}: job ${job.name} requires explicit permissions.`
      );
    }
    if (
      job.lines.some((line) =>
        /^      (?:GH_TOKEN|GITHUB_TOKEN):\s*/u.test(stripYamlComment(line))
      )
    ) {
      issues.push(
        `${filename}: job ${job.name} must scope GitHub tokens to the step that uses them.`
      );
    }
    if (
      jobRunsReleaseVerification(job.lines) &&
      !jobHasFullHistoryCheckout(job.lines)
    ) {
      issues.push(
        `${filename}: job ${job.name} runs release verification and requires actions/checkout with fetch-depth: 0.`
      );
    }
  }

  let actionCount = 0;
  for (const [index, line] of lines.entries()) {
    const reference = actionReference(line);
    if (!reference) continue;
    actionCount += 1;
    if (
      !reference.startsWith('./') &&
      !remoteActionPattern.test(reference) &&
      !dockerActionPattern.test(reference)
    ) {
      issues.push(
        `${filename}:${index + 1}: action ${reference} must use a full immutable commit or image digest.`
      );
    }
    if (
      reference.split('@', 1)[0] === 'actions/checkout' &&
      !checkoutDisablesCredentialPersistence(lines, index)
    ) {
      issues.push(
        `${filename}:${index + 1}: actions/checkout must set persist-credentials: false.`
      );
    }
  }

  return { actionCount, issues };
}

export async function verifyWorkflowDirectory(
  directory = defaultWorkflowDirectory
) {
  const filenames = (await readdir(directory))
    .filter((filename) => /\.ya?ml$/u.test(filename))
    .sort();
  const issues = [];
  let actionCount = 0;
  for (const filename of filenames) {
    const result = verifyWorkflowSource(
      await readFile(resolve(directory, filename), 'utf8'),
      filename
    );
    actionCount += result.actionCount;
    issues.push(...result.issues);
  }
  return { actionCount, issues, workflowCount: filenames.length };
}

function workflowJobs(lines) {
  const jobsIndex = lines.findIndex((line) =>
    /^jobs:\s*$/u.test(stripYamlComment(line))
  );
  if (jobsIndex < 0) return [];
  const starts = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(
      stripYamlComment(lines[index] ?? '')
    );
    if (match) starts.push({ index, name: match[1] });
  }
  return starts.map((start, position) => ({
    lines: lines.slice(
      start.index + 1,
      starts[position + 1]?.index ?? lines.length
    ),
    name: start.name,
  }));
}

function actionReference(line) {
  const match = /^\s*(?:-\s*)?uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/u.exec(
    line
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function rustMatrixUsesManualBuildMode(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const entry = /^(\s*)-\s+language:\s*['"]?rust['"]?\s*$/u.exec(
      stripYamlComment(lines[index] ?? '')
    );
    if (!entry) continue;
    const entryIndent = entry[1]?.length ?? 0;
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = stripYamlComment(lines[next] ?? '');
      if (!line.trim()) continue;
      const currentIndent = indentation(line);
      if (currentIndent < entryIndent) break;
      if (currentIndent === entryIndent && line.trimStart().startsWith('-')) {
        break;
      }
      if (/^\s*build-mode:\s*['"]?manual['"]?\s*$/u.test(line)) return true;
    }
  }
  return false;
}

function checkoutDisablesCredentialPersistence(lines, usesIndex) {
  const usesIndent = indentation(lines[usesIndex] ?? '');
  const stepIndent = Math.max(0, usesIndent - 2);
  for (let index = usesIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) continue;
    const currentIndent = indentation(line);
    if (
      currentIndent < stepIndent ||
      (currentIndent === stepIndent && line.trimStart().startsWith('-'))
    ) {
      break;
    }
    if (
      /^\s*persist-credentials:\s*(?:false|'false'|"false")\s*(?:#.*)?$/u.test(
        line
      )
    ) {
      return true;
    }
  }
  return false;
}

function jobRunsReleaseVerification(lines) {
  return lines.some((line) =>
    /\bnpm\s+run\s+release:verify-version\b/u.test(stripYamlComment(line))
  );
}

function jobHasFullHistoryCheckout(lines) {
  return lines.some((line, index) => {
    const reference = actionReference(line);
    return (
      reference?.split('@', 1)[0] === 'actions/checkout' &&
      checkoutFetchesFullHistory(lines, index)
    );
  });
}

function checkoutFetchesFullHistory(lines, usesIndex) {
  const usesIndent = indentation(lines[usesIndex] ?? '');
  const stepIndent = Math.max(0, usesIndent - 2);
  for (let index = usesIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) continue;
    const currentIndent = indentation(line);
    if (
      currentIndent < stepIndent ||
      (currentIndent === stepIndent && line.trimStart().startsWith('-'))
    ) {
      break;
    }
    if (/^\s*fetch-depth:\s*(?:0|'0'|"0")\s*(?:#.*)?$/u.test(line)) {
      return true;
    }
  }
  return false;
}

function indentation(line) {
  return /^\s*/u.exec(line)?.[0].length ?? 0;
}

function stripYamlComment(line) {
  return line.replace(/\s+#.*$/u, '').trimEnd();
}

async function main() {
  const directory = process.argv[2]
    ? resolve(process.argv[2])
    : defaultWorkflowDirectory;
  const result = await verifyWorkflowDirectory(directory);
  if (result.issues.length > 0) {
    for (const issue of result.issues) console.error(issue);
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      actions: result.actionCount,
      marker: 'BYOK_GRID_WORKFLOW_POLICY_VERIFIED',
      workflows: result.workflowCount,
    })
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
