import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { alphaTab } from '../src/alphaTab.vite';

type ViteLike = typeof import('vite');

async function runBundleSmokeTest(vite: ViteLike) {
    const bundlerProject = './test-data/project';

    const cwd = process.cwd();
    process.chdir(bundlerProject);

    try {
        await fs.promises.rm(path.join(process.cwd(), 'dist'), { force: true, recursive: true });
        await vite.build(
            vite.defineConfig({
                base: '/test-data/project/dist/',
                plugins: [alphaTab()]
            })
        );
    } catch (e) {
        process.chdir(cwd);
        throw e;
    } finally {
        process.chdir(cwd);
    }

    // ensure assets are copied
    const files = [
        path.join(bundlerProject, 'dist', 'font', 'Bravura.otf'),
        path.join(bundlerProject, 'dist', 'font', 'Bravura.woff'),
        path.join(bundlerProject, 'dist', 'font', 'Bravura.woff2'),
        path.join(bundlerProject, 'dist', 'font', 'Bravura-OFL.txt'),

        path.join(bundlerProject, 'dist', 'soundfont', 'LICENSE'),
        path.join(bundlerProject, 'dist', 'soundfont', 'sonivox.sf2')
    ];
    for (const file of files) {
        expect(fs.existsSync(file), `File '${file}' Missing`).toBe(true);
    }

    const dir = await fs.promises.readdir(path.join(bundlerProject, 'dist', 'assets'), { withFileTypes: true });

    let appValidated = false;
    let workletValidated = false;
    let workerValidated = false;
    let workletBytes = Number.POSITIVE_INFINITY;
    let workerBytes = Number.POSITIVE_INFINITY;

    for (const file of dir) {
        if (file.isFile()) {
            const text = await fs.promises.readFile(path.join(file.parentPath, file.name), 'utf8');

            if (file.name.startsWith('index-')) {
                // ensure new worker has worker import
                expect(text.match(/new [^ ]+\.alphaTabWorker\(new [^ ]+\.alphaTabUrl/)).toBeTruthy();
                // ensure worker bootstrapping script is references
                expect(text).toContain('assets/alphaTab.worker-');
                // ensure worklet bootstrapper script is references
                expect(text).toContain('assets/alphaTab.worklet-');
                // without custom chunking the app will bundle alphatab directly
                expect(text).toContain('.at-surface');
                // ensure __ALPHATAB_VITE__ got replaced
                expect(text).not.toContain('__ALPHATAB_VITE__');
                appValidated = true;
            } else if (file.name.startsWith('alphaTab.worker-')) {
                expect(text).toContain('alphaTab.initialize');
                expect(text).toContain('alphaSynth.initialize');
                expect(text).toContain('.at-surface');
                workerBytes = Buffer.byteLength(text);

                workerValidated = true;
            } else if (file.name.startsWith('alphaTab.worklet-')) {
                expect(text).toContain('registerProcessor');
                expect(text).toContain('alphaSynth.output.diagnostics');
                expect(text).not.toContain('.at-surface');
                workletBytes = Buffer.byteLength(text);
                workletValidated = true;
            }
        }
    }

    expect(appValidated, 'Missing app validation').toBe(true);
    expect(workerValidated, 'Missing worker validation').toBe(true);
    expect(workletValidated, 'Missing worklet validation').toBe(true);
    // Broad regression budgets: the worker is minified and the real-time
    // worklet must stay isolated from the full renderer/player bundle.
    expect(workerBytes).toBeLessThan(1_300_000);
    expect(workletBytes).toBeLessThan(20_000);
}

async function loadVite(major: 7 | 8): Promise<ViteLike> {
    const url = new URL(
        `./fixtures/vite-versions/node_modules/vite-v${major}/dist/node/index.js`,
        import.meta.url
    );
    return (await import(url.href)) as unknown as ViteLike;
}

async function runBundledDevSmokeTest(vite: ViteLike) {
    const root = path.resolve('./test-data/project');
    await fs.promises.rm(path.join(root, 'public', 'alphatab'), { force: true, recursive: true });
    const server = await vite.createServer({
        root,
        configFile: false,
        experimental: { bundledDev: true },
        plugins: [alphaTab()],
        server: {
            port: 0,
            headers: { 'Cross-Origin-Embedder-Policy': 'credentialless' }
        }
    });

    try {
        await server.listen();
        const baseUrl = server.resolvedUrls?.local[0];
        expect(baseUrl, 'Missing bundled-dev server URL').toBeTruthy();

        let entryPath: string | undefined;
        const deadline = Date.now() + 10_000;
        while (!entryPath && Date.now() < deadline) {
            const html = await fetch(baseUrl!).then(response => response.text());
            entryPath = html.match(/<script[^>]+src=["']([^"']+)["']/)?.[1];
            if (!entryPath) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        expect(entryPath, 'Missing bundled-dev entry script').toBeTruthy();

        const entry = await fetch(new URL(entryPath!, baseUrl)).then(response => response.text());
        const workerPath = entry.match(/alphatab\/alphaTab\.worker\.mjs/)?.[0];
        const workletPath = entry.match(/alphatab\/alphaTab\.worklet\.mjs/)?.[0];
        expect(workerPath, 'Missing bundled-dev worker asset URL').toBeTruthy();
        expect(workletPath, 'Missing bundled-dev worklet asset URL').toBeTruthy();

        const [workerResponse, workletResponse] = await Promise.all([
            fetch(new URL(workerPath!, baseUrl)),
            fetch(new URL(workletPath!, baseUrl))
        ]);
        expect(workerResponse.ok).toBe(true);
        expect(workerResponse.headers.get('content-type')).toContain('javascript');
        expect(workerResponse.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
        expect(await workerResponse.text()).toContain('alphaTab.initialize');
        expect(workletResponse.ok).toBe(true);
        expect(workletResponse.headers.get('content-type')).toContain('javascript');
        expect(await workletResponse.text()).toContain('registerProcessor');
        expect(fs.existsSync(path.join(root, 'public', 'alphatab'))).toBe(false);
    } finally {
        await server.close();
    }
}

// Both cases share global state (process.cwd, the dist/ folder), so they
// must run sequentially — that is what vitest does inside a single describe.
describe('Vite', () => {
    it('serves prebuilt worker runtimes in Vite 8 bundled dev', { timeout: 30000 }, async () => {
        await runBundledDevSmokeTest(await loadVite(8));
    });

    it('bundle-correctly (vite 8, rolldown)', { timeout: 30000 }, async () => {
        await runBundleSmokeTest(await loadVite(8));
    });

    it('bundle-correctly (vite 7, rollup)', { timeout: 30000 }, async () => {
        await runBundleSmokeTest(await loadVite(7));
    });
});
