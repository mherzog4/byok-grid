export class ReleaseNotesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseNotesError';
  }
}

export function verifyReleaseNotes(source, version) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new ReleaseNotesError('Release notes must not be empty.');
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new ReleaseNotesError('A release version is required.');
  }

  const expectedTitle = `# BYOK Grid ${version}`;
  if (!source.startsWith(`${expectedTitle}\n`)) {
    throw new ReleaseNotesError(
      `Release notes must start with ${JSON.stringify(expectedTitle)}.`
    );
  }

  const expectedMarker = `<!-- release-version: ${version} -->`;
  const versionMarkers = Array.from(
    source.matchAll(/^<!-- release-version: (\S+) -->$/gmu),
    (match) => match[1]
  );
  if (
    versionMarkers.length !== 1 ||
    versionMarkers[0] !== version ||
    !source.includes(expectedMarker)
  ) {
    throw new ReleaseNotesError(
      `Release notes must contain exactly one ${JSON.stringify(expectedMarker)} marker.`
    );
  }

  if (!source.endsWith('\n')) {
    throw new ReleaseNotesError('Release notes must end with a newline.');
  }

  for (const heading of [
    '## Release status',
    '## Highlights',
    '## Verify this release',
    '## Known limits and production gates',
    '## Licensing',
  ]) {
    if (!source.includes(`${heading}\n`)) {
      throw new ReleaseNotesError(
        `Release notes must contain the ${JSON.stringify(heading)} section.`
      );
    }
  }
}
