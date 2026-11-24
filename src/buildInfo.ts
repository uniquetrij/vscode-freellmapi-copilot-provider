import * as fs from 'fs';
import * as path from 'path';

export interface BuildInfo {
	readonly name?: string;
	readonly version: string;
	readonly buildNumber: number;
	readonly commit?: string;
	readonly builtAt?: string;
}

const DEV_BUILD_MARKER = path.join(__dirname, '..', '.dev-build');

let cached: BuildInfo | null | undefined;

export function getBuildInfo(): BuildInfo | undefined {
	if (cached === undefined) {
		cached = loadBuildInfo() ?? null;
	}
	return cached ?? undefined;
}

export function describeBuild(): string {
	if (isDevelopmentBuild()) {
		return 'Build: development build (compiled from source; run "npm run package" for a numbered build)';
	}
	const info = getBuildInfo();
	if (!info) {
		return 'Build: unstamped (no buildInfo.json; run "npm run package" for a numbered build)';
	}
	const commit = info.commit ? `, commit ${info.commit}` : '';
	const builtAt = info.builtAt ? `, built ${info.builtAt}` : '';
	return `Build #${info.buildNumber} of v${info.version}${commit}${builtAt}`;
}

/**
 * `npm run compile` and `watch` drop a marker beside `build/out` so a dev
 * session does not report the number of the last VSIX packaged from this
 * checkout. The marker is excluded from the VSIX, and `build-vsix.js` removes
 * it once packaging succeeds.
 */
function isDevelopmentBuild(): boolean {
	return fs.existsSync(DEV_BUILD_MARKER);
}

function loadBuildInfo(): BuildInfo | undefined {
	try {
		const raw = fs.readFileSync(path.join(__dirname, 'buildInfo.json'), 'utf8');
		const parsed = JSON.parse(raw) as Partial<BuildInfo>;
		if (typeof parsed.buildNumber !== 'number' || typeof parsed.version !== 'string') {
			return undefined;
		}
		return {
			name: typeof parsed.name === 'string' ? parsed.name : undefined,
			version: parsed.version,
			buildNumber: parsed.buildNumber,
			commit: typeof parsed.commit === 'string' ? parsed.commit : undefined,
			builtAt: typeof parsed.builtAt === 'string' ? parsed.builtAt : undefined,
		};
	} catch {
		return undefined;
	}
}
